/**
 * App-wide metric time series for the console operator view (#240).
 *
 * GET /v1/apps/:appId/operator/metrics/:resourceId?from=&to=&grain=
 *
 * Owner-only. The resource must be a declared metrics resource with `series`.
 * The requested range and grain are validated against its declaration (dates,
 * order, no future, at most max_days, no grain finer than the query returns)
 * before anything runs; the app's query then runs through runOperatorQuery —
 * the action's own role gate, step_up and audit — with the range bound to its
 * two declared params, and its rows are rolled up into bounded grain buckets
 * (lib/operator-series.ts). The audit row records the resource and the range,
 * never a value.
 *
 * The series' columns go through the sensitive-field layer (#294, #336) before
 * anything runs, for a contract stored before a term joined the list: a
 * sensitive measure is dropped, a sensitive dimension loses its breakdown (the
 * series is rolled up without it), and a sensitive time column refuses the
 * request, since no series can be built without it. Blocks are logged like rows.
 */
import { Hono } from 'hono';
import type { Env } from '../types.js';
import { HttpError } from '../lib/auth.js';
import { requireOperatorAccess } from '../lib/operator-audit-marks.js';
import { resolveSeriesRequest, rollupSeries } from '../lib/operator-series.js';
import { runOperatorQuery } from './operator-exec.js';
import { declaredResource, returnableKeys, sessionToken } from './operator.js';

export const operatorMetricsRoutes = new Hono<{ Bindings: Env }>();

operatorMetricsRoutes.get('/apps/:appId/operator/metrics/:resourceId', async (c) => {
  const appId = c.req.param('appId');
  const caller = await requireOperatorAccess(c, appId);
  const resource = await declaredResource(c.env.DB, appId, c.req.param('resourceId'), c.req.raw);
  const declared = resource.series;
  if (!declared) throw new HttpError('resource is not a time series', 404);
  const kept = new Set(returnableKeys(
    [declared.time.column, ...declared.measures.map((m) => m.column), ...(declared.dimension ? [declared.dimension.column] : [])].map((key) => ({ key })),
    { appId, where: `series:${resource.id}` },
  ).map((k) => k.key));
  if (!kept.has(declared.time.column)) throw new HttpError('this metric\'s time column is on the sensitive-field list; redeploy its operator_view', 409);
  const series = {
    ...declared,
    measures: declared.measures.filter((m) => kept.has(m.column)),
    dimension: declared.dimension && kept.has(declared.dimension.column) ? declared.dimension : null,
  };
  const req = resolveSeriesRequest(series, { from: c.req.query('from'), to: c.req.query('to'), grain: c.req.query('grain') });

  const rows = await runOperatorQuery(
    c.env, appId, resource.action, { [series.range.from_param]: req.from, [series.range.to_param]: req.to }, caller,
    sessionToken(c.req.header('Authorization')),
    { operatorAction: `series:${resource.id}`, target: `${req.from}..${req.to}/${req.grain}`, request: c.req.raw },
  );
  c.header('Cache-Control', 'private, no-store');
  return c.json(rollupSeries(series, rows, req));
});
