import { Hono } from 'hono';
import { internalTokenOk } from '@proappstore/build-core';
import type { Env } from '../types.js';
import { verifyGithubOidc } from '../lib/github-oidc.js';
import { HttpError, requireAdmin, requireAppOwner } from '../lib/auth.js';
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
  const { status, payload } = await replaceAppTools(c.env.DB, appId, body?.tools ?? [], c.env);
  return c.json(payload, status as 200 | 400 | 422);
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
const MIGRATE_ADD_COLUMN = /^ALTER\s+TABLE\s+(?:"[^"]+"|`[^`]+`|\[[^\]]+\]|\S+)\s+ADD(?:\s+COLUMN)?\s+/i;

function stripSqlComments(sql: string): string {
  return sql.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/--[^\n\r]*/g, ' ');
}

function hasUnsafeNotNullAddColumn(statement: string): boolean {
  const normalized = stripSqlComments(statement).trim();
  if (!MIGRATE_ADD_COLUMN.test(normalized)) return false;
  if (!/\bNOT\s+NULL\b/i.test(normalized)) return false;
  return !/\bDEFAULT\b/i.test(normalized) || /\bDEFAULT\s*(?:\(\s*)?NULL\b/i.test(normalized);
}

type MigrationLintError = { statement: string; reason: string };

/** Returns the first unsafe statement, or null if all pass. */
function forbiddenMigrationStatement(sql: string): MigrationLintError | null {
  const statements = stripSqlComments(sql).split(';').map((s) => s.trim()).filter((s) => s.length > 0);
  for (const stmt of statements) {
    if (MIGRATE_FORBIDDEN.test(stmt) || !MIGRATE_ALLOWED_START.test(stmt)) {
      return { statement: stmt.slice(0, 80), reason: 'the deploy path allows CREATE / ALTER … ADD / INSERT only' };
    }
    if (hasUnsafeNotNullAddColumn(stmt)) {
      return {
        statement: stmt.slice(0, 80),
        reason: 'ALTER TABLE … ADD COLUMN … NOT NULL must include a non-null DEFAULT so existing rows stay valid',
      };
    }
  }
  return null;
}

/**
 * Validate the migrations are additive-only and forward them to the app's data
 * worker. Shared by the OIDC path (CLI/self-service deploys), internal path
 * (Agent Teams deploy stage), and admin repair path so the additive-only
 * guarantee lives in ONE place. Returns an HTTP status + JSON body for the
 * caller to hand back.
 */
async function applyMigrations(
  env: Env,
  appId: string,
  migrations: unknown,
  source: 'oidc' | 'internal' | 'admin',
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
          error: `migration "${m.name}" is not backward-compatible — ${bad.reason}. Use expand/contract: add nullable/defaulted schema first, deploy compatible code, then contract later if still needed: ${bad.statement}`,
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
    await recordMigrationAudit(env, appId, source, 'failed', null, null, `migrate forward failed: ${(e as Error).message}`);
    return { status: 502, body: { error: `migrate forward failed: ${(e as Error).message}` } };
  }
  const raw = await res.text();
  let data: unknown = raw;
  try { data = raw ? JSON.parse(raw) : {}; } catch { /* keep text */ }
  if (!res.ok) {
    await recordMigrationAudit(env, appId, source, 'failed', null, null, `data worker /migrate failed (${res.status}): ${raw.slice(0, 500)}`);
    const status = res.status === 422 ? 422 : 502;
    return { status, body: { error: `data worker /migrate failed (${res.status})`, detail: data } };
  }
  const result = (data && typeof data === 'object' ? data : {}) as { applied?: string[]; already?: string[] };
  await recordMigrationAudit(env, appId, source, 'applied', result.applied ?? null, result.already ?? null, null);
  return { status: 200, body: { ok: true, ...result } };
}

/** Record one migrate attempt so pending/failed migrations are visible (#33).
 *  Best-effort — an audit write must never change the migrate outcome. */
async function recordMigrationAudit(
  env: Env,
  appId: string,
  source: 'oidc' | 'internal' | 'admin',
  status: 'applied' | 'failed',
  applied: string[] | null,
  already: string[] | null,
  detail: string | null,
): Promise<void> {
  try {
    await env.DB.prepare(
      `INSERT INTO migration_audit (app_id, source, status, applied, already, detail, ran_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(appId, source, status, applied ? JSON.stringify(applied) : null, already ? JSON.stringify(already) : null, detail, Date.now())
      .run();
  } catch (e) {
    console.error(`migration_audit insert failed for ${appId}: ${(e as Error).message}`);
  }
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
  const { status, body: payload } = await applyMigrations(c.env, appId, body?.migrations, 'oidc');
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
  const { status, body: payload } = await applyMigrations(c.env, appId, body?.migrations, 'internal');
  return c.json(payload, status);
});

/**
 * Admin repair endpoint (#35). This is the human-operated recovery path for an
 * app whose repo deploy is blocked or whose previous migration partially failed.
 * It intentionally reuses applyMigrations so repair SQL stays additive-only and
 * produces the same migration_audit visibility as normal deploys.
 */
deployRoutes.post('/apps/:appId/migrate/admin', async (c) => {
  try {
    await requireAdmin(c);
  } catch (e) {
    if (e instanceof HttpError) return c.json({ error: e.message }, e.status as 401 | 403);
    throw e;
  }
  const appId = c.req.param('appId');
  if (!/^[a-z][a-z0-9-]*$/.test(appId) || appId.length > 58) {
    return c.json({ error: 'invalid app id' }, 400);
  }
  const body = await c.req.json<{ migrations?: unknown }>().catch(() => null);
  const { status, body: payload } = await applyMigrations(c.env, appId, body?.migrations, 'admin');
  return c.json(payload, status);
});

/**
 * Schema/migration status for an app (#33 Phase 2 — console visibility).
 * Owner-only. Returns the recent migrate attempts from migration_audit so the
 * console (or `curl`) can show "last migration: applied/failed at T, ran [..]"
 * instead of drift being silent. `lastFailed` is the surfacing signal.
 */
deployRoutes.get('/apps/:appId/schema-status', async (c) => {
  const appId = c.req.param('appId');
  if (!/^[a-z][a-z0-9-]*$/.test(appId) || appId.length > 58) {
    return c.json({ error: 'invalid app id' }, 400);
  }
  await requireAppOwner(c, appId);

  const rows = await c.env.DB.prepare(
    `SELECT source, status, applied, already, detail, ran_at
       FROM migration_audit WHERE app_id = ? ORDER BY ran_at DESC LIMIT 20`,
  ).bind(appId).all<{ source: string; status: string; applied: string | null; already: string | null; detail: string | null; ran_at: number }>();

  const history = (rows.results ?? []).map((r) => ({
    source: r.source,
    status: r.status,
    applied: r.applied ? JSON.parse(r.applied) as string[] : [],
    already: r.already ? JSON.parse(r.already) as string[] : [],
    detail: r.detail,
    ranAt: r.ran_at,
  }));

  const last = history[0] ?? null;
  return c.json({
    appId,
    last,
    // The surfacing signal: unresolved drift = the most recent attempt failed.
    // Null once a later attempt succeeds past it (drift resolved).
    hasUnresolvedFailure: last?.status === 'failed',
    history,
  });
});

/**
 * Fleet migration reconcile report (#35). Admin/internal, read-only.
 *
 * This is the operator queue for migration repair: apps whose latest migrate
 * attempt failed are actionable, while apps with no audit history are unknown
 * (often pre-migrations.json or no DB usage) and should be checked before
 * assuming drift. The scheduled GitHub workflow calls this with INTERNAL_TOKEN
 * and fails on `failed` so drift becomes visible in Actions.
 */
deployRoutes.get('/migrations/reconcile', async (c) => {
  if (!internalTokenOk(c.req.header('X-Internal-Token'), c.env.INTERNAL_TOKEN)) {
    try {
      await requireAdmin(c);
    } catch (e) {
      if (e instanceof HttpError) return c.json({ error: e.message }, e.status as 401 | 403);
      throw e;
    }
  }
  const includeOk = c.req.query('includeOk') === 'true';
  const rows = await c.env.DB.prepare(
    `SELECT a.id AS app_id, a.creator_id,
            ma.source, ma.status, ma.applied, ma.already, ma.detail, ma.ran_at
       FROM apps a
       LEFT JOIN migration_audit ma
         ON ma.app_id = a.id
        AND ma.ran_at = (SELECT MAX(m2.ran_at) FROM migration_audit m2 WHERE m2.app_id = a.id)
      ORDER BY a.id`,
  ).all<{
    app_id: string;
    creator_id: string;
    source: string | null;
    status: string | null;
    applied: string | null;
    already: string | null;
    detail: string | null;
    ran_at: number | null;
  }>();

  const apps = (rows.results ?? []).map((r) => ({
    appId: r.app_id,
    creatorId: r.creator_id,
    state: r.status === 'failed' ? 'failed' : r.status ? 'ok' : 'no_history',
    last: r.status ? {
      source: r.source,
      status: r.status,
      applied: r.applied ? JSON.parse(r.applied) as string[] : [],
      already: r.already ? JSON.parse(r.already) as string[] : [],
      detail: r.detail,
      ranAt: r.ran_at,
    } : null,
  })).filter((r) => includeOk || r.state !== 'ok');

  return c.json({
    generatedAt: Date.now(),
    counts: {
      failed: apps.filter((a) => a.state === 'failed').length,
      noHistory: apps.filter((a) => a.state === 'no_history').length,
      okIncluded: apps.filter((a) => a.state === 'ok').length,
    },
    apps,
  });
});
