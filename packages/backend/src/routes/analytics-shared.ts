// Shared constants, types, and helpers for the ProAppStore analytics routes.
// Extracted verbatim from analytics.ts so the route file stays focused on
// wiring; logic is unchanged.

import type { Context } from 'hono';
import { HttpError } from '../lib/auth.js';
import { ANALYTICS_DATASET } from '../lib/telemetry-datasets.js';
import type { Env } from '../types.js';

export type Ctx = Context<{ Bindings: Env }>;

export const GA4_RE = /^G-[A-Z0-9]{6,12}$/i;
export const DOMAIN_RE = /^[a-z0-9][a-z0-9.-]{0,253}\.[a-z]{2,}$/i;
export const CF_TOKEN_RE = /^[a-f0-9]{32,}$/i;
export { APP_ID_RE } from './validation.js';
export const CUSTOM_HEAD_MAX = 4096;

export const EVENT_KIND_RE = /^[a-z][a-z0-9_]{0,31}$/;

export interface AnalyticsRow {
  cf_beacon_token: string | null;
  ga4: string | null;
  plausible: string | null;
  custom_head: string | null;
  updated_at: number | null;
}

export interface AnalyticsBody {
  ga4?: string | null;
  plausible?: string | null;
  custom_head?: string | null;
}

export function rowToJson(row: AnalyticsRow | null) {
  return {
    cfBeaconToken: row?.cf_beacon_token ?? null,
    ga4: row?.ga4 ?? null,
    plausible: row?.plausible ?? null,
    customHead: row?.custom_head ?? null,
    updatedAt: row?.updated_at ?? null,
  };
}

export async function loadRow(c: Ctx, appId: string): Promise<AnalyticsRow | null> {
  return await c.env.DB.prepare(
    `SELECT cf_beacon_token, ga4, plausible, custom_head, updated_at
     FROM app_analytics WHERE app_id = ?`,
  )
    .bind(appId)
    .first<AnalyticsRow>();
}

export function normalize(v: string | null | undefined): string | null {
  if (v == null) return null;
  const trimmed = String(v).trim();
  return trimmed === '' ? null : trimmed;
}

export { wrap } from '../lib/route-wrap.js';

// -----------------------------------------------------------------------------
// Stats query shared bits: aggregates from Workers Analytics Engine via the
// SQL API. Powers the in-platform analytics dashboard.
// -----------------------------------------------------------------------------

export const STATS_DAYS_DEFAULT = 7;
export const STATS_DAYS_MAX = 90;
/** The dataset stats queries read. Must match the wrangler.toml `ANALYTICS`
 *  binding's dataset — hence the shared constant. Was hardcoded to
 *  `pas_app_analytics` while writes went to `pas_analytics`, so every stats
 *  query read an empty table. See lib/telemetry-datasets.ts. */
export const STATS_DATASET = ANALYTICS_DATASET;

/**
 * An event's effective time (#349): the client-recorded `t` (epoch ms, the
 * second double written by analytics-ingest.ts) for offline-replayed events,
 * else the server-write `timestamp`. Analytics Engine SQL exposes each double as
 * its own column (`double1`…`double20`; there is no `doubles` array) and
 * supports neither `length()`, `CAST`, `toInt64` nor `fromUnixTimestamp64Milli`,
 * so every earlier form of this expression was refused and the dashboard
 * answered 502. Rows written before the second double read `double2` as 0 and
 * fall back to `timestamp`. Only documented functions: if, toDateTime (epoch
 * seconds), toUInt32, and `/`.
 */
export const EFFECTIVE_TIME = 'if(double2 > 0, toDateTime(toUInt32(double2 / 1000)), timestamp)';

export interface StatsRow {
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

export async function cfAnalyticsSql<T = Record<string, unknown>>(
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
