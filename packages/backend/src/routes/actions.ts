import { Hono } from 'hono';
import type { Env } from '../types.js';
import { HttpError, optionalUser, requireUser, type FasUser } from '../lib/auth.js';
import { dataWorkerUrl } from '../lib/data-worker-url.js';
import {
  prepareActionBatch,
  prepareActionQuery,
  prepareVerifyInput,
  prepareVerifyWrites,
  type ToolManifest,
} from '../lib/action-sql.js';
import { looksLikeAppToken, rememberTokenUser, touchLastUsed, verifyAppToken } from '../lib/app-tokens.js';
import { getVerifier, runVerifier } from '../lib/verifiers/index.js';

export const actionRoutes = new Hono<{ Bindings: Env }>();

interface ActionBody {
  params?: Record<string, unknown>;
}

actionRoutes.post('/apps/:appId/actions/:name', async (c) => {
  const appId = c.req.param('appId')!;
  const name = c.req.param('name')!;
  if (!/^[a-z][a-z0-9-]*$/.test(appId) || appId.length > 58) {
    throw new HttpError('invalid app id', 400);
  }
  if (!/^[a-z][a-z0-9_]*$/.test(name)) {
    throw new HttpError('invalid action name', 400);
  }

  // #211: an anonymous call is limited per (app, client IP) BEFORE the platform
  // D1 manifest read, so a flood costs no database work. Service-binding calls
  // (the host's tenant-meta lookup) arrive without cf-connecting-ip, which the
  // edge sets on every public request, and are exempt.
  const clientIp = c.req.header('cf-connecting-ip');
  if (clientIp && !c.req.header('Authorization') && !(await withinPublicLimit(c.env, appId, clientIp))) {
    return rateLimited();
  }

  const manifest = await loadManifest(c.env.DB, appId, name);
  // #203: a scheduled action takes no caller input — its params are the schedule's
  // fixed values — and its caller_unscoped reason holds only for those. The
  // platform scheduler reaches the data worker directly (forwardToDataWorker),
  // never this route, so no session or app token may run one here.
  if (manifest.schedule !== undefined) throw new HttpError('scheduled actions run only on the platform scheduler', 403);
  const publicAction = manifest.requires_auth === false;
  let token: string | null = null;
  let userId = '';

  if (publicAction) {
    const stalePublicError = validatePublicManifestForExecution(manifest);
    if (stalePublicError) throw new HttpError(`public action manifest is invalid: ${stalePublicError}`, 500);
    // A public action never checks the bearer, so an unverifiable one must not
    // buy its way past the anonymous limit.
    if (clientIp && c.req.header('Authorization') && !(await optionalUser(c))
      && !(await withinPublicLimit(c.env, appId, clientIp))) {
      return rateLimited();
    }
  } else {
    token = bearerToken(c.req.header('Authorization'));
    if (!token) throw new HttpError('missing bearer token', 401);
    if (looksLikeAppToken(token)) {
      // Personal app token (#154): verified here and nowhere else. The identity
      // is rebuilt from the token row (roles fixed to ['user'], login from
      // `users`), then the same role checks and :__user_id injection apply.
      const verified = await verifyAppToken(c.env.DB, appId, token);
      rememberTokenUser(c.req.raw, verified.user.id);
      if (verified.scopes.access === 'read' && actionWrites(manifest)) {
        throw new HttpError('token is read-only', 403);
      }
      if (verified.scopes.actions && !verified.scopes.actions.includes(name)) {
        throw new HttpError('token is not scoped to this action', 403);
      }
      userId = verified.user.id;
      await enforceActionAuth(c.env.DB, appId, manifest, verified.user);
      // Never forward the token upstream: the data worker can only verify
      // session JWTs, and a long-lived credential must not travel a second hop.
      token = null;
      const touched = touchLastUsed(c.env.DB, verified.tokenHash);
      try { c.executionCtx.waitUntil(touched); } catch { void touched; }
    } else {
      const user = await requireUser(c);
      userId = user.id;
      await enforceActionAuth(c.env.DB, appId, manifest, user);
    }
  }

  const body = await c.req.json<ActionBody>().catch(() => {
    throw new HttpError('invalid JSON body', 400);
  });
  const input =
    body.params === undefined
      ? {}
      : body.params !== null && typeof body.params === 'object' && !Array.isArray(body.params)
        ? body.params
        : null;
  if (!input) throw new HttpError('params must be an object', 400);
  if (manifest.operation === 'verify') return runVerifyAction(c.env, appId, manifest, input, userId, token);
  let endpoint: string;
  let payload: unknown;
  try {
    if (manifest.operation === 'batch') {
      // Batch tools run all statements in ONE D1 transaction on the data
      // worker — multi-step flows can't be left half-applied.
      endpoint = 'batch';
      payload = { statements: prepareActionBatch(manifest, input, userId) };
    } else {
      endpoint = manifest.operation === 'query' ? 'query' : 'execute';
      payload = prepareActionQuery(manifest, input, userId);
    }
  } catch (e) {
    throw new HttpError(e instanceof Error ? e.message : String(e), 400);
  }
  // Forward with the platform internal token so the data-worker trusts this as
  // prepared, role-checked SQL (identity already injected via __user_id) and
  // runs it for the end-user without requiring them to own the app. Public
  // read-only actions deliberately omit Authorization; authenticated actions
  // still forward it for compatibility with un-redeployed data workers.
  // Actions are a server-to-server path. Going through the public data-* route
  // adds the host worker as an unnecessary proxy hop and can surface a 522 even
  // when the target data worker is healthy (#153). Reach the provisioned
  // worker's direct Workers URL — built from DATA_WORKER_HOST, never a literal
  // account subdomain — protected by the internal token.
  if (publicAction && manifest.cache_ttl) {
    return cachedPublicQuery(c.env, c.req.url, appId, name, payload, manifest.cache_ttl, (p) => c.executionCtx.waitUntil(p));
  }
  const upstream = await forwardToDataWorker(c.env, appId, endpoint, payload, token);
  return passThrough(upstream, await upstream.text());
});

async function withinPublicLimit(env: Env, appId: string, ip: string): Promise<boolean> {
  return (await env.PUBLIC_ACTION_RATE_LIMIT.limit({ key: `${appId}:${ip}` })).success;
}

function rateLimited(): Response {
  return Response.json(
    { error: 'rate limit exceeded: max 120 anonymous action calls per minute' },
    { status: 429, headers: { 'Retry-After': '60', 'Cache-Control': 'no-store' } },
  );
}

/** #211: serve a public query from the edge cache for `ttl` seconds. The key is
 * the PREPARED statement (sql + positional params), so it is canonical for the
 * caller's params and changes when the app re-registers different SQL. Only a
 * 200 is stored; anything else passes through as no-store. */
async function cachedPublicQuery(
  env: Env,
  requestUrl: string,
  appId: string,
  name: string,
  payload: unknown,
  ttl: number,
  waitUntil: (p: Promise<unknown>) => void,
): Promise<Response> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(payload)));
  const hash = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
  const key = new Request(`${new URL(requestUrl).origin}/__action-cache/${appId}/${name}/${hash}`);
  const hit = await caches.default.match(key);
  // Re-wrapped: a cache match has immutable headers, and CORS middleware appends to them.
  if (hit) return new Response(hit.body, hit);

  const upstream = await forwardToDataWorker(env, appId, 'query', payload, null);
  const text = await upstream.text();
  if (upstream.status !== 200) return passThrough(upstream, text);
  const res = new Response(text, {
    headers: {
      'Cache-Control': `public, max-age=${ttl}`,
      'Content-Type': upstream.headers.get('Content-Type') ?? 'application/json; charset=utf-8',
    },
  });
  waitUntil(caches.default.put(key, res.clone()));
  return res;
}

function actionWrites(manifest: ToolManifest): boolean {
  if (manifest.operation === 'query') return false;
  if (manifest.operation === 'verify') return (manifest.statements?.length ?? 0) > 0;
  return true;
}

/** Shared prepared-action forwarder. Scheduled actions use this exact trusted
 * data-worker hop with a synthetic identity, never the public HTTP action route. */
export async function forwardToDataWorker(env: Env, appId: string, endpoint: string, payload: unknown, token: string | null): Promise<Response> {
  return fetch(dataWorkerUrl(env, appId, endpoint), {
    method: 'POST',
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(env.INTERNAL_TOKEN ? { 'X-Internal-Token': env.INTERNAL_TOKEN } : {}),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });
}

function passThrough(upstream: Response, text: string): Response {
  return new Response(text, {
    status: upstream.status,
    headers: {
      'Cache-Control': 'no-store',
      'Content-Type': upstream.headers.get('Content-Type') ?? 'application/json; charset=utf-8',
    },
  });
}

/**
 * A verify action (#148): the trusted non-SQL execution path.
 *
 *   1. the tool's `sql` (a caller-scoped SELECT) runs on the app's data worker;
 *   2. its rows go to the platform-vetted verifier the manifest names — code
 *      that lives in THIS worker, never supplied by the app;
 *   3. when the verifier completes, the tool's optional `statements` run as one
 *      transaction with the verdict bound as `:__verify_<output>`, so the write
 *      can guard on a fact the server derived (`AND :__verify_over = 1`).
 *
 * `ok: false` (no rows, malformed input) is a 200 with the error and no write:
 * the app decides what "could not verify" means. Data-worker failures pass
 * through with their status, as for every other action.
 */
async function runVerifyAction(
  env: Env,
  appId: string,
  manifest: ToolManifest,
  input: Record<string, unknown>,
  userId: string,
  token: string | null,
): Promise<Response> {
  const verifier = getVerifier(manifest.verifier);
  if (!verifier) throw new HttpError('action manifest is invalid: unknown verifier', 500);

  let query;
  try {
    query = prepareVerifyInput(manifest, input, userId);
  } catch (e) {
    throw new HttpError(e instanceof Error ? e.message : String(e), 400);
  }
  const read = await forwardToDataWorker(env, appId, 'query', query, token);
  const readText = await read.text();
  if (!read.ok) return passThrough(read, readText);
  let rows: unknown;
  try {
    rows = (JSON.parse(readText) as { rows?: unknown }).rows;
  } catch {
    throw new HttpError('data worker returned an invalid query response', 502);
  }

  const outcome = runVerifier(verifier, rows);
  const headers = { 'Cache-Control': 'no-store' };
  if (!outcome.ok) {
    return Response.json({ ok: false, verifier: verifier.id, error: outcome.error ?? 'verification failed', output: outcome.output }, { headers });
  }

  const writes = prepareVerifyWrites(manifest, input, userId, outcome.output);
  if (writes.length === 0) return Response.json({ ok: true, verifier: verifier.id, output: outcome.output }, { headers });

  const written = await forwardToDataWorker(env, appId, 'batch', { statements: writes }, token);
  const writtenText = await written.text();
  if (!written.ok) return passThrough(written, writtenText);
  let results: { meta?: unknown }[] = [];
  try {
    results = (JSON.parse(writtenText) as { results?: { meta?: unknown }[] }).results ?? [];
  } catch {
    throw new HttpError('data worker returned an invalid batch response', 502);
  }
  return Response.json(
    { ok: true, verifier: verifier.id, output: outcome.output, writes: results.map((r) => r.meta ?? {}) },
    { headers },
  );
}

function bearerToken(header: string | undefined): string | null {
  if (!header?.startsWith('Bearer ')) return null;
  const token = header.slice(7).trim();
  return token || null;
}

function validatePublicManifestForExecution(manifest: ToolManifest): string | null {
  if (manifest.operation !== 'query') return 'operation must be query';
  const sql = manifest.sql ?? '';
  if (/:__user_id\b/.test(sql)) return 'must not reference :__user_id';
  if ((manifest.auth?.platform_roles?.length ?? 0) > 0 || (manifest.auth?.app_roles?.length ?? 0) > 0) {
    return 'must not declare auth roles';
  }
  if (manifest.auth?.required === true) return 'must not require auth';
  const withoutComments = sql
    .replace(/--.*$/gm, ' ')
    .replace(/\/\*[\s\S]*?\*\//g, ' ');
  const match = /\bLIMIT\s+(\d+)\b/i.exec(withoutComments);
  if (!match) return 'must include a literal LIMIT';
  if (withoutComments.slice(match.index + match[0].length).trim().startsWith(',')) {
    return 'must not use comma LIMIT syntax';
  }
  if (Number(match[1]) > 500) return 'LIMIT must be 500 or less';
  return null;
}

async function loadManifest(db: D1Database, appId: string, name: string): Promise<ToolManifest> {
  const row = await db.prepare('SELECT manifest FROM app_tools WHERE app_id = ? AND name = ?')
    .bind(appId, name)
    .first<{ manifest: string }>();
  if (!row) throw new HttpError('action not found', 404);

  try {
    return JSON.parse(row.manifest) as ToolManifest;
  } catch {
    throw new HttpError('action manifest is invalid', 500);
  }
}

async function enforceActionAuth(
  db: D1Database,
  appId: string,
  manifest: ToolManifest,
  user: FasUser,
): Promise<void> {
  const platformRoles = manifest.auth?.platform_roles ?? [];
  if (platformRoles.length > 0 && !platformRoles.some((role) => user.roles.includes(role))) {
    throw new HttpError('requires platform role', 403);
  }

  const appRoles = manifest.auth?.app_roles ?? [];
  if (appRoles.length === 0) return;

  // #121: the session-claim fast path that used to sit here read `appRoles`,
  // which was never populated — so it never hit, and the DB query below was
  // always the real check. Removed with the claim: authorization reads the
  // table, where a revoked role takes effect immediately rather than lingering
  // for the life of a 30-day token.
  const rows = await db.prepare('SELECT role_name FROM app_roles WHERE app_id = ? AND (user_id = ? OR user_id = ?)')
    .bind(appId, user.id, user.login)
    .all<{ role_name: string }>();
  const assigned = new Set((rows.results ?? []).map((row) => row.role_name));
  if (!appRoles.some((role) => assigned.has(role))) {
    throw new HttpError('requires app role', 403);
  }
}
