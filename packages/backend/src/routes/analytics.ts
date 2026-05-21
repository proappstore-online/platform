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
import { HttpError, requireAppOwner } from '../lib/auth.js';
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
  daily: Array<{ day: string; views: number }>;
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
    const sinceClause = `timestamp > NOW() - INTERVAL '${days}' DAY`;
    const where = `WHERE index1 = '${appId}' AND blob2 = 'pageview' AND ${sinceClause}`;

    const totalsQ = `SELECT SUM(_sample_interval) AS views, COUNT(DISTINCT blob3) AS uniq_paths FROM ${STATS_DATASET} ${where}`;
    const dailyQ = `SELECT toStartOfDay(timestamp) AS day, SUM(_sample_interval) AS views FROM ${STATS_DATASET} ${where} GROUP BY day ORDER BY day ASC`;
    const pathsQ = `SELECT blob3 AS path, SUM(_sample_interval) AS views FROM ${STATS_DATASET} ${where} GROUP BY path ORDER BY views DESC LIMIT 10`;
    const refsQ = `SELECT blob4 AS referrer, SUM(_sample_interval) AS views FROM ${STATS_DATASET} ${where} AND blob4 != '' GROUP BY referrer ORDER BY views DESC LIMIT 10`;
    const ctyQ = `SELECT blob5 AS country, SUM(_sample_interval) AS views FROM ${STATS_DATASET} ${where} AND blob5 != '' GROUP BY country ORDER BY views DESC LIMIT 10`;
    const devQ = `SELECT blob6 AS device, SUM(_sample_interval) AS views FROM ${STATS_DATASET} ${where} GROUP BY device`;

    const env = c.env as Env & { CF_ACCOUNT_ID?: string; CF_ANALYTICS_API_TOKEN?: string };
    try {
      const [totals, daily, paths, refs, ctys, devs] = await Promise.all([
        cfAnalyticsSql<{ views: number; uniq_paths: number }>(env, totalsQ),
        cfAnalyticsSql<{ day: string; views: number }>(env, dailyQ),
        cfAnalyticsSql<{ path: string; views: number }>(env, pathsQ),
        cfAnalyticsSql<{ referrer: string; views: number }>(env, refsQ),
        cfAnalyticsSql<{ country: string; views: number }>(env, ctyQ),
        cfAnalyticsSql<{ device: string; views: number }>(env, devQ),
      ]);
      const body: StatsRow = {
        total_views: Number(totals[0]?.views ?? 0),
        unique_paths: Number(totals[0]?.uniq_paths ?? 0),
        daily: daily.map((r) => ({ day: r.day, views: Number(r.views) })),
        top_paths: paths.map((r) => ({ path: r.path, views: Number(r.views) })),
        top_referrers: refs.map((r) => ({ referrer: r.referrer, views: Number(r.views) })),
        top_countries: ctys.map((r) => ({ country: r.country, views: Number(r.views) })),
        device_split: devs.map((r) => ({ device: r.device, views: Number(r.views) })),
      };
      return c.json({ appId, days, stats: body });
    } catch (err) {
      if (err instanceof HttpError) throw err;
      throw new HttpError(err instanceof Error ? err.message : 'stats query failed', 502);
    }
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
  const appId = (body.app ?? '').trim();
  if (!APP_ID_RE.test(appId)) return c.text('invalid app', 400);

  const kind = (body.kind ?? 'pageview').trim().toLowerCase();
  if (!EVENT_KIND_RE.test(kind)) return c.text('invalid kind', 400);

  const ua = c.req.header('user-agent') ?? null;
  const uaClass = classifyUA(ua);
  // Drop bots before writing — saves AE writes on traffic creators don't care about.
  if (uaClass === 'bot') return new Response(null, { status: 204 });

  const ip = c.req.header('cf-connecting-ip') ?? '';
  if (!shouldAccept(`${appId}:${ip}:${kind}`, Date.now())) {
    return new Response(null, { status: 204 });
  }

  const path = (body.path ?? '/').slice(0, PATH_MAX);
  const referrerHost = safeReferrerHost(body.referrer);
  const country =
    (c.req.raw as Request & { cf?: { country?: string } }).cf?.country?.slice(0, 2) ?? '';

  const dataset = (c.env as Env & { ANALYTICS?: AnalyticsEngineDataset }).ANALYTICS;
  if (!dataset) return new Response(null, { status: 204 });
  dataset.writeDataPoint({
    indexes: [appId],
    blobs: [appId, kind, path, referrerHost, country, uaClass, flattenProps(body.props)],
    doubles: [1],
  });
  return new Response(null, { status: 204 });
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
  // First-party page-view + custom event beacon. Always emits, even without
  // configured BYO tags — powers the in-platform creator dashboard.
  const beaconBase = JSON.stringify(apiBase);
  const idLit = JSON.stringify(appId);
  parts.push(`(function(){
    function send(kind, props){
      try {
        var body = JSON.stringify({app:${idLit},kind:kind,path:location.pathname,referrer:document.referrer,props:props||null});
        if (navigator.sendBeacon) navigator.sendBeacon(${beaconBase}+"/v1/analytics/event", body);
        else fetch(${beaconBase}+"/v1/analytics/event",{method:"POST",headers:{"Content-Type":"application/json"},body:body,keepalive:true}).catch(function(){});
      } catch(e){}
    }
    send("pageview");
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
