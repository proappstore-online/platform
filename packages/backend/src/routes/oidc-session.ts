/**
 * Keyless e2e sessions (#146): a GitHub Actions workflow presents its OIDC
 * token and receives a short-lived platform session for a designated e2e
 * account — no stored PAT, no device-flow token. Authority is an explicit
 * grant a platform admin creates: repository (+ optional workflow, ref) → user.
 * Verification is the same as the keyless deploy paths (RS256 against GitHub's
 * JWKS, issuer, audience, expiry); on top of it the grant must match, the ref
 * must match, and the account must exist. Sessions carry `via: 'oidc-e2e'`,
 * last hours not days, and never hold the admin role.
 */
import { Hono } from 'hono';
import { mintSession, type NewSession } from '@proappstore/build-core';
import type { Env } from '../types.js';
import { HttpError, requireUser } from '../lib/auth.js';
import { verifyGithubOidc, type OidcClaims } from '../lib/github-oidc.js';

export const oidcSessionRoutes = new Hono<{ Bindings: Env }>();

const ORG = 'proappstore-online';
const AUDIENCE = 'https://api.proappstore.online';
/** Hours, not days: long enough for a nightly suite, short enough that a leaked session is stale by morning. */
export const OIDC_SESSION_TTL_SECONDS = 4 * 60 * 60;
export const OIDC_SESSION_VIA = 'oidc-e2e';
const REPO_RE = /^proappstore-online\/[A-Za-z0-9._-]+$/;
const WORKFLOW_RE = /^\.github\/workflows\/[A-Za-z0-9._-]+\.ya?ml$/;
const REF_RE = /^refs\/(heads|tags)\/[A-Za-z0-9._\/-]+$/;

interface GrantRow {
  id: string;
  repository: string;
  workflow: string | null;
  ref: string;
  user_id: string;
  label: string | null;
  created_by: string;
  created_at: number;
  revoked_at: number | null;
  last_minted_at: number | null;
  mint_count: number;
}

/** The workflow file path the token was minted by: `owner/repo/.github/workflows/x.yml@ref` → `.github/workflows/x.yml`. */
export function workflowPathOf(claims: OidcClaims): string | null {
  const ref = typeof claims.workflow_ref === 'string' ? claims.workflow_ref : null;
  if (!ref) return null;
  const at = ref.indexOf('@');
  const path = (at >= 0 ? ref.slice(0, at) : ref);
  const prefix = `${claims.repository}/`;
  return path.startsWith(prefix) ? path.slice(prefix.length) : path;
}

/** The grant this token may use, or null. Revoked grants are never candidates. */
export function selectGrant(grants: GrantRow[], claims: OidcClaims): GrantRow | null {
  const workflow = workflowPathOf(claims);
  for (const g of grants) {
    if (g.revoked_at !== null) continue;
    if (g.repository !== claims.repository) continue;
    if (g.ref !== claims.ref) continue;
    if (g.workflow !== null && g.workflow !== workflow) continue;
    return g;
  }
  return null;
}

// ── POST /v1/auth/exchange/oidc ───────────────────────────────────
// Bearer: the GitHub Actions OIDC token (audience https://api.proappstore.online).
oidcSessionRoutes.post('/auth/exchange/oidc', async (c) => {
  const auth = c.req.header('Authorization') || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
  if (!token) return c.json({ error: 'missing OIDC token' }, 401);

  let claims: OidcClaims;
  try {
    claims = await verifyGithubOidc(token, { audience: AUDIENCE });
  } catch (e) {
    return c.json({ error: `OIDC verification failed: ${(e as Error).message}` }, 401);
  }
  if (claims.repository_owner !== ORG || !claims.repository?.startsWith(`${ORG}/`)) {
    return c.json({ error: `repository ${claims.repository} is not in ${ORG}` }, 403);
  }

  const rows = await c.env.DB.prepare(
    'SELECT id, repository, workflow, ref, user_id, label, created_by, created_at, revoked_at, last_minted_at, mint_count FROM oidc_session_grants WHERE repository = ? AND revoked_at IS NULL',
  ).bind(claims.repository).all<GrantRow>();
  const grant = selectGrant(rows.results ?? [], claims);
  if (!grant) {
    // One answer for "no grant", "wrong workflow" and "wrong ref": a workflow
    // probing for grants learns nothing beyond "not authorized".
    return c.json({ error: `no e2e session grant for ${claims.repository} (${workflowPathOf(claims) ?? 'unknown workflow'} @ ${claims.ref ?? 'no ref'})` }, 403);
  }

  const user = await c.env.DB.prepare('SELECT id, login, avatar_url FROM users WHERE id = ?')
    .bind(grant.user_id).first<{ id: string; login: string; avatar_url: string | null }>();
  if (!user) return c.json({ error: 'the granted e2e account no longer exists' }, 403);

  // A creator session — enough to drive an app as its owner in e2e — never admin,
  // whatever ADMIN_GITHUB_IDS says about the account.
  const session: NewSession = { uid: user.id, login: user.login, avatarUrl: user.avatar_url ?? null, roles: ['user', 'creator'], via: OIDC_SESSION_VIA };
  const sessionToken = await mintSession(session, c.env.SESSION_SIGNING_KEY, OIDC_SESSION_TTL_SECONDS);
  const now = Date.now();
  const runId = typeof claims.run_id === 'string' || typeof claims.run_id === 'number' ? String(claims.run_id) : null;
  try {
    await c.env.DB.batch([
      c.env.DB.prepare('INSERT INTO oidc_session_mints (grant_id, repository, workflow, ref, sha, run_id, user_id, minted_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .bind(grant.id, claims.repository, workflowPathOf(claims), claims.ref ?? null, claims.sha ?? null, runId, user.id, now),
      c.env.DB.prepare('UPDATE oidc_session_grants SET last_minted_at = ?, mint_count = mint_count + 1 WHERE id = ?').bind(now, grant.id),
    ]);
  } catch (e) {
    console.error(`oidc_session_mints insert failed for ${claims.repository}: ${(e as Error).message}`);
  }

  return c.json({
    sessionToken,
    expiresAt: now + OIDC_SESSION_TTL_SECONDS * 1000,
    via: OIDC_SESSION_VIA,
    grant: { id: grant.id, repository: grant.repository, workflow: grant.workflow, ref: grant.ref, label: grant.label },
    user: { id: user.id, login: user.login, avatarUrl: user.avatar_url ?? null },
  });
});

// ── Grant management: platform admins only ─────────────────────────
async function requireAdmin(c: Parameters<typeof requireUser>[0]) {
  const user = await requireUser(c);
  if (!user.roles.includes('admin')) throw new HttpError('requires platform admin', 403);
  return user;
}

const grantView = (g: GrantRow) => ({
  id: g.id, repository: g.repository, workflow: g.workflow, ref: g.ref, user_id: g.user_id, label: g.label,
  created_by: g.created_by, created_at: g.created_at, revoked_at: g.revoked_at, last_minted_at: g.last_minted_at, mint_count: g.mint_count,
});

oidcSessionRoutes.get('/admin/oidc-session-grants', async (c) => {
  await requireAdmin(c);
  const rows = await c.env.DB.prepare(
    'SELECT id, repository, workflow, ref, user_id, label, created_by, created_at, revoked_at, last_minted_at, mint_count FROM oidc_session_grants ORDER BY created_at DESC LIMIT 500',
  ).all<GrantRow>();
  c.header('Cache-Control', 'private, no-store');
  return c.json({ grants: (rows.results ?? []).map(grantView) });
});

oidcSessionRoutes.post('/admin/oidc-session-grants', async (c) => {
  const admin = await requireAdmin(c);
  const body = await c.req.json<{ repository?: unknown; user_id?: unknown; workflow?: unknown; ref?: unknown; label?: unknown }>().catch(() => null);
  if (!body || typeof body !== 'object') throw new HttpError('JSON body required', 400);
  if (typeof body.repository !== 'string' || !REPO_RE.test(body.repository)) throw new HttpError(`repository must be ${ORG}/<repo>`, 400);
  if (typeof body.user_id !== 'string' || !/^gh:\d+$/.test(body.user_id)) throw new HttpError('user_id must be a gh:<id> account', 400);
  const workflow = body.workflow === undefined || body.workflow === null ? null : String(body.workflow);
  if (workflow !== null && !WORKFLOW_RE.test(workflow)) throw new HttpError('workflow must be a .github/workflows/<file>.yml path', 400);
  const ref = body.ref === undefined || body.ref === null ? 'refs/heads/main' : String(body.ref);
  if (!REF_RE.test(ref)) throw new HttpError('ref must be a full git ref, e.g. refs/heads/main', 400);
  const label = body.label === undefined || body.label === null ? null : String(body.label).slice(0, 120);

  const user = await c.env.DB.prepare('SELECT id FROM users WHERE id = ?').bind(body.user_id).first<{ id: string }>();
  if (!user) throw new HttpError('user not found — the e2e account must have signed in once', 404);

  const grant: GrantRow = {
    id: crypto.randomUUID(), repository: body.repository, workflow, ref, user_id: body.user_id, label,
    created_by: admin.id, created_at: Date.now(), revoked_at: null, last_minted_at: null, mint_count: 0,
  };
  await c.env.DB.prepare(
    'INSERT INTO oidc_session_grants (id, repository, workflow, ref, user_id, label, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
  ).bind(grant.id, grant.repository, grant.workflow, grant.ref, grant.user_id, grant.label, grant.created_by, grant.created_at).run();
  return c.json({ grant: grantView(grant) }, 201);
});

oidcSessionRoutes.delete('/admin/oidc-session-grants/:id', async (c) => {
  await requireAdmin(c);
  const result = await c.env.DB.prepare('UPDATE oidc_session_grants SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL')
    .bind(Date.now(), c.req.param('id')!).run();
  if (!result.meta?.changes) throw new HttpError('grant not found', 404);
  return c.json({ ok: true });
});
