import { Hono } from 'hono';
import { internalTokenOk } from '@proappstore/build-core';
import type { Env } from '../types.js';
import { verifyGithubOidc } from '../lib/github-oidc.js';
import { replaceAppTools } from './tools.js';

/**
 * Keyless deploy credentials.
 *
 * An app repo's GitHub Actions runner authenticates with a GitHub OIDC token
 * (no stored secret) and gets back short-lived R2 credentials scoped to ONLY
 * that app's object prefix. This replaces standing per-repo/org R2 secrets:
 *   - no secret lives in any repo (works on a Free org with private repos),
 *   - one app can never touch another's objects (prefix-scoped),
 *   - credentials expire in minutes; rotation/audit is centralized here.
 *
 * The app id, and therefore the R2 prefix, is derived from the VERIFIED
 * `repository` claim — a repo can only ever mint credentials for its own app.
 */

const ORG = 'proappstore-online';
const BUCKET = 'pas-apps';
/** Audience the deploy workflow must request its OIDC token for. */
const AUDIENCE = 'https://api.proappstore.online';
/** Only the main branch may deploy — matches the workflow's `push: [main]`
 *  trigger. Pinning the ref stops any other branch/workflow in the repo from
 *  minting deploy credentials. */
const DEPLOY_REF = 'refs/heads/main';
const TTL_SECONDS = 900; // 15 min — long enough for a build+sync, short-lived.

export const deployRoutes = new Hono<{ Bindings: Env }>();

deployRoutes.post('/apps/:appId/deploy-credentials', async (c) => {
  const appId = c.req.param('appId');
  if (!/^[a-z][a-z0-9-]*$/.test(appId) || appId.length > 58) {
    return c.json({ error: 'invalid app id' }, 400);
  }

  // 1. GitHub OIDC token from Authorization: Bearer <jwt>
  const auth = c.req.header('Authorization') || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
  if (!token) return c.json({ error: 'missing OIDC token' }, 401);

  // 2. Verify it's a genuine GitHub Actions token for our audience
  let claims;
  try {
    claims = await verifyGithubOidc(token, { audience: AUDIENCE });
  } catch (e) {
    return c.json({ error: `OIDC verification failed: ${(e as Error).message}` }, 401);
  }

  // 3. Authorize: the deploying repo must be this org's repo named exactly the
  //    app id. Since the prefix below is derived from appId and appId must equal
  //    the verified repo name, a repo can only ever mint creds for its own prefix.
  const expected = `${ORG}/${appId}`;
  if (claims.repository !== expected) {
    return c.json({ error: `repository ${claims.repository} is not authorized for app ${appId}` }, 403);
  }
  if (claims.ref !== DEPLOY_REF) {
    return c.json({ error: `ref ${claims.ref ?? '(none)'} not authorized — deploys must run from ${DEPLOY_REF}` }, 403);
  }

  // 4. Mint short-lived, prefix-scoped R2 credentials via the R2 API.
  const parentKey = c.env.R2_PARENT_ACCESS_KEY_ID;
  if (!parentKey || !c.env.CF_API_TOKEN || !c.env.CF_ACCOUNT_ID) {
    return c.json({ error: 'deploy credential minting not configured' }, 503);
  }
  const prefix = `apps/${appId}/`;

  let result: { accessKeyId: string; secretAccessKey: string; sessionToken: string } | undefined;
  try {
    const res = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${c.env.CF_ACCOUNT_ID}/r2/temp-access-credentials`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${c.env.CF_API_TOKEN}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          bucket: BUCKET,
          parentAccessKeyId: parentKey,
          permission: 'object-read-write',
          ttlSeconds: TTL_SECONDS,
          prefixes: [prefix],
        }),
      },
    );
    const data = (await res.json()) as {
      success: boolean;
      result?: { accessKeyId: string; secretAccessKey: string; sessionToken: string };
      errors?: unknown;
    };
    if (!res.ok || !data.success || !data.result) {
      return c.json({ error: 'failed to mint R2 credentials', detail: data.errors ?? `status ${res.status}` }, 502);
    }
    result = data.result;
  } catch (e) {
    return c.json({ error: `R2 credential request failed: ${(e as Error).message}` }, 502);
  }

  // Audit the mint (best-effort — an audit failure must never block a deploy).
  try {
    await c.env.DB.prepare(
      `INSERT INTO deploy_audit (app_id, repository, ref, sha, prefix, minted_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
      .bind(appId, claims.repository, claims.ref ?? '', claims.sha ?? null, prefix, Date.now())
      .run();
  } catch (e) {
    console.error(`deploy_audit insert failed for ${appId}: ${(e as Error).message}`);
  }

  return c.json({
    accessKeyId: result.accessKeyId,
    secretAccessKey: result.secretAccessKey,
    sessionToken: result.sessionToken,
    bucket: BUCKET,
    prefix,
    endpoint: `https://${c.env.CF_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    expiresInSeconds: TTL_SECONDS,
    repository: claims.repository,
    sha: claims.sha ?? null,
  });
});

/**
 * Keyless tools registration: the deploy workflow ships the repo's mcp.json
 * here so registered actions never drift from the committed manifest. Same
 * trust model as deploy-credentials — the VERIFIED `repository` claim must be
 * this org's repo named exactly the app id, deploying from main.
 */
deployRoutes.put('/apps/:appId/tools/oidc', async (c) => {
  const appId = c.req.param('appId');
  if (!/^[a-z][a-z0-9-]*$/.test(appId) || appId.length > 58) {
    return c.json({ error: 'invalid app id' }, 400);
  }

  const auth = c.req.header('Authorization') || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
  if (!token) return c.json({ error: 'missing OIDC token' }, 401);

  let claims;
  try {
    claims = await verifyGithubOidc(token, { audience: AUDIENCE });
  } catch (e) {
    return c.json({ error: `OIDC verification failed: ${(e as Error).message}` }, 401);
  }

  if (claims.repository !== `${ORG}/${appId}`) {
    return c.json({ error: `repository ${claims.repository} is not authorized for app ${appId}` }, 403);
  }
  if (claims.ref !== DEPLOY_REF) {
    return c.json({ error: `ref ${claims.ref ?? '(none)'} not authorized — deploys must run from ${DEPLOY_REF}` }, 403);
  }

  const body = await c.req.json<{ tools?: unknown }>().catch(() => null);
  const { status, payload } = await replaceAppTools(c.env.DB, appId, body?.tools ?? []);
  return c.json(payload, status as 200 | 400);
});

/**
 * Deploy-time D1 migrations (Phase 1 of #32). The deploy workflow POSTs the repo's
 * migrations here BEFORE it registers mcp.json actions, so schema is current before
 * any action SQL that references it goes live — closing the "owner must open the app
 * to migrate" skew that 500'd users (chess-academy 2026-07-11). Same trust model as
 * deploy-credentials/tools/oidc: the VERIFIED repo claim must be this org's repo named
 * exactly the app id, from main.
 *
 * The automated path is restricted to ADDITIVE DDL (CREATE / ALTER … ADD / INSERT) —
 * a compromised repo can't DROP/RENAME its way through history via CI. Destructive
 * changes stay on the in-browser OWNER path (`app.db.migrate`), which is a human.
 */
const MIGRATE_ALLOWED_START = /^(CREATE\s+(TABLE|(UNIQUE\s+)?INDEX|VIEW|TRIGGER)\b|ALTER\s+TABLE\b|INSERT\s+INTO\b)/i;
const MIGRATE_FORBIDDEN = /\b(DROP|DELETE|UPDATE|RENAME|PRAGMA|ATTACH|DETACH|VACUUM|REINDEX|REPLACE)\b/i;

/** Returns the first statement that is not additive-only DDL, or null if all pass. */
function forbiddenMigrationStatement(sql: string): string | null {
  const statements = sql.split(';').map((s) => s.trim()).filter((s) => s.length > 0);
  for (const stmt of statements) {
    if (MIGRATE_FORBIDDEN.test(stmt) || !MIGRATE_ALLOWED_START.test(stmt)) return stmt.slice(0, 80);
  }
  return null;
}

/**
 * Validate the migrations are additive-only and forward them to the app's data
 * worker. Shared by the OIDC path (CLI/self-service deploys) and the internal
 * path (Agent Teams deploy stage) so the additive-only guarantee lives in ONE
 * place. Returns an HTTP status + JSON body for the caller to hand back.
 */
async function applyMigrations(
  env: Env,
  appId: string,
  migrations: unknown,
): Promise<{ status: 200 | 400 | 422 | 502; body: Record<string, unknown> }> {
  if (!Array.isArray(migrations)) {
    return { status: 400, body: { error: 'migrations must be an array of {name, sql}' } };
  }
  if (migrations.length === 0) return { status: 200, body: { ok: true, applied: [], note: 'no migrations' } };

  for (const m of migrations as { name?: unknown; sql?: unknown }[]) {
    if (typeof m?.name !== 'string' || typeof m?.sql !== 'string') {
      return { status: 400, body: { error: 'each migration must be {name, sql}' } };
    }
    const bad = forbiddenMigrationStatement(m.sql);
    if (bad) {
      return {
        status: 422,
        body: {
          error: `migration "${m.name}" has a non-additive statement — the deploy path allows CREATE / ALTER … ADD / INSERT only. Run destructive changes as the app owner in-browser: ${bad}`,
        },
      };
    }
  }

  // Forward to the app's data worker over its custom domain (reachable by subrequest)
  // with the platform internal token — the same trusted path the actions executor uses.
  // The data worker's _migrations table makes this idempotent.
  let res: Response;
  try {
    res = await fetch(`https://data-${appId}.proappstore.online/migrate`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(env.INTERNAL_TOKEN ? { 'X-Internal-Token': env.INTERNAL_TOKEN } : {}),
      },
      body: JSON.stringify({ migrations }),
    });
  } catch (e) {
    return { status: 502, body: { error: `migrate forward failed: ${(e as Error).message}` } };
  }
  const raw = await res.text();
  let data: unknown = raw;
  try { data = raw ? JSON.parse(raw) : {}; } catch { /* keep text */ }
  if (!res.ok) {
    return { status: 502, body: { error: `data worker /migrate failed (${res.status})`, detail: data } };
  }
  return { status: 200, body: { ok: true, ...(data && typeof data === 'object' ? (data as Record<string, unknown>) : { data }) } };
}

deployRoutes.post('/apps/:appId/migrate/oidc', async (c) => {
  const appId = c.req.param('appId');
  if (!/^[a-z][a-z0-9-]*$/.test(appId) || appId.length > 58) {
    return c.json({ error: 'invalid app id' }, 400);
  }

  const auth = c.req.header('Authorization') || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
  if (!token) return c.json({ error: 'missing OIDC token' }, 401);

  let claims;
  try {
    claims = await verifyGithubOidc(token, { audience: AUDIENCE });
  } catch (e) {
    return c.json({ error: `OIDC verification failed: ${(e as Error).message}` }, 401);
  }
  if (claims.repository !== `${ORG}/${appId}`) {
    return c.json({ error: `repository ${claims.repository} is not authorized for app ${appId}` }, 403);
  }
  if (claims.ref !== DEPLOY_REF) {
    return c.json({ error: `ref ${claims.ref ?? '(none)'} not authorized — deploys must run from ${DEPLOY_REF}` }, 403);
  }

  const body = await c.req.json<{ migrations?: unknown }>().catch(() => null);
  const { status, body: payload } = await applyMigrations(c.env, appId, body?.migrations);
  return c.json(payload, status);
});

/**
 * Internal migrate path for the Agent Teams deploy stage: agent-built apps have
 * no OIDC token, so the deploy stage POSTs the working tree's migrations.json
 * here over the PAS_BACKEND binding with the shared INTERNAL_TOKEN — the same
 * trust model as tools/internal, applied BEFORE tools/internal so schema is
 * current before actions register. Same additive-only guard as the OIDC path.
 */
deployRoutes.post('/apps/:appId/migrate/internal', async (c) => {
  if (!internalTokenOk(c.req.header('X-Internal-Token'), c.env.INTERNAL_TOKEN)) {
    return c.json({ error: 'forbidden' }, 403);
  }
  const appId = c.req.param('appId');
  if (!/^[a-z][a-z0-9-]*$/.test(appId) || appId.length > 58) {
    return c.json({ error: 'invalid app id' }, 400);
  }
  const body = await c.req.json<{ migrations?: unknown }>().catch(() => null);
  const { status, body: payload } = await applyMigrations(c.env, appId, body?.migrations);
  return c.json(payload, status);
});
