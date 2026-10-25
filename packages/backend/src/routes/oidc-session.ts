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
import { internalTokenOk, mintSession, type NewSession } from '@proappstore/build-core';
import type { Env } from '../types.js';
import { HttpError, isAdminId, requireUser } from '../lib/auth.js';
import { verifyGithubOidc, type OidcClaims } from '../lib/github-oidc.js';
import { CHESS_REPOSITORY, isChessRepository } from '../lib/app-deploy-oidc.js';

export const oidcSessionRoutes = new Hono<{ Bindings: Env }>();

const ORG = 'proappstore-online';
const AUDIENCE = 'https://api.proappstore.online';
/** Hours, not days: long enough for a nightly suite, short enough that a leaked session is stale by morning. */
export const OIDC_SESSION_TTL_SECONDS = 4 * 60 * 60;
const OIDC_SESSION_VIA = 'oidc-e2e';
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
  /** #432: set for grants bound to a managed test principal; NULL for legacy #146 grants. */
  principal_id?: string | null;
  environment?: string | null;
  expires_at?: number | null;
  session_ttl_seconds?: number | null;
  scope?: string | null;
}

const GRANT_COLUMNS = 'id, repository, workflow, ref, user_id, label, created_by, created_at, revoked_at, last_minted_at, mint_count, principal_id, environment, expires_at, session_ttl_seconds, scope';
/** Principal-backed sessions default to one hour and may never exceed the legacy ceiling. */
export const PRINCIPAL_SESSION_DEFAULT_TTL_SECONDS = 60 * 60;
const PRINCIPAL_SESSION_VIA = 'oidc-test-principal';
const SLUG_RE = /^[a-z0-9][a-z0-9-]{2,39}$/;

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
export function selectGrant(grants: GrantRow[], claims: OidcClaims, now: number = Date.now()): GrantRow | null {
  const workflow = workflowPathOf(claims);
  for (const g of grants) {
    if (g.revoked_at !== null) continue;
    if (g.expires_at != null && g.expires_at <= now) continue;
    if (g.environment != null && g.environment !== claims.environment) continue;
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
  if (!isChessRepository(claims) && (claims.repository_owner !== ORG || !claims.repository?.startsWith(`${ORG}/`))) {
    return c.json({ error: `repository ${claims.repository} is not in ${ORG}` }, 403);
  }

  const rows = await c.env.DB.prepare(
    `SELECT ${GRANT_COLUMNS} FROM oidc_session_grants WHERE repository = ? AND revoked_at IS NULL`,
  ).bind(claims.repository).all<GrantRow>();
  const grant = selectGrant(rows.results ?? [], claims);
  if (!grant) {
    // One answer for "no grant", "wrong workflow" and "wrong ref": a workflow
    // probing for grants learns nothing beyond "not authorized".
    return c.json({ error: `no e2e session grant for ${claims.repository} (${workflowPathOf(claims) ?? 'unknown workflow'} @ ${claims.ref ?? 'no ref'})` }, 403);
  }

  // #432: a principal-backed grant is hardened — the principal must be active,
  // the token single-use (jti), and the session short and non-creator by default.
  let ttl = OIDC_SESSION_TTL_SECONDS;
  let via = OIDC_SESSION_VIA;
  let roles = ['user', 'creator'];
  if (grant.principal_id) {
    const principal = await c.env.DB.prepare('SELECT id, status FROM test_principals WHERE id = ?')
      .bind(grant.principal_id).first<{ id: string; status: string }>();
    if (!principal || principal.status !== 'active') return c.json({ error: 'the granted test principal is disabled' }, 403);
    const jti = typeof claims.jti === 'string' ? claims.jti : '';
    if (!jti) return c.json({ error: 'OIDC token has no jti; cannot be exchanged for a test-principal session' }, 401);
    const replay = await c.env.DB.prepare('INSERT OR IGNORE INTO oidc_session_replays (jti, grant_id, seen_at, expires_at) VALUES (?, ?, ?, ?)')
      .bind(jti, grant.id, Date.now(), (claims.exp + 3600) * 1000).run();
    if (!replay.meta?.changes) return c.json({ error: 'OIDC token already exchanged' }, 403);
    ttl = Math.min(grant.session_ttl_seconds ?? PRINCIPAL_SESSION_DEFAULT_TTL_SECONDS, OIDC_SESSION_TTL_SECONDS);
    via = PRINCIPAL_SESSION_VIA;
    roles = grant.scope === 'creator' ? ['user', 'creator'] : ['user'];
  }

  const user = await c.env.DB.prepare('SELECT id, login, avatar_url FROM users WHERE id = ?')
    .bind(grant.user_id).first<{ id: string; login: string; avatar_url: string | null }>();
  if (!user) return c.json({ error: 'the granted e2e account no longer exists' }, 403);

  // Never admin, whatever ADMIN_GITHUB_IDS says about the account.
  const session: NewSession = { uid: user.id, login: user.login, avatarUrl: user.avatar_url ?? null, roles, via };
  const sessionToken = await mintSession(session, c.env.SESSION_SIGNING_KEY, ttl);
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
    expiresAt: now + ttl * 1000,
    via,
    grant: { id: grant.id, repository: grant.repository, workflow: grant.workflow, ref: grant.ref, label: grant.label, principalId: grant.principal_id ?? null },
    user: { id: user.id, login: user.login, avatarUrl: user.avatar_url ?? null },
  });
});

// ── Grant management: platform admins only ─────────────────────────
type Ctx = Parameters<typeof requireUser>[0];

async function requireGrantAdmin(c: Ctx) {
  const user = await requireUser(c);
  const trustedMcpAdmin = internalTokenOk(c.req.header('X-Internal-Token'), c.env.INTERNAL_TOKEN)
    && isAdminId(user.id, c.env);
  if (!user.roles.includes('admin') && !trustedMcpAdmin) throw new HttpError('requires platform admin', 403);
  return user;
}

const grantView = (g: GrantRow) => ({
  id: g.id, repository: g.repository, workflow: g.workflow, ref: g.ref, user_id: g.user_id, label: g.label,
  created_by: g.created_by, created_at: g.created_at, revoked_at: g.revoked_at, last_minted_at: g.last_minted_at, mint_count: g.mint_count,
  principal_id: g.principal_id ?? null, environment: g.environment ?? null, expires_at: g.expires_at ?? null,
  session_ttl_seconds: g.session_ttl_seconds ?? null, scope: g.scope ?? null,
});

/** Correlation id for the audit trail: the caller's own, else Cloudflare's, else a fresh one. */
const requestIdOf = (c: Ctx) => (c.req.header('X-Request-Id') ?? c.req.header('CF-Ray') ?? crypto.randomUUID()).slice(0, 80);

/** Optional free-text `reason` for a mutation; 422 when present but not a bounded string. */
function reasonOf(body: { reason?: unknown } | null): string | null {
  if (body?.reason === undefined || body.reason === null) return null;
  if (typeof body.reason !== 'string' || body.reason.length > 240) throw new HttpError('reason must be a string of at most 240 characters', 422);
  return body.reason.trim() || null;
}

const optionalBody = async (c: Ctx) => (await c.req.json<Record<string, unknown>>().catch(() => null)) ?? {};

/** Append-only audit row. `detail` carries before/after metadata only — never a token or secret. */
const auditEvent = (c: Ctx, principalId: string | null, grantId: string | null, action: string, actor: string, detail: Record<string, unknown> = {}, reason: string | null = null) =>
  c.env.DB.prepare('INSERT INTO test_principal_events (principal_id, grant_id, action, actor, detail, at, request_id, reason) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .bind(principalId, grantId, action, actor, JSON.stringify(detail), Date.now(), requestIdOf(c), reason);

// ── Pagination: `?limit=` (1..100, default 50) and an opaque `?cursor=` over (time DESC, id DESC) ──
const PAGE_DEFAULT = 50;
const PAGE_MAX = 100;

function pageParams(c: Ctx): { limit: number; cursor: { t: number; id: string } | null } {
  const rawLimit = c.req.query('limit');
  let limit = PAGE_DEFAULT;
  if (rawLimit !== undefined) {
    limit = Number(rawLimit);
    if (!Number.isInteger(limit) || limit < 1 || limit > PAGE_MAX) throw new HttpError(`limit must be 1..${PAGE_MAX}`, 422);
  }
  const raw = c.req.query('cursor');
  if (raw === undefined) return { limit, cursor: null };
  try {
    const [t, ...rest] = atob(raw.replace(/-/g, '+').replace(/_/g, '/')).split('|');
    const id = rest.join('|');
    if (!/^\d+$/.test(t ?? '') || !id) throw new Error('bad');
    return { limit, cursor: { t: Number(t), id } };
  } catch {
    throw new HttpError('cursor is not valid', 422);
  }
}

const cursorOf = (t: number, id: string | number) => btoa(`${t}|${id}`).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

/** Trim the limit+1 probe row and build the next cursor. */
function paged<T>(rows: T[], limit: number, key: (r: T) => [number, string | number]): { items: T[]; next_cursor: string | null } {
  const items = rows.slice(0, limit);
  const last = items[items.length - 1];
  return { items, next_cursor: rows.length > limit && last ? cursorOf(...key(last)) : null };
}

oidcSessionRoutes.get('/admin/oidc-session-grants', async (c) => {
  await requireGrantAdmin(c);
  const { limit, cursor } = pageParams(c);
  const principalId = c.req.query('principal_id');
  const where: string[] = [];
  const binds: unknown[] = [];
  if (principalId) { where.push('principal_id = ?'); binds.push(principalId); }
  if (cursor) { where.push('(created_at < ? OR (created_at = ? AND id < ?))'); binds.push(cursor.t, cursor.t, cursor.id); }
  const rows = await c.env.DB.prepare(
    `SELECT ${GRANT_COLUMNS} FROM oidc_session_grants${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY created_at DESC, id DESC LIMIT ?`,
  ).bind(...binds, limit + 1).all<GrantRow>();
  const { items, next_cursor } = paged(rows.results ?? [], limit, (g) => [g.created_at, g.id]);
  c.header('Cache-Control', 'private, no-store');
  return c.json({ grants: items.map(grantView), next_cursor });
});

oidcSessionRoutes.get('/admin/oidc-session-grants/:id', async (c) => {
  await requireGrantAdmin(c);
  const row = await c.env.DB.prepare(`SELECT ${GRANT_COLUMNS} FROM oidc_session_grants WHERE id = ?`).bind(c.req.param('id')!).first<GrantRow>();
  if (!row) throw new HttpError('grant not found', 404);
  c.header('Cache-Control', 'private, no-store');
  return c.json({ grant: grantView(row) });
});

oidcSessionRoutes.post('/admin/oidc-session-grants', async (c) => {
  const admin = await requireGrantAdmin(c);
  const body = await c.req.json<{ repository?: unknown; user_id?: unknown; principal_id?: unknown; workflow?: unknown; ref?: unknown; label?: unknown; environment?: unknown; expires_at?: unknown; session_ttl_seconds?: unknown; scope?: unknown; reason?: unknown }>().catch(() => null);
  if (!body || typeof body !== 'object') throw new HttpError('JSON body required', 400);
  const isPrincipalGrant = body.principal_id !== undefined && body.principal_id !== null;
  // Legacy (#146) grants keep their historic 400; the managed-principal model reports validation as 422.
  const invalid = isPrincipalGrant ? 422 : 400;
  if (typeof body.repository !== 'string' || (!REPO_RE.test(body.repository) && body.repository !== CHESS_REPOSITORY)) throw new HttpError(`repository must be ${ORG}/<repo> or ${CHESS_REPOSITORY}`, invalid);
  const workflow = body.workflow === undefined || body.workflow === null ? null : String(body.workflow);
  if (workflow !== null && !WORKFLOW_RE.test(workflow)) throw new HttpError('workflow must be a .github/workflows/<file>.yml path', invalid);
  const ref = body.ref === undefined || body.ref === null ? 'refs/heads/main' : String(body.ref);
  if (!REF_RE.test(ref)) throw new HttpError('ref must be a full git ref, e.g. refs/heads/main', invalid);
  const label = body.label === undefined || body.label === null ? null : String(body.label).slice(0, 120);
  const reason = reasonOf(body);

  let userId: string;
  let principalId: string | null = null;
  let environment: string | null = null;
  let expiresAt: number | null = null;
  let ttlSeconds: number | null = null;
  let scope: string | null = null;
  if (isPrincipalGrant) {
    // #432 least-privilege grant: workflow and an expiry are mandatory.
    if (typeof body.principal_id !== 'string') throw new HttpError('principal_id must be a string', 422);
    if (workflow === null) throw new HttpError('a test-principal grant must name a workflow', 422);
    if (typeof body.expires_at !== 'number' || !Number.isFinite(body.expires_at) || body.expires_at <= Date.now()) throw new HttpError('expires_at (epoch ms, in the future) is required', 422);
    if (body.environment !== undefined && body.environment !== null) {
      if (typeof body.environment !== 'string' || !/^[A-Za-z0-9._-]{1,60}$/.test(body.environment)) throw new HttpError('environment must be a GitHub environment name', 422);
      environment = body.environment;
    }
    if (body.session_ttl_seconds !== undefined && body.session_ttl_seconds !== null) {
      if (typeof body.session_ttl_seconds !== 'number' || !Number.isInteger(body.session_ttl_seconds) || body.session_ttl_seconds < 60 || body.session_ttl_seconds > OIDC_SESSION_TTL_SECONDS) throw new HttpError(`session_ttl_seconds must be 60..${OIDC_SESSION_TTL_SECONDS}`, 422);
      ttlSeconds = body.session_ttl_seconds;
    }
    if (body.scope !== undefined && body.scope !== null && body.scope !== 'user' && body.scope !== 'creator') throw new HttpError("scope must be 'user' or 'creator'", 422);
    scope = (body.scope as string | undefined) ?? 'user';
    expiresAt = body.expires_at;
    const principal = await c.env.DB.prepare('SELECT id, user_id, status FROM test_principals WHERE id = ?')
      .bind(body.principal_id).first<{ id: string; user_id: string; status: string }>();
    if (!principal) throw new HttpError('test principal not found', 404);
    if (principal.status !== 'active') throw new HttpError('test principal is disabled', 409);
    userId = principal.user_id;
    principalId = principal.id;
  } else {
    if (typeof body.user_id !== 'string' || !/^(?:gh|google):\d+$/.test(body.user_id)) throw new HttpError('user_id must be a gh:<id> or google:<id> account', 400);
    const user = await c.env.DB.prepare('SELECT id FROM users WHERE id = ?').bind(body.user_id).first<{ id: string }>();
    if (!user) throw new HttpError('user not found — the e2e account must have signed in once', 404);
    userId = body.user_id;
  }

  const grant: GrantRow = {
    id: crypto.randomUUID(), repository: body.repository, workflow, ref, user_id: userId, label,
    created_by: admin.id, created_at: Date.now(), revoked_at: null, last_minted_at: null, mint_count: 0,
    principal_id: principalId, environment, expires_at: expiresAt, session_ttl_seconds: ttlSeconds, scope,
  };
  await c.env.DB.batch([
    c.env.DB.prepare(
      'INSERT INTO oidc_session_grants (id, repository, workflow, ref, user_id, label, created_by, created_at, principal_id, environment, expires_at, session_ttl_seconds, scope) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    ).bind(grant.id, grant.repository, grant.workflow, grant.ref, grant.user_id, grant.label, grant.created_by, grant.created_at, principalId, environment, expiresAt, ttlSeconds, scope),
    auditEvent(c, principalId, grant.id, 'grant.create', admin.id, { after: { repository: grant.repository, workflow, ref, environment, expiresAt, ttlSeconds, scope } }, reason),
  ]);
  return c.json({ grant: grantView(grant) }, 201);
});

// Revoke is durable and one-way: the row stays, `revoked_at` is set, the audit trail records who and why.
oidcSessionRoutes.delete('/admin/oidc-session-grants/:id', async (c) => {
  const admin = await requireGrantAdmin(c);
  const id = c.req.param('id')!;
  const reason = reasonOf(await optionalBody(c));
  const existing = await c.env.DB.prepare('SELECT principal_id FROM oidc_session_grants WHERE id = ? AND revoked_at IS NULL').bind(id).first<{ principal_id: string | null }>();
  const result = await c.env.DB.prepare('UPDATE oidc_session_grants SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL')
    .bind(Date.now(), id).run();
  if (!existing || !result.meta?.changes) throw new HttpError('grant not found', 404);
  await auditEvent(c, existing.principal_id ?? null, id, 'grant.revoke', admin.id, { before: { revoked: false }, after: { revoked: true } }, reason).run();
  return c.json({ ok: true });
});

// ── Test principals (#432, #434) ───────────────────────────────────
interface PrincipalRow { id: string; slug: string; user_id: string; description: string | null; status: string; created_by: string; created_at: number; disabled_at: number | null; updated_at?: number | null }

const PRINCIPAL_COLUMNS = 'id, slug, user_id, description, status, created_by, created_at, disabled_at, updated_at';
const principalView = (p: PrincipalRow) => ({ ...p, updated_at: p.updated_at ?? null });
const PRINCIPAL_STATUSES = ['active', 'disabled'];

oidcSessionRoutes.get('/admin/test-principals', async (c) => {
  await requireGrantAdmin(c);
  const { limit, cursor } = pageParams(c);
  const status = c.req.query('status');
  if (status !== undefined && !PRINCIPAL_STATUSES.includes(status)) throw new HttpError("status must be 'active' or 'disabled'", 422);
  const where: string[] = [];
  const binds: unknown[] = [];
  if (status) { where.push('status = ?'); binds.push(status); }
  if (cursor) { where.push('(created_at < ? OR (created_at = ? AND id < ?))'); binds.push(cursor.t, cursor.t, cursor.id); }
  const rows = await c.env.DB.prepare(
    `SELECT ${PRINCIPAL_COLUMNS} FROM test_principals${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY created_at DESC, id DESC LIMIT ?`,
  ).bind(...binds, limit + 1).all<PrincipalRow>();
  const { items, next_cursor } = paged(rows.results ?? [], limit, (p) => [p.created_at, p.id]);
  c.header('Cache-Control', 'private, no-store');
  return c.json({ principals: items.map(principalView), next_cursor });
});

oidcSessionRoutes.get('/admin/test-principals/:id', async (c) => {
  await requireGrantAdmin(c);
  const id = c.req.param('id')!;
  const principal = await c.env.DB.prepare(`SELECT ${PRINCIPAL_COLUMNS} FROM test_principals WHERE id = ?`).bind(id).first<PrincipalRow>();
  if (!principal) throw new HttpError('test principal not found', 404);
  // Scoped by principal_id: a principal's page only ever shows its own grants.
  const grants = await c.env.DB.prepare(`SELECT ${GRANT_COLUMNS} FROM oidc_session_grants WHERE principal_id = ? ORDER BY created_at DESC, id DESC LIMIT ${PAGE_MAX}`)
    .bind(id).all<GrantRow>();
  c.header('Cache-Control', 'private, no-store');
  return c.json({ principal: principalView(principal), grants: (grants.results ?? []).map(grantView) });
});

oidcSessionRoutes.post('/admin/test-principals', async (c) => {
  const admin = await requireGrantAdmin(c);
  const body = await c.req.json<{ slug?: unknown; description?: unknown; reason?: unknown }>().catch(() => null);
  if (!body || typeof body.slug !== 'string' || !SLUG_RE.test(body.slug)) throw new HttpError('slug must match [a-z0-9-]{3,40}', 422);
  if (body.description !== undefined && body.description !== null && (typeof body.description !== 'string' || body.description.length > 240)) throw new HttpError('description must be a string of at most 240 characters', 422);
  const reason = reasonOf(body);
  const description = typeof body.description === 'string' ? body.description : null;
  const principal: PrincipalRow = {
    id: `tp_${crypto.randomUUID()}`, slug: body.slug, user_id: `test:${body.slug}`, description, status: 'active',
    created_by: admin.id, created_at: Date.now(), disabled_at: null, updated_at: null,
  };
  const existing = await c.env.DB.prepare('SELECT id FROM test_principals WHERE slug = ?').bind(body.slug).first();
  if (existing) throw new HttpError('a test principal with that slug already exists', 409);
  await c.env.DB.batch([
    c.env.DB.prepare('INSERT INTO users (id, provider, provider_id, login, email, avatar_url, created_at, last_login_at) VALUES (?, ?, ?, ?, NULL, NULL, ?, ?)')
      .bind(principal.user_id, 'test', body.slug, `test-${body.slug}`, principal.created_at, principal.created_at),
    c.env.DB.prepare('INSERT INTO test_principals (id, slug, user_id, description, status, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .bind(principal.id, principal.slug, principal.user_id, description, 'active', admin.id, principal.created_at),
    auditEvent(c, principal.id, null, 'principal.create', admin.id, { after: { slug: body.slug, description, status: 'active' } }, reason),
  ]);
  return c.json({ principal: principalView(principal) }, 201);
});

// Bounded metadata only: `description`. Identity (slug, user id) and status are never editable here.
oidcSessionRoutes.patch('/admin/test-principals/:id', async (c) => {
  const admin = await requireGrantAdmin(c);
  const id = c.req.param('id')!;
  const body = await c.req.json<Record<string, unknown>>().catch(() => null);
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new HttpError('JSON body required', 400);
  const unknown = Object.keys(body).filter((k) => k !== 'description' && k !== 'reason');
  if (unknown.length) throw new HttpError(`field not editable: ${unknown.join(', ')}`, 422);
  if (!('description' in body)) throw new HttpError('nothing to update: description is required', 422);
  if (body.description !== null && (typeof body.description !== 'string' || body.description.length > 240)) throw new HttpError('description must be a string of at most 240 characters or null', 422);
  const reason = reasonOf(body);
  const before = await c.env.DB.prepare(`SELECT ${PRINCIPAL_COLUMNS} FROM test_principals WHERE id = ?`).bind(id).first<PrincipalRow>();
  if (!before) throw new HttpError('test principal not found', 404);
  const description = body.description as string | null;
  const now = Date.now();
  await c.env.DB.batch([
    c.env.DB.prepare('UPDATE test_principals SET description = ?, updated_at = ? WHERE id = ?').bind(description, now, id),
    auditEvent(c, id, null, 'principal.update', admin.id, { before: { description: before.description }, after: { description } }, reason),
  ]);
  return c.json({ principal: principalView({ ...before, description, updated_at: now }) });
});

// Deactivate: disabling revokes every live grant bound to the principal in the same batch.
oidcSessionRoutes.post('/admin/test-principals/:id/disable', async (c) => {
  const admin = await requireGrantAdmin(c);
  const id = c.req.param('id')!;
  const reason = reasonOf(await optionalBody(c));
  const now = Date.now();
  const live = await c.env.DB.prepare('SELECT id FROM oidc_session_grants WHERE principal_id = ? AND revoked_at IS NULL').bind(id).all<{ id: string }>();
  const result = await c.env.DB.prepare("UPDATE test_principals SET status = 'disabled', disabled_at = ? WHERE id = ? AND status = 'active'").bind(now, id).run();
  if (!result.meta?.changes) throw new HttpError('active test principal not found', 404);
  const revokedGrants = (live.results ?? []).map((g) => g.id);
  await c.env.DB.batch([
    c.env.DB.prepare('UPDATE oidc_session_grants SET revoked_at = ? WHERE principal_id = ? AND revoked_at IS NULL').bind(now, id),
    auditEvent(c, id, null, 'principal.disable', admin.id, { before: { status: 'active' }, after: { status: 'disabled' }, revokedGrants }, reason),
  ]);
  return c.json({ ok: true, revoked_grants: revokedGrants.length });
});

// Re-enabling restores the principal only; revoked grants stay revoked (no automatic privilege expansion).
oidcSessionRoutes.post('/admin/test-principals/:id/enable', async (c) => {
  const admin = await requireGrantAdmin(c);
  const id = c.req.param('id')!;
  const reason = reasonOf(await optionalBody(c));
  const result = await c.env.DB.prepare("UPDATE test_principals SET status = 'active', disabled_at = NULL WHERE id = ? AND status = 'disabled'").bind(id).run();
  if (!result.meta?.changes) throw new HttpError('disabled test principal not found', 404);
  await auditEvent(c, id, null, 'principal.enable', admin.id, { before: { status: 'disabled' }, after: { status: 'active' } }, reason).run();
  return c.json({ ok: true });
});

oidcSessionRoutes.get('/admin/test-principal-events', async (c) => {
  await requireGrantAdmin(c);
  const { limit, cursor } = pageParams(c);
  const where: string[] = [];
  const binds: unknown[] = [];
  for (const [param, col] of [['principal_id', 'principal_id'], ['grant_id', 'grant_id']] as const) {
    const v = c.req.query(param);
    if (v) { where.push(`${col} = ?`); binds.push(v); }
  }
  if (cursor) {
    if (!/^\d+$/.test(cursor.id)) throw new HttpError('cursor is not valid', 422);
    where.push('(at < ? OR (at = ? AND id < ?))'); binds.push(cursor.t, cursor.t, Number(cursor.id));
  }
  const rows = await c.env.DB.prepare(
    `SELECT id, principal_id, grant_id, action, actor, detail, at, request_id, reason FROM test_principal_events${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY at DESC, id DESC LIMIT ?`,
  ).bind(...binds, limit + 1).all<{ id: number; at: number }>();
  const { items, next_cursor } = paged(rows.results ?? [], limit, (e) => [e.at, e.id]);
  c.header('Cache-Control', 'private, no-store');
  return c.json({ events: items, next_cursor });
});
