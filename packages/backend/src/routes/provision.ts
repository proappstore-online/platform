import { Hono } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { runChecksFromFiles } from '@proappstore/compliance';
import type { Env } from '../types.js';
import { requireUser, requireAppOwner, HttpError } from '../lib/auth.js';
import { deployDataWorker } from '../lib/deploy-worker.js';
import { fetchRepoFiles, type RepoLocation } from '../lib/github-fetch.js';

/**
 * PAS app provisioning — fully self-contained.
 *
 * What it does (in order):
 *   1. Compliance check — fetches repo from GitHub, runs checks (optional)
 *   2. CF Pages project — creates proappstore-<id>.pages.dev
 *   3. DNS CNAME — <id>.proappstore.online → proappstore-<id>.pages.dev
 *   4. Custom domain — adds <id>.proappstore.online to the Pages project
 *   5. D1 database — creates pas-data-<id>
 *   6. Data Worker — deploys to data-<id>.proappstore.online
 *   7. App record — inserts into the platform apps table
 *
 * What it does NOT do:
 *   - GitHub repo creation — developers own their own repos
 *   - Repo secrets — use org-level CLOUDFLARE_API_TOKEN secret
 *
 * Idempotent — re-running skips already-provisioned resources.
 */
const ORG = 'proappstore-online';
const DOMAIN = 'proappstore.online';
const ZONE_ID = '14928daaff60902cc89003a2ebeb99fe';

interface ProvisionStep {
  name: string;
  status: 'ok' | 'fail' | 'skip';
  detail: string;
}

interface ProvisionBody {
  appId: string;
  name?: string;
  description?: string;
  category?: string;
  icon?: string;
  iconBg?: string;
  proFeatures?: string[];
  skipCompliance?: boolean;
  skipPublish?: boolean;
  repoOwner?: string;
  repoName?: string;
  ref?: string;
}

export const provisionRoutes = new Hono<{ Bindings: Env }>();

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

    // 0. Compliance check
    if (!body.skipCompliance) {
      const loc: RepoLocation = {
        owner: body.repoOwner || ORG,
        repo: body.repoName || appId,
        ref: body.ref || 'main',
      };
      try {
        const fetched = await fetchRepoFiles(loc, c.env.GITHUB_TOKEN);
        const results = await runChecksFromFiles(fetched.files);
        const hardFails = results.filter((r) => r.status === 'fail');
        const warnings = results.filter((r) => r.status === 'warn');
        if (hardFails.length > 0) {
          const detail = hardFails.map((r) => `${r.name}: ${r.detail}`).join('; ');
          steps.push({ name: 'compliance', status: 'fail', detail: `${hardFails.length} rule(s) failed — ${detail}` });
          return c.json({ appId, steps, dataWorkerUrl: '', pagesUrl: '', success: false }, 412);
        }
        steps.push({
          name: 'compliance',
          status: 'ok',
          detail: `${results.length - warnings.length} rules passed${warnings.length ? ` (${warnings.length} warnings)` : ''}`,
        });
      } catch (e) {
        const msg = (e as Error).message;
        if (/\(404\)/.test(msg)) {
          steps.push({ name: 'compliance', status: 'skip', detail: 'Repo not found — first publish; compliance runs via CI on push' });
        } else {
          steps.push({ name: 'compliance', status: 'fail', detail: `Compliance check error: ${msg}` });
          return c.json({ appId, steps, dataWorkerUrl: '', pagesUrl: '', success: false }, 412);
        }
      }
    } else {
      steps.push({ name: 'compliance', status: 'skip', detail: 'skipCompliance=true (bootstrap)' });
    }

    // 1. CF Pages project + DNS + custom domain
    let pagesUrl = '';
    const projectName = `proappstore-${appId}`;
    if (!body.skipPublish) {
      try {
        const pagesRes = await fetch(
          `https://api.cloudflare.com/client/v4/accounts/${cfAccount}/pages/projects`,
          {
            method: 'POST',
            headers: { Authorization: `Bearer ${cfToken}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({
              name: projectName,
              production_branch: 'main',
            }),
          },
        );
        const pagesData = (await pagesRes.json()) as { success: boolean; result?: { subdomain: string }; errors?: { message: string }[] };
        if (pagesData.success) {
          pagesUrl = `https://${projectName}.pages.dev`;
          steps.push({ name: 'CF Pages project', status: 'ok', detail: projectName });
        } else {
          const err = pagesData.errors?.[0]?.message || '';
          if (err.includes('already exists') || err.includes('already being used')) {
            pagesUrl = `https://${projectName}.pages.dev`;
            steps.push({ name: 'CF Pages project', status: 'skip', detail: `${projectName} already exists` });
          } else {
            steps.push({ name: 'CF Pages project', status: 'fail', detail: err || 'unknown' });
          }
        }
      } catch (e) {
        steps.push({ name: 'CF Pages project', status: 'fail', detail: String(e) });
      }

      // 2. DNS CNAME + Pages custom domain
      const subdomain = `${appId}.${DOMAIN}`;
      try {
        const dnsRes = await fetch(`https://api.cloudflare.com/client/v4/zones/${ZONE_ID}/dns_records`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${cfToken}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ type: 'CNAME', name: appId, content: `${projectName}.pages.dev`, proxied: true }),
        });
        const dnsData = (await dnsRes.json()) as { success: boolean; errors?: { message: string; code: number }[] };
        if (dnsData.success) {
          steps.push({ name: 'DNS', status: 'ok', detail: `${subdomain} → ${projectName}.pages.dev` });
        } else {
          const err = dnsData.errors?.[0]?.message || '';
          if (err.includes('already exists') || dnsData.errors?.[0]?.code === 81057) {
            steps.push({ name: 'DNS', status: 'skip', detail: `${subdomain} CNAME already exists` });
          } else {
            steps.push({ name: 'DNS', status: 'fail', detail: err || 'unknown' });
          }
        }
      } catch (e) {
        steps.push({ name: 'DNS', status: 'fail', detail: String(e) });
      }

      try {
        const domRes = await fetch(
          `https://api.cloudflare.com/client/v4/accounts/${cfAccount}/pages/projects/${projectName}/domains`,
          {
            method: 'POST',
            headers: { Authorization: `Bearer ${cfToken}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: subdomain }),
          },
        );
        const domData = (await domRes.json()) as { success: boolean; errors?: { message: string }[] };
        if (domData.success) {
          steps.push({ name: 'custom domain', status: 'ok', detail: subdomain });
        } else {
          const err = domData.errors?.[0]?.message || '';
          if (err.includes('already') || err.includes('exists')) {
            steps.push({ name: 'custom domain', status: 'skip', detail: `${subdomain} already configured` });
          } else {
            steps.push({ name: 'custom domain', status: 'fail', detail: err || 'unknown' });
          }
        }
      } catch (e) {
        steps.push({ name: 'custom domain', status: 'fail', detail: String(e) });
      }
    }

    // 3. Create D1 database
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
            steps.push({ name: 'create_d1', status: 'fail', detail: 'exists per create but list returned nothing' });
          }
        } else {
          steps.push({ name: 'create_d1', status: 'fail', detail: err });
        }
      }
    } catch (e) {
      steps.push({ name: 'create_d1', status: 'fail', detail: String(e) });
    }

    // 4. Deploy Data Worker
    let dataWorkerUrl = '';
    if (dbId) {
      try {
        const result = await deployDataWorker(appId, dbId, cfToken, cfAccount);
        dataWorkerUrl = result.url;
        steps.push({ name: 'deploy_worker', status: result.ok ? 'ok' : 'fail', detail: result.detail });
      } catch (e) {
        steps.push({ name: 'deploy_worker', status: 'fail', detail: String(e) });
      }
    } else {
      steps.push({ name: 'deploy_worker', status: 'skip', detail: 'No D1 database created' });
    }

    // 5. Record the app
    try {
      await c.env.DB.prepare(
        'INSERT OR IGNORE INTO apps (id, creator_id, d1_database_id, created_at) VALUES (?, ?, ?, ?)',
      )
        .bind(appId, user.id, dbId, Date.now())
        .run();
      steps.push({ name: 'record_app', status: 'ok', detail: `creator: ${user.login}` });
    } catch (e) {
      steps.push({ name: 'record_app', status: 'fail', detail: String(e) });
    }

    const success = !steps.some((s) => s.status === 'fail');
    return c.json({ appId, steps, dataWorkerUrl, pagesUrl, success }, success ? 200 : 207);
  } catch (err) {
    if (err instanceof HttpError) return c.text(err.message, err.status as ContentfulStatusCode);
    throw err;
  }
});

/**
 * Return CF deploy credentials so the CLI can set them as GitHub repo secrets
 * on external-org repos. Requires app ownership (creator or admin).
 *
 * Pre-launch: returns the platform CF_API_TOKEN directly. Production: should
 * mint scoped per-app tokens via CF API.
 */
provisionRoutes.get('/apps/:appId/deploy-credentials', async (c) => {
  const appId = c.req.param('appId');
  await requireAppOwner(c, appId);
  return c.json({
    cfApiToken: c.env.CF_API_TOKEN,
    cfAccountId: c.env.CF_ACCOUNT_ID,
  });
});

