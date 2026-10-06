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
 *   GET    /v1/apps/:appId/worker                 owner: status, last deploy, last 20 invocations
 *   DELETE /v1/apps/:appId/worker                 owner: disable + remove()
 *   POST   /v1/apps/:appId/worker/rotate          owner: rotate token + event key
 *
 * No route returns or logs the worker's token or event key.
 */
import { Hono } from 'hono';
import type { Env } from '../types.js';
import { HttpError, isAdminId, requireAdmin, requireAppOwner } from '../lib/auth.js';
import { requireAppDeployOidc } from '../lib/app-deploy-oidc.js';
import { appWorkerHost, disableAppWorker, parseBundle, rotateAppWorkerCredentials } from '../lib/app-worker-host.js';

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
  const [worker, lastDeploy, invocations] = await Promise.all([
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
  ]);
  c.header('Cache-Control', 'private, no-store');
  return c.json({ app_id: appId, worker: worker ?? { enabled: 0 }, last_deploy: lastDeploy ?? null, invocations: invocations.results ?? [] });
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
