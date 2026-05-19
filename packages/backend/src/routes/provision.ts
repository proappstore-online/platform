import { Hono } from 'hono';
import type { Env } from '../types.js';
import { requireUser, HttpError } from '../lib/auth.js';
import { deployDataWorker } from '../lib/deploy-worker.js';
import { callAdminProvision, type ProvisionBody, type ProvisionStep } from '../lib/provision-client.js';

/**
 * App provisioning — pro side.
 *
 * Delegates the cross-store steps (GitHub repo, CF Pages project, DNS,
 * custom domain, storefront registry) to the FAS admin Worker via the
 * ADMIN service binding. Then runs the PAS-specific steps (D1 database,
 * Data Worker, apps row) locally. The flow:
 *
 *   client (pas create / pas publish)
 *     → PAS /v1/provision (this route, FAS auth)
 *       → ADMIN.fetch('/api/provision', {store:'apps_pro', ...})   ← FAS admin
 *         · GitHub repo
 *         · CF Pages project
 *         · Custom domain
 *         · DNS CNAME
 *         · Storefront registry
 *       ← steps + success
 *     · Create D1 database `pas-data-<id>`
 *     · Deploy Data Worker bound to that D1
 *     · INSERT INTO apps (id, creator_id, d1_database_id, …)
 *
 * If ADMIN isn't bound (local dev without the binding), the cross-store
 * steps return as 'skip' so the route still does its PAS-local work.
 */
export const provisionRoutes = new Hono<{ Bindings: Env }>();

interface ProvisionResult {
  appId: string;
  steps: ProvisionStep[];
  dataWorkerUrl: string;
  pagesUrl: string;
  success: boolean;
}

provisionRoutes.post('/provision', async (c) => {
  try {
    const user = await requireUser(c);
    const body = await c.req.json<ProvisionBody>();

    if (!body.appId || !/^[a-z][a-z0-9-]*$/.test(body.appId) || body.appId.length > 58) {
      return c.text('Invalid app ID', 400);
    }

    const appId = body.appId;
    const cfToken = c.env.CF_API_TOKEN;
    const cfAccount = c.env.CF_ACCOUNT_ID;
    const steps: ProvisionStep[] = [];

    if (!cfToken || !cfAccount) {
      return c.text('Platform provisioning not configured (missing CF credentials)', 503);
    }

    // 1. Delegate cross-store steps to FAS admin via service binding.
    let pagesUrl = '';
    if (c.env.ADMIN && !body.skipPublish) {
      const result = await callAdminProvision(c.env.ADMIN, body);
      if ('error' in result) {
        steps.push({ name: 'fas_admin', status: 'fail', detail: result.error });
      } else {
        for (const s of result.steps) {
          steps.push(s);
          if (s.name === 'CF Pages project' && s.status === 'ok') {
            pagesUrl = `https://proappstore-${appId}.pages.dev`;
          }
        }
      }
    } else {
      const reason = !c.env.ADMIN ? 'ADMIN service binding not configured' : 'skipPublish=true';
      steps.push({ name: 'fas_admin', status: 'skip', detail: reason });
    }

    // 2. Create D1 database — or, if it already exists, look up its id so the
    // Data Worker deploy can still proceed. Without the lookup, re-running
    // provision on an existing app skips the worker step ("No D1 database
    // created") even though the D1 is right there.
    let dbId = '';
    const dbName = `pas-data-${appId}`;
    try {
      const dbRes = await fetch(`https://api.cloudflare.com/client/v4/accounts/${cfAccount}/d1/database`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${cfToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: dbName }),
      });
      const dbData = (await dbRes.json()) as { success: boolean; result?: { uuid: string }; errors?: { message: string }[] };
      if (dbData.success && dbData.result) {
        dbId = dbData.result.uuid;
        steps.push({ name: 'create_d1', status: 'ok', detail: `${dbName} (${dbId})` });
      } else {
        const err = dbData.errors?.[0]?.message || 'unknown';
        if (err.includes('already exists')) {
          // Look up the existing db's id.
          const listRes = await fetch(
            `https://api.cloudflare.com/client/v4/accounts/${cfAccount}/d1/database?name=${dbName}`,
            { headers: { Authorization: `Bearer ${cfToken}` } },
          );
          const listData = (await listRes.json()) as { result?: { uuid: string; name: string }[] };
          const existing = listData.result?.find((d) => d.name === dbName);
          if (existing) {
            dbId = existing.uuid;
            steps.push({ name: 'create_d1', status: 'skip', detail: `${dbName} already exists (${dbId})` });
          } else {
            steps.push({ name: 'create_d1', status: 'fail', detail: `exists per create but list returned nothing` });
          }
        } else {
          steps.push({ name: 'create_d1', status: 'fail', detail: err });
        }
      }
    } catch (e) {
      steps.push({ name: 'create_d1', status: 'fail', detail: String(e) });
    }

    // 3. Deploy Data Worker bound to that D1.
    let dataWorkerUrl = '';
    if (dbId) {
      try {
        const result = await deployDataWorker(appId, dbId, cfToken, cfAccount);
        dataWorkerUrl = result.url;
        steps.push({ name: 'deploy_worker', status: result.ok ? 'ok' : 'fail', detail: result.detail });
      } catch (e) {
        dataWorkerUrl = `https://pas-data-${appId}.serge-the-dev.workers.dev`;
        steps.push({ name: 'deploy_worker', status: 'fail', detail: String(e) });
      }
    } else {
      steps.push({ name: 'deploy_worker', status: 'skip', detail: 'No D1 database created' });
    }

    // 4. Record the app in the platform DB.
    try {
      await c.env.DB.prepare(
        `INSERT OR IGNORE INTO apps (id, creator_id, d1_database_id, created_at) VALUES (?, ?, ?, ?)`,
      )
        .bind(appId, user.id, dbId, Date.now())
        .run();
      steps.push({ name: 'record_app', status: 'ok', detail: `creator: ${user.login}` });
    } catch (e) {
      steps.push({ name: 'record_app', status: 'fail', detail: String(e) });
    }

    const success = !steps.some((s) => s.status === 'fail');
    const result: ProvisionResult = { appId, steps, dataWorkerUrl, pagesUrl, success };
    return c.json(result, success ? 200 : 207);
  } catch (err) {
    if (err instanceof HttpError) return c.text(err.message, err.status as 401);
    throw err;
  }
});
