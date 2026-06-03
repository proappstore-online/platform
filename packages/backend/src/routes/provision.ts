import { Hono } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { runChecksFromFiles } from '@proappstore/compliance';
import {
  ensurePagesProject,
  ensureDnsCname,
  ensureCustomDomain,
  pagesProjectName,
  internalTokenOk,
  type CfConfig,
  type Step,
} from '@proappstore/build-core';
import type { Env } from '../types.js';
import { requireUser, requireAppOwner, HttpError } from '../lib/auth.js';
import { provisionData } from '../lib/provision-data.js';
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
    const steps: Step[] = [];

    if (!cfToken || !cfAccount) {
      return c.text('Platform provisioning not configured (missing CF credentials)', 503);
    }

    // 0. Compliance check — skipCompliance is admin-only (used by `pas create` bootstrap)
    const canSkipCompliance = body.skipCompliance && user.roles.includes('admin');
    if (!canSkipCompliance) {
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
      steps.push({ name: 'compliance', status: 'skip', detail: 'skipCompliance=true (admin bootstrap)' });
    }

    // 1. CF Pages project + DNS + custom domain — shared build-core primitives
    //    (same code path the admin Worker's publish + agent-deploy use, so a repo
    //    provisioned by the CLI and one by Agent Teams get identical hosting).
    let pagesUrl = '';
    const projectName = pagesProjectName(appId);
    if (!body.skipPublish) {
      const cf: CfConfig = { token: cfToken, accountId: cfAccount, zoneId: ZONE_ID, domainBase: DOMAIN };
      const pagesStep = await ensurePagesProject(cf, appId);
      steps.push(pagesStep);
      if (pagesStep.status !== 'fail') pagesUrl = `https://${projectName}.pages.dev`;
      steps.push(await ensureDnsCname(cf, appId));
      steps.push(await ensureCustomDomain(cf, appId));
    }

    // 3–5. Data plane (D1 + data worker + app record) — shared with the agent
    //      deploy stage via /v1/provision-data so both paths get the same layer.
    const data = await provisionData({
      appId,
      creatorId: user.id,
      creatorLabel: user.login,
      cfToken,
      cfAccount,
      db: c.env.DB,
    });
    steps.push(...data.steps);
    const dataWorkerUrl = data.dataWorkerUrl;

    const success = !steps.some((s) => s.status === 'fail');
    return c.json({ appId, steps, dataWorkerUrl, pagesUrl, success }, success ? 200 : 207);
  } catch (err) {
    if (err instanceof HttpError) return c.text(err.message, err.status as ContentfulStatusCode);
    throw err;
  }
});

/**
 * Internal (service-to-service): provision ONLY an app's data plane (D1 + data
 * worker + app record). Called by the Agent Teams deploy stage over the
 * PAS_BACKEND service binding so agent-built apps get the same data layer a
 * CLI-published app gets from /v1/provision. Auth is the shared INTERNAL_TOKEN,
 * not a user session — the agent flow has no session and supplies the owner as
 * `creatorId`. Idempotent; safe to retry.
 */
provisionRoutes.post('/provision-data', async (c) => {
  if (!internalTokenOk(c.req.header('X-Internal-Token'), c.env.INTERNAL_TOKEN)) {
    return c.json({ error: 'forbidden' }, 403);
  }
  const body = await c.req.json<{ appId?: string; creatorId?: string }>();
  if (!body.appId || !/^[a-z][a-z0-9-]*$/.test(body.appId) || body.appId.length > 58) {
    return c.text('Invalid app ID', 400);
  }
  if (!body.creatorId) return c.text('creatorId required', 400);
  if (!c.env.CF_API_TOKEN || !c.env.CF_ACCOUNT_ID) {
    return c.text('Platform provisioning not configured (missing CF credentials)', 503);
  }
  const data = await provisionData({
    appId: body.appId,
    creatorId: body.creatorId,
    cfToken: c.env.CF_API_TOKEN,
    cfAccount: c.env.CF_ACCOUNT_ID,
    db: c.env.DB,
  });
  const success = !data.steps.some((s) => s.status === 'fail');
  return c.json({ appId: body.appId, steps: data.steps, dataWorkerUrl: data.dataWorkerUrl, success }, success ? 200 : 207);
});

/**
 * Return CF deploy credentials so the CLI can set them as GitHub repo secrets
 * on external-org repos. Requires app ownership (creator or admin).
 *
 * SECURITY: Pre-launch only — returns the platform-wide CF_API_TOKEN.
 * This token has broad scope (Pages, D1, DNS, Workers) across the entire
 * CF account. Acceptable while the only creator is the platform owner.
 *
 * TODO(production): Mint scoped per-project tokens via CF API
 * (POST /user/tokens with Pages:Edit permission restricted to the
 * specific project). This limits blast radius if a token leaks.
 */
provisionRoutes.get('/apps/:appId/deploy-credentials', async (c) => {
  const appId = c.req.param('appId');
  await requireAppOwner(c, appId);
  return c.json({
    cfApiToken: c.env.CF_API_TOKEN,
    cfAccountId: c.env.CF_ACCOUNT_ID,
  });
});

