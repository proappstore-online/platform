import { Hono } from 'hono';
import type { Env } from '../types.js';
import { HttpError, requireAppAccess } from '../lib/auth.js';
import { privateNoStore, wrap } from '../lib/route-wrap.js';
import { parsePeriod } from '../lib/referrals/contributions.js';
import { githubSource } from '../lib/contributions/github.js';
import { refreshProject } from '../lib/contributions/ingest.js';
import { POLICY_DESCRIPTION } from '../lib/contributions/policy.js';
import { parseCursor, parseLimit, projectPeople, projectSummary } from '../lib/contributions/stats.js';

/**
 * Project contribution statistics (#547, epic #544): who wrote how many lines of a project, from its verified
 * repository's default-branch history. Code-activity metrics only: nothing here grants access, changes a role or
 * ownership, or moves money.
 *
 *   GET  /v1/apps/:appId/contributions                 summary: state, freshness, policy, totals, bot/unlinked buckets (?from=&to=)
 *   GET  /v1/apps/:appId/contributions/people          ranked people (?from=&to=&limit=&cursor=)
 *   GET  /v1/apps/:appId/contributions/policy          the counting policy in force
 *   POST /v1/apps/:appId/contributions/refresh         owner: read the repository now (bounded; the schedule continues the rest)
 *
 * Reads need access to the app (`viewer` or above): a private team's figures stay private even when the app is
 * public. The repository is derived by the platform from the app; no caller supplies it.
 */
export const contributionRoutes = new Hono<{ Bindings: Env }>();

contributionRoutes.use('/apps/:appId/contributions', privateNoStore);
contributionRoutes.use('/apps/:appId/contributions/*', privateNoStore);

contributionRoutes.get('/apps/:appId/contributions', wrap(async (c) => {
  const appId = c.req.param('appId')!;
  await requireAppAccess(c, appId, 'viewer');
  const period = parsePeriod({ from: c.req.query('from'), to: c.req.query('to') });
  return c.json(await projectSummary(c.env.DB, appId, period, Date.now()));
}));

contributionRoutes.get('/apps/:appId/contributions/people', wrap(async (c) => {
  const appId = c.req.param('appId')!;
  await requireAppAccess(c, appId, 'viewer');
  const period = parsePeriod({ from: c.req.query('from'), to: c.req.query('to') });
  const limit = parseLimit(c.req.query('limit'));
  const cursor = parseCursor(c.req.query('cursor'));
  return c.json(await projectPeople(c.env.DB, appId, period, { limit, cursor }, Date.now()));
}));

contributionRoutes.get('/apps/:appId/contributions/policy', wrap(async (c) => {
  await requireAppAccess(c, c.req.param('appId')!, 'viewer');
  return c.json({ policy: POLICY_DESCRIPTION });
}));

contributionRoutes.post('/apps/:appId/contributions/refresh', wrap(async (c) => {
  const appId = c.req.param('appId')!;
  await requireAppAccess(c, appId, 'owner');
  if (!c.env.GITHUB_TOKEN) throw new HttpError('contribution refresh is not configured on this platform', 503);
  const run = refreshProject(c.env.DB, githubSource(c.env.GITHUB_TOKEN), appId);
  let background: ((work: Promise<unknown>) => void) | undefined;
  try { const ctx = c.executionCtx; background = (work) => ctx.waitUntil(work); } catch { /* no execution context (tests) */ }
  if (background) { background(run.catch((e) => console.error(`[contributions] refresh failed: ${(e as Error).message}`))); return c.json({ accepted: true }, 202); }
  return c.json({ accepted: true, outcome: await run }, 202);
}));
