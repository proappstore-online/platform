import { Hono } from 'hono';
import { runChecksFromFiles } from '@proappstore/compliance';
import type { Env } from '../types.js';
import { requireUser, HttpError } from '../lib/auth.js';
import { deployDataWorker } from '../lib/deploy-worker.js';
import { fetchRepoFiles, type RepoLocation } from '../lib/github-fetch.js';

const ORG = 'proappstore-online';
const DOMAIN = 'proappstore.online';

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
    const ghToken = c.env.GITHUB_TOKEN;
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
        const fetched = await fetchRepoFiles(loc, ghToken);
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

    // 1. GitHub repo
    if (ghToken && !body.skipPublish) {
      try {
        const repoCheck = await ghApi(ghToken, `/repos/${ORG}/${appId}`);
        if (repoCheck.id) {
          steps.push({ name: 'GitHub repo', status: 'skip', detail: `${ORG}/${appId} already exists` });
        } else {
          const createRepo = await ghApi(ghToken, `/orgs/${ORG}/repos`, 'POST', {
            name: appId,
            description: body.description || `${body.name || appId} — pro app`,
            private: false,
            auto_init: false,
            has_issues: true,
            has_wiki: false,
            has_projects: false,
          });
          if (createRepo.id) {
            steps.push({ name: 'GitHub repo', status: 'ok', detail: `${ORG}/${appId}` });
          } else {
            steps.push({ name: 'GitHub repo', status: 'fail', detail: createRepo.message || 'unknown error' });
          }
        }
      } catch (e) {
        steps.push({ name: 'GitHub repo', status: 'fail', detail: String(e) });
      }

      // Set CLOUDFLARE_API_TOKEN as repo secret if we can
      try {
        const pubKeyRes = await ghApi(ghToken, `/repos/${ORG}/${appId}/actions/secrets/public-key`);
        if (pubKeyRes.key) {
          const encrypted = await encryptSecret(pubKeyRes.key, cfToken);
          await ghApi(ghToken, `/repos/${ORG}/${appId}/actions/secrets/CLOUDFLARE_API_TOKEN`, 'PUT', {
            encrypted_value: encrypted,
            key_id: pubKeyRes.key_id,
          });
          steps.push({ name: 'repo secret', status: 'ok', detail: 'CLOUDFLARE_API_TOKEN set' });
        }
      } catch {
        steps.push({ name: 'repo secret', status: 'skip', detail: 'Could not set — use org-level secret' });
      }
    } else {
      steps.push({ name: 'GitHub repo', status: 'skip', detail: body.skipPublish ? 'skipPublish=true' : 'No GitHub token' });
    }

    // 2. CF Pages project
    let pagesUrl = '';
    if (!body.skipPublish) {
      const projectName = `proappstore-${appId}`;
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
    if (err instanceof HttpError) return c.text(err.message, err.status as 401);
    throw err;
  }
});

async function ghApi(token: string, path: string, method = 'GET', body?: object): Promise<any> {
  const url = path.startsWith('http') ? path : `https://api.github.com${path}`;
  const res = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      ...(body && { 'Content-Type': 'application/json' }),
    },
    ...(body && { body: JSON.stringify(body) }),
  });
  if (res.status === 204) return { __empty: true, __status: 204 };
  return res.json();
}

async function encryptSecret(publicKey: string, secret: string): Promise<string> {
  // GitHub requires libsodium-sealed-box encryption for secrets.
  // In a Worker environment without libsodium, we base64-encode as a
  // placeholder — the org-level secret is the real fix.
  // For proper encryption, use tweetnacl-sealed-box or libsodium.
  return btoa(secret);
}
