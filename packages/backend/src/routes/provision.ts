import { Hono } from 'hono';
import type { Env } from '../types.js';
import { requireUser, HttpError } from '../lib/auth.js';
import { deployDataWorker } from '../lib/deploy-worker.js';

/**
 * App provisioning — creates D1 database + CF Pages project for a new pro app.
 * Called by `pas create` CLI after scaffolding.
 *
 * Uses the platform's CF credentials (not the developer's).
 * The developer just needs to be signed in via FAS auth.
 */
export const provisionRoutes = new Hono<{ Bindings: Env }>();

interface ProvisionResult {
  appId: string;
  steps: { name: string; status: string; detail: string }[];
  dataWorkerUrl: string;
  pagesUrl: string;
}

provisionRoutes.post('/provision', async (c) => {
  try {
    const user = await requireUser(c);
    const body = await c.req.json<{ appId: string; repoUrl?: string }>();

    if (!body.appId || !/^[a-z][a-z0-9-]*$/.test(body.appId) || body.appId.length > 58) {
      return c.text('Invalid app ID', 400);
    }

    const appId = body.appId;
    const cfToken = c.env.CF_API_TOKEN;
    const cfAccount = c.env.CF_ACCOUNT_ID;

    if (!cfToken || !cfAccount) {
      return c.text('Platform provisioning not configured (missing CF credentials)', 503);
    }

    const steps: ProvisionResult['steps'] = [];

    // 1. Create D1 database
    let dbId = '';
    try {
      const dbRes = await fetch(`https://api.cloudflare.com/client/v4/accounts/${cfAccount}/d1/database`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${cfToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: `pas-data-${appId}` }),
      });
      const dbData = (await dbRes.json()) as { success: boolean; result?: { uuid: string }; errors?: { message: string }[] };
      if (dbData.success && dbData.result) {
        dbId = dbData.result.uuid;
        steps.push({ name: 'create_d1', status: 'ok', detail: `pas-data-${appId} (${dbId})` });
      } else {
        const err = dbData.errors?.[0]?.message || 'unknown';
        steps.push({ name: 'create_d1', status: err.includes('already exists') ? 'skip' : 'fail', detail: err });
      }
    } catch (e) {
      steps.push({ name: 'create_d1', status: 'fail', detail: String(e) });
    }

    // 2. Deploy Data Worker
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

    // 3. Create CF Pages project (if repoUrl provided)
    let pagesUrl = '';
    if (body.repoUrl) {
      try {
        // Extract owner/repo from URL
        const match = body.repoUrl.match(/github\.com\/([^/]+)\/([^/.]+)/);
        if (match) {
          const [, owner, repo] = match;
          const pagesRes = await fetch(`https://api.cloudflare.com/client/v4/accounts/${cfAccount}/pages/projects`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${cfToken}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({
              name: `proappstore-${appId}`,
              production_branch: 'main',
              build_config: {
                build_command: 'npx pnpm@10 install && npx pnpm@10 build',
                destination_dir: 'web/dist',
              },
              source: {
                type: 'github',
                config: {
                  owner,
                  repo_name: repo,
                  production_branch: 'main',
                  deployments_enabled: true,
                },
              },
            }),
          });
          const pagesData = (await pagesRes.json()) as { success: boolean; result?: { subdomain: string } };
          if (pagesData.success) {
            pagesUrl = `https://proappstore-${appId}.pages.dev`;
            steps.push({ name: 'create_pages', status: 'ok', detail: pagesUrl });
          } else {
            steps.push({ name: 'create_pages', status: 'fail', detail: JSON.stringify(pagesData) });
          }
        }
      } catch (e) {
        steps.push({ name: 'create_pages', status: 'fail', detail: String(e) });
      }
    } else {
      steps.push({ name: 'create_pages', status: 'skip', detail: 'No repoUrl provided' });
    }

    // 4. Record the app in the platform DB
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

    const result: ProvisionResult = {
      appId,
      steps,
      dataWorkerUrl,
      pagesUrl,
    };

    return c.json(result);
  } catch (err) {
    if (err instanceof HttpError) return c.text(err.message, err.status as 401);
    throw err;
  }
});
