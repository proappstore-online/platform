// Read-only analytics dashboard routes — stats, custom events, live view,
// admin platform aggregate, and diagnostics. All aggregate from Workers
// Analytics Engine via cfAnalyticsSql. Extracted verbatim from analytics.ts.

import type { Hono } from 'hono';
import { HttpError, requireAdmin, requireAppOwner } from '../lib/auth.js';
import type { Env } from '../types.js';
import {
  APP_ID_RE,
  CF_TOKEN_RE,
  cfAnalyticsSql,
  EVENT_KIND_RE,
  loadRow,
  STATS_DATASET,
  STATS_DAYS_DEFAULT,
  STATS_DAYS_MAX,
  type StatsRow,
  wrap,
} from './analytics-shared.js';

export function registerStatsRoutes(analyticsRoutes: Hono<{ Bindings: Env }>) {
  // ---------------------------------------------------------------------------
  // Stats query (creator-only): aggregates from Workers Analytics Engine via
  // the SQL API. Powers the in-platform analytics dashboard.
  // ---------------------------------------------------------------------------

  analyticsRoutes.get(
    '/apps/:appId/analytics/stats',
    wrap(async (c) => {
      const appId = c.req.param('appId')!;
      if (!APP_ID_RE.test(appId)) throw new HttpError('invalid app id', 400);
      await requireAppOwner(c, appId);
      const days = Math.min(
        STATS_DAYS_MAX,
        Math.max(1, Number(c.req.query('days') ?? STATS_DAYS_DEFAULT) | 0),
      );
      // `?kind=` lets the same dashboard machinery render any event kind,
      // not just pageview. Validated against EVENT_KIND_RE so the value
      // can be safely embedded in the SQL WHERE clause.
      const kindParam = (c.req.query('kind') ?? 'pageview').trim().toLowerCase();
      if (!EVENT_KIND_RE.test(kindParam)) throw new HttpError('invalid kind', 400);
      // `?path=` narrows the dashboard to a single page path (drill-down).
      // Length-capped at 256. SECURITY: ClickHouse string literals honour
      // backslash escapes, so doubling quotes alone is not enough (a trailing
      // `\` turns the doubled `''` into an escaped quote and breaks out of the
      // literal → SQL injection / cross-tenant read). Escape backslashes FIRST,
      // then quotes.
      const pathParamRaw = c.req.query('path');
      const pathParam = pathParamRaw ? pathParamRaw.slice(0, 256) : '';
      const pathEscaped = pathParam.replace(/\\/g, '\\\\').replace(/'/g, "''");
      const pathClause = pathParam ? ` AND blob3 = '${pathEscaped}'` : '';
      // `?bucket=hour|day` controls series granularity. Auto-picks 'hour' when
      // days==1 (24-point chart for spike investigation), 'day' otherwise.
      const bucketParam = (c.req.query('bucket') ?? '').trim().toLowerCase();
      const bucket: 'hour' | 'day' =
        bucketParam === 'hour' || bucketParam === 'day'
          ? bucketParam
          : days <= 1
            ? 'hour'
            : 'day';
      const seriesGroup = bucket === 'hour' ? 'toStartOfHour' : 'toStartOfDay';
      // Effective event time: prefer client-recorded `t` stored in doubles[1]
      // (set for offline-replayed events), fall back to server-write timestamp
      // for older rows that pre-date the second double.
      const effectiveTime =
        `if(length(doubles) > 1, fromUnixTimestamp64Milli(toInt64(double2)), timestamp)`;
      const sinceClause = `${effectiveTime} > NOW() - INTERVAL '${days}' DAY`;
      const where = `WHERE index1 = '${appId}' AND blob2 = '${kindParam}'${pathClause} AND ${sinceClause}`;

      const totalsQ = `SELECT SUM(_sample_interval) AS views, COUNT(DISTINCT blob3) AS uniq_paths FROM ${STATS_DATASET} ${where}`;
      const seriesQ = `SELECT ${seriesGroup}(${effectiveTime}) AS t, SUM(_sample_interval) AS views FROM ${STATS_DATASET} ${where} GROUP BY t ORDER BY t ASC`;
      const pathsQ = `SELECT blob3 AS path, SUM(_sample_interval) AS views FROM ${STATS_DATASET} ${where} GROUP BY path ORDER BY views DESC LIMIT 10`;
      const refsQ = `SELECT blob4 AS referrer, SUM(_sample_interval) AS views FROM ${STATS_DATASET} ${where} AND blob4 != '' GROUP BY referrer ORDER BY views DESC LIMIT 10`;
      const ctyQ = `SELECT blob5 AS country, SUM(_sample_interval) AS views FROM ${STATS_DATASET} ${where} AND blob5 != '' GROUP BY country ORDER BY views DESC LIMIT 10`;
      const devQ = `SELECT blob6 AS device, SUM(_sample_interval) AS views FROM ${STATS_DATASET} ${where} GROUP BY device`;

      const env = c.env as Env & { CF_ACCOUNT_ID?: string; CF_ANALYTICS_API_TOKEN?: string };
      try {
        const [totals, series, paths, refs, ctys, devs] = await Promise.all([
          cfAnalyticsSql<{ views: number; uniq_paths: number }>(env, totalsQ),
          cfAnalyticsSql<{ t: string; views: number }>(env, seriesQ),
          cfAnalyticsSql<{ path: string; views: number }>(env, pathsQ),
          cfAnalyticsSql<{ referrer: string; views: number }>(env, refsQ),
          cfAnalyticsSql<{ country: string; views: number }>(env, ctyQ),
          cfAnalyticsSql<{ device: string; views: number }>(env, devQ),
        ]);
        const body: StatsRow = {
          total_views: Number(totals[0]?.views ?? 0),
          unique_paths: Number(totals[0]?.uniq_paths ?? 0),
          series: series.map((r) => ({ t: r.t, views: Number(r.views) })),
          top_paths: paths.map((r) => ({ path: r.path, views: Number(r.views) })),
          top_referrers: refs.map((r) => ({ referrer: r.referrer, views: Number(r.views) })),
          top_countries: ctys.map((r) => ({ country: r.country, views: Number(r.views) })),
          device_split: devs.map((r) => ({ device: r.device, views: Number(r.views) })),
        };
        return c.json({ appId, days, kind: kindParam, bucket, path: pathParam || null, stats: body });
      } catch (err) {
        if (err instanceof HttpError) throw err;
        throw new HttpError(err instanceof Error ? err.message : 'stats query failed', 502);
      }
    }),
  );

  // ---------------------------------------------------------------------------
  // Custom events index — lists distinct non-pageview event kinds with counts.
  // Powers the "Custom events" panel in the PAS console analytics dashboard.
  // ---------------------------------------------------------------------------

  analyticsRoutes.get(
    '/apps/:appId/analytics/events',
    wrap(async (c) => {
      const appId = c.req.param('appId')!;
      if (!APP_ID_RE.test(appId)) throw new HttpError('invalid app id', 400);
      await requireAppOwner(c, appId);
      const days = Math.min(
        STATS_DAYS_MAX,
        Math.max(1, Number(c.req.query('days') ?? STATS_DAYS_DEFAULT) | 0),
      );
      const effectiveTime =
        `if(length(doubles) > 1, fromUnixTimestamp64Milli(toInt64(double2)), timestamp)`;
      const sinceClause = `${effectiveTime} > NOW() - INTERVAL '${days}' DAY`;
      const where = `WHERE index1 = '${appId}' AND blob2 != 'pageview' AND ${sinceClause}`;
      const kindsQ = `SELECT blob2 AS kind, SUM(_sample_interval) AS count FROM ${STATS_DATASET} ${where} GROUP BY kind ORDER BY count DESC LIMIT 20`;

      const env = c.env as Env & { CF_ACCOUNT_ID?: string; CF_ANALYTICS_API_TOKEN?: string };
      try {
        const rows = await cfAnalyticsSql<{ kind: string; count: number }>(env, kindsQ);
        const events = rows.map((r) => ({ kind: r.kind, count: Number(r.count) }));
        const total = events.reduce((sum, e) => sum + e.count, 0);
        return c.json({ appId, days, total_events: total, events });
      } catch (err) {
        if (err instanceof HttpError) throw err;
        throw new HttpError(err instanceof Error ? err.message : 'events query failed', 502);
      }
    }),
  );

  // ---------------------------------------------------------------------------
  // Live view: visitors active in the last 5 minutes. Cheap query, dashboard
  // polls it every 30s for a "X right now" counter.
  // ---------------------------------------------------------------------------

  analyticsRoutes.get(
    '/apps/:appId/analytics/live',
    wrap(async (c) => {
      const appId = c.req.param('appId')!;
      if (!APP_ID_RE.test(appId)) throw new HttpError('invalid app id', 400);
      await requireAppOwner(c, appId);
      // Use server-write timestamp (not the effectiveTime two-stage expression)
      // — offline-replayed events legitimately *are* recent network arrivals
      // even if their client-side `t` is older. "Live" means "edge right now."
      const since = `timestamp > NOW() - INTERVAL '5' MINUTE`;
      const where = `WHERE index1 = '${appId}' AND blob2 = 'pageview' AND ${since}`;

      const totalsQ = `SELECT SUM(_sample_interval) AS views, COUNT(DISTINCT blob3) AS uniq_paths FROM ${STATS_DATASET} ${where}`;
      const pathsQ = `SELECT blob3 AS path, SUM(_sample_interval) AS views FROM ${STATS_DATASET} ${where} GROUP BY path ORDER BY views DESC LIMIT 5`;

      const env = c.env as Env & { CF_ACCOUNT_ID?: string; CF_ANALYTICS_API_TOKEN?: string };
      try {
        const [totals, paths] = await Promise.all([
          cfAnalyticsSql<{ views: number; uniq_paths: number }>(env, totalsQ),
          cfAnalyticsSql<{ path: string; views: number }>(env, pathsQ),
        ]);
        return c.json({
          appId,
          window_minutes: 5,
          views: Number(totals[0]?.views ?? 0),
          unique_paths: Number(totals[0]?.uniq_paths ?? 0),
          top_paths: paths.map((r) => ({ path: r.path, views: Number(r.views) })),
        });
      } catch (err) {
        if (err instanceof HttpError) throw err;
        throw new HttpError(err instanceof Error ? err.message : 'live query failed', 502);
      }
    }),
  );

  // ---------------------------------------------------------------------------
  // Admin platform aggregate — cross-app totals + top apps + top countries +
  // daily series. Vendored from FAS shape. Gated on ADMIN_GITHUB_IDS so only
  // the platform operator (not creators) sees the full marketplace view.
  // ---------------------------------------------------------------------------

  analyticsRoutes.get(
    '/analytics/admin/platform',
    wrap(async (c) => {
      await requireAdmin(c);
      const days = Math.min(
        STATS_DAYS_MAX,
        Math.max(1, Number(c.req.query('days') ?? STATS_DAYS_DEFAULT) | 0),
      );
      const bucketParam = (c.req.query('bucket') ?? '').trim().toLowerCase();
      const bucket: 'hour' | 'day' =
        bucketParam === 'hour' || bucketParam === 'day'
          ? bucketParam
          : days <= 1
            ? 'hour'
            : 'day';
      const seriesGroup = bucket === 'hour' ? 'toStartOfHour' : 'toStartOfDay';
      const effectiveTime =
        `if(length(doubles) > 1, fromUnixTimestamp64Milli(toInt64(double2)), timestamp)`;
      const sinceClause = `${effectiveTime} > NOW() - INTERVAL '${days}' DAY`;
      const where = `WHERE blob2 = 'pageview' AND ${sinceClause}`;

      const totalsQ = `SELECT SUM(_sample_interval) AS views, COUNT(DISTINCT blob1) AS active_apps FROM ${STATS_DATASET} ${where}`;
      const seriesQ = `SELECT ${seriesGroup}(${effectiveTime}) AS t, SUM(_sample_interval) AS views FROM ${STATS_DATASET} ${where} GROUP BY t ORDER BY t ASC`;
      const topAppsQ = `SELECT blob1 AS app, SUM(_sample_interval) AS views FROM ${STATS_DATASET} ${where} GROUP BY app ORDER BY views DESC LIMIT 20`;
      const topCtyQ = `SELECT blob5 AS country, SUM(_sample_interval) AS views FROM ${STATS_DATASET} ${where} AND blob5 != '' GROUP BY country ORDER BY views DESC LIMIT 10`;
      const devQ = `SELECT blob6 AS device, SUM(_sample_interval) AS views FROM ${STATS_DATASET} ${where} GROUP BY device`;
      const customQ = `SELECT SUM(_sample_interval) AS c FROM ${STATS_DATASET} WHERE blob2 != 'pageview' AND ${sinceClause}`;

      const env = c.env as Env & { CF_ACCOUNT_ID?: string; CF_ANALYTICS_API_TOKEN?: string };
      try {
        const [totals, series, topApps, topCtys, devs, custom] = await Promise.all([
          cfAnalyticsSql<{ views: number; active_apps: number }>(env, totalsQ),
          cfAnalyticsSql<{ t: string; views: number }>(env, seriesQ),
          cfAnalyticsSql<{ app: string; views: number }>(env, topAppsQ),
          cfAnalyticsSql<{ country: string; views: number }>(env, topCtyQ),
          cfAnalyticsSql<{ device: string; views: number }>(env, devQ),
          cfAnalyticsSql<{ c: number }>(env, customQ),
        ]);
        return c.json({
          days,
          bucket,
          total_views: Number(totals[0]?.views ?? 0),
          active_apps: Number(totals[0]?.active_apps ?? 0),
          custom_events: Number(custom[0]?.c ?? 0),
          series: series.map((r) => ({ t: r.t, views: Number(r.views) })),
          top_apps: topApps.map((r) => ({ app: r.app, views: Number(r.views) })),
          top_countries: topCtys.map((r) => ({ country: r.country, views: Number(r.views) })),
          device_split: devs.map((r) => ({ device: r.device, views: Number(r.views) })),
        });
      } catch (err) {
        if (err instanceof HttpError) throw err;
        throw new HttpError(err instanceof Error ? err.message : 'platform stats failed', 502);
      }
    }),
  );

  // ---------------------------------------------------------------------------
  // Diagnostics — what's blocking analytics from showing data for this app.
  // Called by the dashboard when total_views=0; vendored from FAS shape.
  // ---------------------------------------------------------------------------

  analyticsRoutes.get(
    '/apps/:appId/analytics/diagnostics',
    wrap(async (c) => {
      const appId = c.req.param('appId')!;
      if (!APP_ID_RE.test(appId)) throw new HttpError('invalid app id', 400);
      await requireAppOwner(c, appId);

      const env = c.env as Env & {
        ANALYTICS?: AnalyticsEngineDataset;
        CF_ACCOUNT_ID?: string;
        CF_ANALYTICS_API_TOKEN?: string;
      };

      const row = await loadRow(c, appId);
      const cfBeaconConfigured = !!(row?.cf_beacon_token && CF_TOKEN_RE.test(row.cf_beacon_token));
      const byoConfigured = !!(row?.ga4 || row?.plausible || row?.custom_head);

      const datasetBound = !!env.ANALYTICS;
      const statsQueryable = !!(env.CF_ACCOUNT_ID && env.CF_ANALYTICS_API_TOKEN);

      let eventsEver = false;
      let eventsLast24h = 0;
      if (datasetBound && statsQueryable) {
        try {
          const q = `SELECT SUM(_sample_interval) AS c FROM ${STATS_DATASET} WHERE index1 = '${appId}' AND timestamp > NOW() - INTERVAL '90' DAY`;
          const rows = await cfAnalyticsSql<{ c: number }>(env, q);
          eventsEver = Number(rows[0]?.c ?? 0) > 0;

          const q24 = `SELECT SUM(_sample_interval) AS c FROM ${STATS_DATASET} WHERE index1 = '${appId}' AND blob2 = 'pageview' AND timestamp > NOW() - INTERVAL '1' DAY`;
          const rows24 = await cfAnalyticsSql<{ c: number }>(env, q24);
          eventsLast24h = Number(rows24[0]?.c ?? 0);
        } catch {
          // best-effort
        }
      }

      let verdict:
        | 'ok'
        | 'never_seen_event'
        | 'no_dataset_binding'
        | 'no_stats_query'
        | 'silent_24h';
      if (!datasetBound) verdict = 'no_dataset_binding';
      else if (!statsQueryable) verdict = 'no_stats_query';
      else if (!eventsEver) verdict = 'never_seen_event';
      else if (eventsLast24h === 0) verdict = 'silent_24h';
      else verdict = 'ok';

      return c.json({
        appId,
        verdict,
        checks: {
          cf_beacon_configured: cfBeaconConfigured,
          byo_tag_configured: byoConfigured,
          dataset_bound: datasetBound,
          stats_queryable: statsQueryable,
          events_ever: eventsEver,
          events_last_24h: eventsLast24h,
        },
        loader_url: `https://api.proappstore.online/v1/analytics.js?app=${appId}`,
      });
    }),
  );
}
