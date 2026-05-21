// Per-app visitor analytics for ProAppStore. Vendored from the FAS shape
// (see fas/platform/packages/backend/src/routes/analytics.ts) — "vendor,
// don't depend" per workspace convention.
//
//   * Public loader: GET /v1/analytics.js?app=<id>
//     Returns small JavaScript that injects Cloudflare Web Analytics
//     plus any creator-configured BYO tags (GA4, Plausible, custom <head>)
//     into the page. Pro apps will also stream an aggregated page-view
//     event to Workers Analytics Engine in a follow-up so Pro creators
//     get a first-party in-platform dashboard (TODO: wire ANALYTICS binding).
//
//   * Creator-protected CRUD:
//     GET  /v1/apps/:appId/analytics — read current settings
//     PUT  /v1/apps/:appId/analytics — update settings (cf_beacon_token
//                                       stays admin-managed)

import { type Context, Hono } from 'hono';
import { HttpError, requireAdmin, requireAppOwner } from '../lib/auth.js';
import type { Env } from '../types.js';

export const analyticsRoutes = new Hono<{ Bindings: Env }>();

type Ctx = Context<{ Bindings: Env }>;

const GA4_RE = /^G-[A-Z0-9]{6,12}$/i;
const DOMAIN_RE = /^[a-z0-9][a-z0-9.-]{0,253}\.[a-z]{2,}$/i;
const CF_TOKEN_RE = /^[a-f0-9]{32,}$/i;
const APP_ID_RE = /^[a-z][a-z0-9-]{1,30}$/;
const CUSTOM_HEAD_MAX = 4096;

interface AnalyticsRow {
  cf_beacon_token: string | null;
  ga4: string | null;
  plausible: string | null;
  custom_head: string | null;
  updated_at: number | null;
}

interface AnalyticsBody {
  ga4?: string | null;
  plausible?: string | null;
  custom_head?: string | null;
}

function rowToJson(row: AnalyticsRow | null) {
  return {
    cfBeaconToken: row?.cf_beacon_token ?? null,
    ga4: row?.ga4 ?? null,
    plausible: row?.plausible ?? null,
    customHead: row?.custom_head ?? null,
    updatedAt: row?.updated_at ?? null,
  };
}

async function loadRow(c: Ctx, appId: string): Promise<AnalyticsRow | null> {
  return await c.env.DB.prepare(
    `SELECT cf_beacon_token, ga4, plausible, custom_head, updated_at
     FROM app_analytics WHERE app_id = ?`,
  )
    .bind(appId)
    .first<AnalyticsRow>();
}

function normalize(v: string | null | undefined): string | null {
  if (v == null) return null;
  const trimmed = String(v).trim();
  return trimmed === '' ? null : trimmed;
}

function wrap(handler: (c: Ctx) => Promise<Response>) {
  return async (c: Ctx) => {
    try {
      return await handler(c);
    } catch (err) {
      if (err instanceof HttpError) return c.text(err.message, err.status as 401);
      throw err;
    }
  };
}

// -----------------------------------------------------------------------------
// Creator-protected: read + write analytics config
// -----------------------------------------------------------------------------

analyticsRoutes.get(
  '/apps/:appId/analytics',
  wrap(async (c) => {
    const appId = c.req.param('appId')!;
    await requireAppOwner(c, appId);
    const row = await loadRow(c, appId);
    return c.json(rowToJson(row));
  }),
);

analyticsRoutes.put(
  '/apps/:appId/analytics',
  wrap(async (c) => {
    const appId = c.req.param('appId')!;
    await requireAppOwner(c, appId);
    let body: AnalyticsBody;
    try {
      body = (await c.req.json()) as AnalyticsBody;
    } catch {
      throw new HttpError('invalid json', 400);
    }

    const ga4 = normalize(body.ga4);
    const plausible = normalize(body.plausible);
    const customHead = normalize(body.custom_head);

    if (ga4 && !GA4_RE.test(ga4)) throw new HttpError('invalid ga4 measurement id', 400);
    if (plausible && !DOMAIN_RE.test(plausible))
      throw new HttpError('invalid plausible domain', 400);
    if (customHead && customHead.length > CUSTOM_HEAD_MAX)
      throw new HttpError(`custom_head exceeds ${CUSTOM_HEAD_MAX} bytes`, 400);

    const existing = await loadRow(c, appId);
    await c.env.DB.prepare(
      `INSERT INTO app_analytics (app_id, cf_beacon_token, ga4, plausible, custom_head, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(app_id) DO UPDATE SET
         ga4 = excluded.ga4,
         plausible = excluded.plausible,
         custom_head = excluded.custom_head,
         updated_at = excluded.updated_at`,
    )
      .bind(appId, existing?.cf_beacon_token ?? null, ga4, plausible, customHead, Date.now())
      .run();

    const fresh = await loadRow(c, appId);
    return c.json(rowToJson(fresh));
  }),
);

// -----------------------------------------------------------------------------
// Internal: admin Worker writes the CF Web Analytics site_token here after
// minting it via the CF API. Authenticated via a shared X-Internal-Token
// header. Bypasses requireAppOwner — admin runs this at provision time.
// -----------------------------------------------------------------------------

analyticsRoutes.put('/internal/apps/:appId/analytics/cf-token', async (c) => {
  const appId = c.req.param('appId')!;
  if (!APP_ID_RE.test(appId)) return c.text('invalid app id', 400);
  const provided = c.req.header('X-Internal-Token');
  const expected = (c.env as Env & { INTERNAL_TOKEN?: string }).INTERNAL_TOKEN;
  if (!expected || provided !== expected) return c.text('forbidden', 403);

  let body: { cf_beacon_token?: string };
  try {
    body = await c.req.json();
  } catch {
    return c.text('invalid json', 400);
  }
  const token = (body.cf_beacon_token ?? '').trim();
  if (!CF_TOKEN_RE.test(token)) return c.text('invalid cf_beacon_token', 400);

  await c.env.DB.prepare(
    `INSERT INTO app_analytics (app_id, cf_beacon_token, ga4, plausible, custom_head, updated_at)
     VALUES (?, ?, NULL, NULL, NULL, ?)
     ON CONFLICT(app_id) DO UPDATE SET
       cf_beacon_token = excluded.cf_beacon_token,
       updated_at = excluded.updated_at`,
  )
    .bind(appId, token, Date.now())
    .run();
  return c.json({ ok: true, appId, cfBeaconToken: token });
});

// -----------------------------------------------------------------------------
// Stats query (creator-only): aggregates from Workers Analytics Engine via
// the SQL API. Powers the in-platform analytics dashboard.
// -----------------------------------------------------------------------------

const STATS_DAYS_DEFAULT = 7;
const STATS_DAYS_MAX = 90;
const STATS_DATASET = 'pas_app_analytics';

interface StatsRow {
  total_views: number;
  unique_paths: number;
  /** Time series — entries are `{t, views}` where `t` is a YYYY-MM-DD
   *  for bucket=day, YYYY-MM-DD HH:00:00 for bucket=hour. The envelope's
   *  `bucket` field tells you which to expect. */
  series: Array<{ t: string; views: number }>;
  top_paths: Array<{ path: string; views: number }>;
  top_referrers: Array<{ referrer: string; views: number }>;
  top_countries: Array<{ country: string; views: number }>;
  device_split: Array<{ device: string; views: number }>;
}

async function cfAnalyticsSql<T = Record<string, unknown>>(
  env: Env & { CF_ACCOUNT_ID?: string; CF_ANALYTICS_API_TOKEN?: string },
  sql: string,
): Promise<T[]> {
  if (!env.CF_ACCOUNT_ID || !env.CF_ANALYTICS_API_TOKEN) {
    throw new HttpError('stats not configured (missing CF_ACCOUNT_ID/CF_ANALYTICS_API_TOKEN)', 503);
  }
  const res = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}/analytics_engine/sql`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.CF_ANALYTICS_API_TOKEN}`,
        'Content-Type': 'text/plain',
      },
      body: sql,
    },
  );
  if (!res.ok) {
    const detail = await res.text().catch(() => res.statusText);
    throw new HttpError(`CF Analytics SQL failed (${res.status}): ${detail.slice(0, 200)}`, 502);
  }
  const json = (await res.json()) as { data?: T[] };
  return json.data ?? [];
}

analyticsRoutes.get(
  '/apps/:appId/analytics/stats',
  wrap(async (c) => {
    const appId = c.req.param('appId')!;
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
    const where = `WHERE index1 = '${appId}' AND blob2 = '${kindParam}' AND ${sinceClause}`;

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
      return c.json({ appId, days, kind: kindParam, bucket, stats: body });
    } catch (err) {
      if (err instanceof HttpError) throw err;
      throw new HttpError(err instanceof Error ? err.message : 'stats query failed', 502);
    }
  }),
);

// -----------------------------------------------------------------------------
// Custom events index — lists distinct non-pageview event kinds with counts.
// Powers the "Custom events" panel in the PAS console analytics dashboard.
// -----------------------------------------------------------------------------

analyticsRoutes.get(
  '/apps/:appId/analytics/events',
  wrap(async (c) => {
    const appId = c.req.param('appId')!;
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

// -----------------------------------------------------------------------------
// Live view: visitors active in the last 5 minutes. Cheap query, dashboard
// polls it every 30s for a "X right now" counter.
// -----------------------------------------------------------------------------

analyticsRoutes.get(
  '/apps/:appId/analytics/live',
  wrap(async (c) => {
    const appId = c.req.param('appId')!;
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

// -----------------------------------------------------------------------------
// Admin platform aggregate — cross-app totals + top apps + top countries +
// daily series. Vendored from FAS shape. Gated on ADMIN_GITHUB_IDS so only
// the platform operator (not creators) sees the full marketplace view.
// -----------------------------------------------------------------------------

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

// -----------------------------------------------------------------------------
// Diagnostics — what's blocking analytics from showing data for this app.
// Called by the dashboard when total_views=0; vendored from FAS shape.
// -----------------------------------------------------------------------------

analyticsRoutes.get(
  '/apps/:appId/analytics/diagnostics',
  wrap(async (c) => {
    const appId = c.req.param('appId')!;
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

    let verdict: 'ok' | 'never_seen_event' | 'no_dataset_binding' | 'no_stats_query' | 'silent_24h';
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

// -----------------------------------------------------------------------------
// Event ingest — first-party page-view + custom-event beacons from the
// platform loader. Writes one row per event into Workers Analytics Engine.
// No PII recorded (no IP, no full UA, no full referrer URL).
// -----------------------------------------------------------------------------

const EVENT_KIND_RE = /^[a-z][a-z0-9_]{0,31}$/;
const PATH_MAX = 256;
const REFERRER_HOST_MAX = 120;
const PROPS_MAX = 8;

interface EventBody {
  app?: string;
  kind?: string;
  path?: string;
  referrer?: string;
  props?: Record<string, unknown>;
  /** Client-recorded event time (epoch ms). Lets offline-replayed events
   *  land on the day they actually happened, not the flush day. */
  t?: number;
  /** Batch wrapper: each entry is treated as a single EventBody (with `t`).
   *  Used by the loader to drain its IndexedDB outbox in one POST. */
  events?: EventBody[];
}

const MAX_BATCH = 100;
const T_WINDOW_MS = 72 * 60 * 60 * 1000; // accept replays up to 72h old

function effectiveTimestamp(t: number | undefined, nowMs: number): number {
  if (typeof t !== 'number' || !Number.isFinite(t)) return nowMs;
  if (t > nowMs + 5 * 60 * 1000) return nowMs;
  if (t < nowMs - T_WINDOW_MS) return nowMs;
  return t;
}

function classifyUA(ua: string | null): 'bot' | 'mobile' | 'desktop' {
  if (!ua) return 'desktop';
  if (/bot|crawler|spider|curl|wget|python|node/i.test(ua)) return 'bot';
  if (/iphone|android|mobile/i.test(ua)) return 'mobile';
  return 'desktop';
}

function safeReferrerHost(raw: string | null | undefined): string {
  if (!raw) return '';
  try {
    const u = new URL(raw);
    return u.hostname.slice(0, REFERRER_HOST_MAX);
  } catch {
    return '';
  }
}

function flattenProps(props: Record<string, unknown> | undefined): string {
  if (!props) return '';
  const entries = Object.entries(props).slice(0, PROPS_MAX);
  const out: Record<string, string> = {};
  for (const [k, v] of entries) {
    if (k.length > 32) continue;
    out[k] = String(v).slice(0, 64);
  }
  return JSON.stringify(out);
}

// Per-(app, IP, kind) sampling cap (in-isolate, ~50 events/10s).
const SAMPLE_BUCKET_SECONDS = 10;
const SAMPLE_MAX_PER_BUCKET = 50;
const sampleBuckets = new Map<string, { windowStart: number; count: number }>();

function shouldAccept(key: string, now: number): boolean {
  const windowStart = Math.floor(now / 1000 / SAMPLE_BUCKET_SECONDS) * SAMPLE_BUCKET_SECONDS;
  const cur = sampleBuckets.get(key);
  if (!cur || cur.windowStart !== windowStart) {
    sampleBuckets.set(key, { windowStart, count: 1 });
    if (sampleBuckets.size > 1024) sampleBuckets.clear();
    return true;
  }
  cur.count += 1;
  return cur.count <= SAMPLE_MAX_PER_BUCKET;
}

analyticsRoutes.post('/analytics/event', async (c) => {
  let body: EventBody;
  try {
    body = await c.req.json();
  } catch {
    return c.text('invalid json', 400);
  }

  const ua = c.req.header('user-agent') ?? null;
  const uaClass = classifyUA(ua);
  if (uaClass === 'bot') return new Response(null, { status: 204 });

  const ip = c.req.header('cf-connecting-ip') ?? '';
  const country =
    (c.req.raw as Request & { cf?: { country?: string } }).cf?.country?.slice(0, 2) ?? '';
  const dataset = (c.env as Env & { ANALYTICS?: AnalyticsEngineDataset }).ANALYTICS;

  // Body can be a single event or { events: [...] } — the loader drains its
  // IndexedDB outbox by POSTing the batched form when it reconnects.
  const items: EventBody[] = Array.isArray(body.events) ? body.events.slice(0, MAX_BATCH) : [body];
  const nowMs = Date.now();
  let accepted = 0;
  for (const item of items) {
    const appId = (item.app ?? '').trim();
    if (!APP_ID_RE.test(appId)) continue;
    const kind = (item.kind ?? 'pageview').trim().toLowerCase();
    if (!EVENT_KIND_RE.test(kind)) continue;
    if (!shouldAccept(`${appId}:${ip}:${kind}`, nowMs)) continue;
    if (!dataset) {
      accepted++;
      continue;
    }
    const path = (item.path ?? '/').slice(0, PATH_MAX);
    const referrerHost = safeReferrerHost(item.referrer);
    const t = effectiveTimestamp(item.t, nowMs);
    dataset.writeDataPoint({
      indexes: [appId],
      blobs: [appId, kind, path, referrerHost, country, uaClass, flattenProps(item.props)],
      doubles: [1, t],
    });
    accepted++;
  }
  return new Response(null, { status: 204, headers: { 'x-events-accepted': String(accepted) } });
});

// -----------------------------------------------------------------------------
// Public loader: returns JS that injects analytics tags
// -----------------------------------------------------------------------------

export function buildLoaderJs(
  row: AnalyticsRow | null,
  appId: string,
  apiBase = 'https://api.proappstore.online',
): string {
  const parts: string[] = [];
  if (row?.cf_beacon_token && CF_TOKEN_RE.test(row.cf_beacon_token)) {
    parts.push(
      `_pasAnalytics.script("https://static.cloudflareinsights.com/beacon.min.js",{defer:true,"data-cf-beacon":${JSON.stringify(JSON.stringify({ token: row.cf_beacon_token }))}});`,
    );
  }
  if (row?.ga4 && GA4_RE.test(row.ga4)) {
    const id = JSON.stringify(row.ga4);
    parts.push(
      `_pasAnalytics.script("https://www.googletagmanager.com/gtag/js?id="+${id},{async:true});`,
      `_pasAnalytics.inline("window.dataLayer=window.dataLayer||[];function gtag(){dataLayer.push(arguments);}gtag('js',new Date());gtag('config',"+${id}+");");`,
    );
  }
  if (row?.plausible && DOMAIN_RE.test(row.plausible)) {
    const domain = JSON.stringify(row.plausible);
    parts.push(
      `_pasAnalytics.script("https://plausible.io/js/script.js",{defer:true,"data-domain":${domain}});`,
    );
  }
  if (row?.custom_head && row.custom_head.length <= CUSTOM_HEAD_MAX) {
    parts.push(`_pasAnalytics.raw(${JSON.stringify(row.custom_head)});`);
  }
  // First-party event pipeline with IndexedDB offline buffer + drain-on-reconnect.
  // Each event carries client-recorded timestamp so replayed events land on
  // the right day in the dashboard.
  const beaconBase = JSON.stringify(apiBase);
  const idLit = JSON.stringify(appId);
  parts.push(`(function(){
    var URL = ${beaconBase}+"/v1/analytics/event";
    var APP = ${idLit};
    var DB_NAME = "pasA", STORE = "outbox", MAX_BUFFER = 200;
    function openDB(){
      return new Promise(function(res, rej){
        try{
          var r = indexedDB.open(DB_NAME, 1);
          r.onupgradeneeded = function(e){ e.target.result.createObjectStore(STORE,{keyPath:"id",autoIncrement:true}); };
          r.onsuccess = function(){ res(r.result); };
          r.onerror = function(){ rej(); };
        }catch(e){ rej(); }
      });
    }
    function buffer(evt){
      openDB().then(function(db){
        try{
          var tx = db.transaction(STORE, "readwrite");
          var s = tx.objectStore(STORE);
          var c = s.count();
          c.onsuccess = function(){ if (c.result < MAX_BUFFER) s.add(evt); };
        }catch(e){}
      }).catch(function(){});
    }
    function postBatch(events){
      if (!events.length) return Promise.resolve(true);
      var body = JSON.stringify({events: events});
      if (navigator.sendBeacon && navigator.sendBeacon(URL, body)) return Promise.resolve(true);
      return fetch(URL,{method:"POST",headers:{"Content-Type":"application/json"},body:body,keepalive:true})
        .then(function(r){ return r.ok; }).catch(function(){ return false; });
    }
    function drain(){
      openDB().then(function(db){
        try{
          var tx = db.transaction(STORE, "readwrite");
          var s = tx.objectStore(STORE);
          var req = s.getAll();
          req.onsuccess = function(){
            var rows = req.result || [];
            if (!rows.length) return;
            postBatch(rows.map(function(r){ return r.evt; })).then(function(ok){
              if (!ok) return;
              var tx2 = db.transaction(STORE, "readwrite");
              tx2.objectStore(STORE).clear();
            });
          };
        }catch(e){}
      }).catch(function(){});
    }
    function send(kind, props){
      var evt = {app:APP,kind:kind,path:location.pathname,referrer:document.referrer,props:props||null,t:Date.now()};
      if (navigator.onLine === false) { buffer(evt); return; }
      try{
        var body = JSON.stringify(evt);
        var ok = navigator.sendBeacon ? navigator.sendBeacon(URL, body) : false;
        if (!ok) {
          fetch(URL,{method:"POST",headers:{"Content-Type":"application/json"},body:body,keepalive:true})
            .catch(function(){ buffer(evt); });
        }
      }catch(e){ buffer(evt); }
    }
    send("pageview");
    drain();
    window.addEventListener("online", drain);
    window.pasAnalytics = window.pasAnalytics || {};
    window.pasAnalytics.event = function(kind, props){ send(String(kind||"event"), props); };
    var _push = history.pushState, _replace = history.replaceState;
    history.pushState = function(){ _push.apply(this, arguments); send("pageview"); };
    history.replaceState = function(){ _replace.apply(this, arguments); send("pageview"); };
    window.addEventListener("popstate", function(){ send("pageview"); });
  })();`);
  return `(function(){
  var _pasAnalytics = {
    script: function(src, attrs){
      var s = document.createElement("script");
      s.src = src;
      for (var k in attrs) { if (attrs[k] === true) s.setAttribute(k,""); else s.setAttribute(k, attrs[k]); }
      document.head.appendChild(s);
    },
    inline: function(code){
      var s = document.createElement("script");
      s.text = code;
      document.head.appendChild(s);
    },
    raw: function(html){
      var t = document.createElement("template");
      t.innerHTML = html;
      while (t.content.firstChild) document.head.appendChild(t.content.firstChild);
    }
  };
  ${parts.join('\n  ')}
})();
`;
}

const LOADER_CACHE_TTL_SECONDS = 3600;

analyticsRoutes.get('/analytics.js', async (c) => {
  const appId = c.req.query('app') ?? '';
  if (!APP_ID_RE.test(appId)) {
    return new Response('/* invalid app id */\n', { status: 200, headers: jsHeaders() });
  }
  // Worker cache hit short-circuits the D1 lookup — most page views never
  // touch the origin, which is the single biggest cost saving in the loader path.
  const cacheUrl = `https://loader-cache/${appId}`;
  const cache = caches.default;
  const cached = await cache.match(cacheUrl);
  if (cached) return cached;

  const row = await loadRow(c, appId);
  const body = buildLoaderJs(row, appId);
  const res = new Response(body, { status: 200, headers: jsHeaders() });
  c.executionCtx.waitUntil(cache.put(cacheUrl, res.clone()));
  return res;
});

function jsHeaders(): Record<string, string> {
  return {
    'content-type': 'application/javascript; charset=utf-8',
    'cache-control': `public, max-age=${LOADER_CACHE_TTL_SECONDS}, s-maxage=${LOADER_CACHE_TTL_SECONDS}`,
    'access-control-allow-origin': '*',
  };
}
