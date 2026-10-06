/**
 * App workers (#253, ADR-009): deploy, admin flag, owner status/removal/rotation.
 *
 * Prototype gate (ADR-009 §5): a worker deploys and runs only for an app whose
 * `app_workers.enabled` flag a platform admin turned on, the flag can be turned
 * on only for a first-party app (owner in ADMIN_GITHUB_IDS), and at most
 * `APP_WORKER_CAP` apps hold it. Production keeps every flag off until #274 is
 * closed (ADR-009, "Trust assumptions").
 *
 *   PUT    /v1/apps/:appId/worker/oidc            the app's main-branch workflow uploads its bundle
 *   PUT    /v1/admin/apps/:appId/worker-enabled   admin: { enabled } — off runs remove()
 *   GET    /v1/apps/:appId/worker                 owner: status, last deploy, last 20 invocations, schedules
 *   DELETE /v1/apps/:appId/worker                 owner: disable + remove()
 *   POST   /v1/apps/:appId/worker/rotate          owner: rotate token + event key
 *   POST   /v1/apps/:appId/worker/schedules/:name/run   owner: queue a schedule run now (#255)
 *   POST   /v1/apps/:appId/worker/http        a signed-in user's /.pas/worker/* request, mediated by the host (#260)
 *
 * No route returns or logs the worker's token or event key.
 */
import { Hono } from 'hono';
import type { Env } from '../types.js';
import { HttpError, isAdminId, requireAdmin, requireAppOwner } from '../lib/auth.js';
import { requireAppDeployOidc } from '../lib/app-deploy-oidc.js';
import { activeAppWorker, appWorkerHost, disableAppWorker, parseBundle, rotateAppWorkerCredentials } from '../lib/app-worker-host.js';
import { runNowDueAt, WORKER_RUN_PREFIX } from '../lib/scheduled-actions.js';
import { requireVisibleUser } from '../lib/visibility.js';
import { mintCallerGrant } from '../lib/caller-grant.js';
import { decodeEnvelopeBody, encodeEnvelopeBody } from '../app-worker-shim/body.js';
import type { AppWorkerExports } from '../lib/app-worker-host.js';

/** One manual run per schedule per minute (#255). */
export const RUN_NOW_INTERVAL_MS = 60_000;

export const APP_WORKER_CAP = 5;

export const appWorkerRoutes = new Hono<{ Bindings: Env }>();

async function recordDeploy(
  env: Env, appId: string, claims: { repository: string; ref?: string; sha?: string },
  status: 'deployed' | 'refused' | 'failed', detail: string, bundleSha: string | null = null,
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO app_worker_deploys (id, app_id, repository, ref, sha, bundle_sha256, status, detail, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(crypto.randomUUID(), appId, claims.repository, claims.ref ?? null, claims.sha ?? null, bundleSha, status, detail.slice(0, 500), Date.now()).run();
}

appWorkerRoutes.put('/apps/:appId/worker/oidc', async (c) => {
  const appId = c.req.param('appId');
  const claims = await requireAppDeployOidc(c, appId);

  // The flag before anything is read or stored: a disabled app uploads nothing.
  const flag = await c.env.DB.prepare(
    'SELECT w.enabled FROM app_workers w INNER JOIN apps a ON a.id = w.app_id WHERE w.app_id = ?',
  ).bind(appId).first<{ enabled: number }>();
  if (flag?.enabled !== 1) {
    await recordDeploy(c.env, appId, claims, 'refused', 'app workers are not enabled for this app');
    throw new HttpError('app workers are not enabled for this app', 403);
  }

  const host = appWorkerHost(c.env);
  let bundleSha: string | null = null;
  try {
    const form = await c.req.formData().catch(() => { throw new HttpError('the body must be multipart/form-data with one part per module', 400); });
    const result = await host.deploy(appId, await parseBundle(form), { sha: claims.sha, ref: claims.ref });
    bundleSha = result.bundleSha256;
    await recordDeploy(c.env, appId, claims, 'deployed', result.firstDeploy ? 'first deploy: credentials minted' : 'redeploy', bundleSha);
    return c.json({ ok: true, backend: result.backend, bundle_sha256: result.bundleSha256, first_deploy: result.firstDeploy });
  } catch (e) {
    const status = e instanceof HttpError ? e.status : 500;
    await recordDeploy(c.env, appId, claims, status < 500 ? 'refused' : 'failed', String((e as Error)?.message ?? e), bundleSha);
    throw e;
  }
});

appWorkerRoutes.put('/admin/apps/:appId/worker-enabled', async (c) => {
  const admin = await requireAdmin(c);
  const appId = c.req.param('appId');
  const body = await c.req.json<{ enabled?: unknown }>().catch(() => null);
  if (typeof body?.enabled !== 'boolean') throw new HttpError('body must be { "enabled": true | false }', 400);

  const app = await c.env.DB.prepare('SELECT creator_id FROM apps WHERE id = ?').bind(appId).first<{ creator_id: string }>();
  if (!app) throw new HttpError('app not found', 404);

  if (!body.enabled) {
    await disableAppWorker(c.env, appId);
    return c.json({ ok: true, enabled: false });
  }

  if (!isAdminId(app.creator_id, c.env)) {
    throw new HttpError('app workers are limited to first-party apps during the prototype', 403);
  }
  // One statement, so two concurrent enables cannot both take the last slot.
  const now = Date.now();
  const res = await c.env.DB.prepare(
    `INSERT INTO app_workers (app_id, enabled, enabled_by, enabled_at)
     SELECT ?1, 1, ?2, ?3
      WHERE (SELECT COUNT(*) FROM app_workers WHERE enabled = 1 AND app_id <> ?1) < ?4
     ON CONFLICT(app_id) DO UPDATE SET enabled = 1, enabled_by = excluded.enabled_by, enabled_at = excluded.enabled_at`,
  ).bind(appId, admin.id, now, APP_WORKER_CAP).run();
  if (!res.meta.changes) throw new HttpError(`app worker cap reached (${APP_WORKER_CAP})`, 409);
  return c.json({ ok: true, enabled: true });
});

appWorkerRoutes.get('/apps/:appId/worker', async (c) => {
  const appId = c.req.param('appId');
  await requireAppOwner(c, appId);
  // Explicit columns: the token, its hash and the sealed keys are never selected.
  const [worker, lastDeploy, invocations, schedules] = await Promise.all([
    c.env.DB.prepare(
      `SELECT enabled, backend, bundle_sha256, config_version, deployed_sha, deployed_ref, deployed_at, enabled_by, enabled_at,
              prev_key_until AS rotation_overlap_until
         FROM app_workers WHERE app_id = ?`,
    ).bind(appId).first(),
    c.env.DB.prepare(
      'SELECT repository, ref, sha, bundle_sha256, status, detail, created_at FROM app_worker_deploys WHERE app_id = ? ORDER BY created_at DESC LIMIT 1',
    ).bind(appId).first(),
    c.env.DB.prepare(
      `SELECT id, event_id, type, name, attempt, status, http_status, body_excerpt, pas_calls, started_at, finished_at, error
         FROM app_worker_invocations WHERE app_id = ? ORDER BY started_at DESC LIMIT 20`,
    ).bind(appId).all(),
    // #261: the manifest's schedules, with the #123 breaker state the console and CLI show.
    c.env.DB.prepare(
      `SELECT s.name, s.cron, st.consecutive_failures, st.schedule_disabled_at
         FROM app_worker_schedules s
         LEFT JOIN scheduled_action_state st ON st.app_id = s.app_id AND st.action_name = ? || s.name
        WHERE s.app_id = ? ORDER BY s.name`,
    ).bind(WORKER_RUN_PREFIX, appId).all(),
  ]);
  c.header('Cache-Control', 'private, no-store');
  return c.json({ app_id: appId, worker: worker ?? { enabled: 0 }, last_deploy: lastDeploy ?? null, invocations: invocations.results ?? [], schedules: schedules.results ?? [] });
});

appWorkerRoutes.delete('/apps/:appId/worker', async (c) => {
  const appId = c.req.param('appId');
  await requireAppOwner(c, appId);
  await disableAppWorker(c.env, appId);
  return c.json({ ok: true });
});

appWorkerRoutes.post('/apps/:appId/worker/rotate', async (c) => {
  const appId = c.req.param('appId');
  await requireAppOwner(c, appId);
  const { configVersion } = await rotateAppWorkerCredentials(c.env, appId);
  return c.json({ ok: true, config_version: configVersion });
});

/**
 * Run a worker schedule now (#255). Never invokes the worker from this request —
 * a run may take 5 minutes and a fetch handler gets 30 s of waitUntil. It inserts
 * a `due` run row (due_at in ms, never minute-aligned) that the next platform
 * tick claims through the same race-proof claim as cron runs: started within one
 * tick (≤ 5 min), with the full run budget. Callers poll GET …/scheduled-runs.
 * #257 swaps this for an enqueue.
 */
appWorkerRoutes.post('/apps/:appId/worker/schedules/:name/run', async (c) => {
  const appId = c.req.param('appId');
  const name = c.req.param('name');
  await requireAppOwner(c, appId);
  const action = `${WORKER_RUN_PREFIX}${name}`;

  const schedule = await c.env.DB.prepare('SELECT 1 AS found FROM app_worker_schedules WHERE app_id = ? AND name = ?').bind(appId, name).first();
  if (!schedule) throw new HttpError('worker schedule not found', 404);
  if (!(await activeAppWorker(c.env, appId))) throw new HttpError('the app worker is not enabled and deployed', 409);
  const disabled = await c.env.DB.prepare(
    'SELECT 1 AS off FROM scheduled_action_state WHERE app_id = ? AND action_name = ? AND schedule_disabled_at IS NOT NULL',
  ).bind(appId, action).first();
  if (disabled) throw new HttpError('this schedule is disabled after repeated failures; redeploy the manifest to re-enable it', 409);
  const inFlight = await c.env.DB.prepare(
    "SELECT 1 AS busy FROM scheduled_action_runs WHERE app_id = ? AND action_name = ? AND status IN ('due', 'claimed', 'queued') LIMIT 1",
  ).bind(appId, action).first();
  if (inFlight) throw new HttpError('a run is already in progress', 409);

  const now = Date.now();
  // Atomic: two concurrent requests cannot both pass the limit.
  const allowed = await c.env.DB.prepare(
    'UPDATE app_worker_schedules SET last_manual_run_at = ? WHERE app_id = ? AND name = ? AND (last_manual_run_at IS NULL OR last_manual_run_at <= ?)',
  ).bind(now, appId, name, now - RUN_NOW_INTERVAL_MS).run();
  if (!allowed.meta.changes) throw new HttpError('one manual run per schedule per minute', 429);

  const runId = crypto.randomUUID();
  await c.env.DB.prepare(
    "INSERT INTO scheduled_action_runs (run_id, app_id, action_name, source, due_at, status) VALUES (?, ?, ?, 'code', ?, 'due')",
  ).bind(runId, appId, action, runNowDueAt(now)).run();
  return c.json({ run_id: runId, status: 'due' }, 202);
});

// ── Browser requests to the app worker (#260) ───────────────────────────────

export const WORKER_HTTP_MAX_REQUEST_BYTES = 1024 * 1024;
export const WORKER_HTTP_MAX_RESPONSE_BYTES = 5 * 1024 * 1024;
/** ADR-009 §4: http events get 30 s. They are never retried. */
export const WORKER_HTTP_TIMEOUT_MS = 30_000;
const WORKER_HTTP_METHODS = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE']);
const REQUEST_HEADERS = ['content-type', 'accept', 'accept-language', 'if-none-match', 'if-modified-since'];
/** All a worker response may carry back; Cache-Control is forced, Set-Cookie and the rest never pass. */
const RESPONSE_HEADERS = ['content-type', 'etag'];

/**
 * A signed-in user's request to `/.pas/worker/<path>` on the app origin. The host
 * (platform-mediation.ts) forwards it here with the session as bearer, the app it
 * resolved as X-PAS-App, and the original method and path in X-PAS-Worker-*.
 * The platform mints a 30-second caller grant for that user and invokes the
 * worker with an `http` event; inside the request the worker may run actions as
 * the user (`PAS.actions.call(…, { as: grant })`).
 */
appWorkerRoutes.post('/apps/:appId/worker/http', async (c) => {
  const appId = c.req.param('appId');
  const user = await requireVisibleUser(c, appId);
  // Only the host sets this (the API entry strips it), so it proves the request came through the app's own origin.
  if (c.req.header('X-PAS-App') !== appId) throw new HttpError('worker routes are reached through the app origin (/.pas/worker)', 403);
  const method = (c.req.header('X-PAS-Worker-Method') ?? '').toUpperCase();
  const target = c.req.header('X-PAS-Worker-Path') ?? '';
  if (!WORKER_HTTP_METHODS.has(method)) throw new HttpError('unsupported method', 405);
  if (!target.startsWith('/') || target.length > 2048 || /[\r\n]/.test(target)) throw new HttpError('invalid worker path', 400);
  if (!(await activeAppWorker(c.env, appId))) throw new HttpError('not found', 404);

  const bytes = new Uint8Array(await c.req.arrayBuffer());
  if (bytes.byteLength > WORKER_HTTP_MAX_REQUEST_BYTES) throw new HttpError(`request body exceeds ${WORKER_HTTP_MAX_REQUEST_BYTES} bytes`, 413);
  const q = target.indexOf('?');
  const headers: Record<string, string> = {};
  for (const name of REQUEST_HEADERS) {
    const value = c.req.header(name);
    if (value !== undefined) headers[name] = value.slice(0, 1024);
  }

  let ctx: AppWorkerExports | undefined;
  try { ctx = c.executionCtx as unknown as AppWorkerExports; } catch { ctx = undefined; }
  const result = await appWorkerHost(c.env, ctx).invoke(appId, {
    id: crypto.randomUUID(),
    type: 'http',
    attempt: 1,
    payload: {
      method,
      path: q === -1 ? target : target.slice(0, q),
      query: q === -1 ? '' : target.slice(q + 1),
      headers,
      ...encodeEnvelopeBody(bytes, headers['content-type'] ?? null),
    },
    caller: await mintCallerGrant(c.env, appId, user),
  }, { timeoutMs: WORKER_HTTP_TIMEOUT_MS });

  if (result.status === 'timeout') throw new HttpError('the app worker did not answer in time', 504);
  let wrapped: { v?: unknown; status?: unknown; headers?: Record<string, string>; body?: unknown; body_encoding?: unknown };
  try {
    wrapped = JSON.parse(result.body ?? '');
  } catch {
    throw new HttpError('the app worker failed', 502);
  }
  if (wrapped.v !== 1 || typeof wrapped.status !== 'number' || wrapped.status < 200 || wrapped.status > 599) throw new HttpError('the app worker failed', 502);
  const body = decodeEnvelopeBody(wrapped.body, wrapped.body_encoding);
  if (body.byteLength > WORKER_HTTP_MAX_RESPONSE_BYTES) throw new HttpError('the app worker response is too large', 502);
  const out = new Headers({ 'Cache-Control': 'private, no-store' });
  for (const name of RESPONSE_HEADERS) {
    const value = wrapped.headers?.[name];
    if (typeof value === 'string') out.set(name, value);
  }
  const nullBody = [204, 205, 304].includes(wrapped.status) || method === 'HEAD';
  return new Response(nullBody ? null : body, { status: wrapped.status, headers: out });
});
