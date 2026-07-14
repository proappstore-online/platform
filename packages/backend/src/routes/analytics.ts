// Per-app visitor analytics for ProAppStore. Vendored from the FAS shape
// (see fas/platform/packages/backend/src/routes/analytics.ts) — "vendor,
// don't depend" per workspace convention.
//
//   * Public loader: GET /v1/analytics.js?app=<id>
//     Returns small JavaScript that injects Cloudflare Web Analytics
//     plus any creator-configured BYO tags (GA4, Plausible, custom <head>)
//     into the page. Pro apps will also stream an aggregated page-view
//     event to Workers Analytics Engine in a follow-up so Pro creators
//     get a first-party in-platform dashboard (ANALYTICS binding wired in wrangler.toml).
//
//   * Creator-protected CRUD:
//     GET  /v1/apps/:appId/analytics — read current settings
//     PUT  /v1/apps/:appId/analytics — update settings (cf_beacon_token
//                                       stays admin-managed)

import { Hono } from 'hono';
import { HttpError, requireAppOwner } from '../lib/auth.js';
import { internalTokenOk } from '@proappstore/build-core';
import type { Env } from '../types.js';
import { registerEventIngestRoute } from './analytics-ingest.js';
import { buildLoaderJs } from './analytics-loader.js';
import {
  APP_ID_RE,
  type AnalyticsBody,
  CF_TOKEN_RE,
  CUSTOM_HEAD_MAX,
  DOMAIN_RE,
  GA4_RE,
  loadRow,
  normalize,
  rowToJson,
  wrap,
} from './analytics-shared.js';
import { registerStatsRoutes } from './analytics-stats-routes.js';

export { buildLoaderJs };

export const analyticsRoutes = new Hono<{ Bindings: Env }>();

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
  const expected = (c.env as Env & { INTERNAL_TOKEN?: string }).INTERNAL_TOKEN;
  if (!internalTokenOk(c.req.header('X-Internal-Token'), expected)) return c.text('forbidden', 403);

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
// Read-only dashboard routes — stats, custom events, live view, admin platform
// aggregate, and diagnostics. All aggregate from Workers Analytics Engine.
// -----------------------------------------------------------------------------

registerStatsRoutes(analyticsRoutes);

// -----------------------------------------------------------------------------
// Event ingest — first-party page-view + custom-event beacons from the
// platform loader. Writes one row per event into Workers Analytics Engine.
// No PII recorded (no IP, no full UA, no full referrer URL).
// -----------------------------------------------------------------------------

registerEventIngestRoute(analyticsRoutes);

// -----------------------------------------------------------------------------
// Public loader: returns JS that injects analytics tags
// -----------------------------------------------------------------------------

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
