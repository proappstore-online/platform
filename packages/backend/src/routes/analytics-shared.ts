// Shared constants, types, and helpers for the ProAppStore analytics routes.
// Extracted verbatim from analytics.ts so the route file stays focused on
// wiring; logic is unchanged.

import type { Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { HttpError } from '../lib/auth.js';
import type { Env } from '../types.js';

export type Ctx = Context<{ Bindings: Env }>;

export const GA4_RE = /^G-[A-Z0-9]{6,12}$/i;
export const DOMAIN_RE = /^[a-z0-9][a-z0-9.-]{0,253}\.[a-z]{2,}$/i;
export const CF_TOKEN_RE = /^[a-f0-9]{32,}$/i;
export const APP_ID_RE = /^[a-z][a-z0-9-]{1,30}$/;
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

export function wrap(handler: (c: Ctx) => Promise<Response>) {
  return async (c: Ctx) => {
    try {
      return await handler(c);
    } catch (err) {
      if (err instanceof HttpError) return c.text(err.message, err.status as ContentfulStatusCode);
      throw err;
    }
  };
}

// -----------------------------------------------------------------------------
// Stats query shared bits: aggregates from Workers Analytics Engine via the
// SQL API. Powers the in-platform analytics dashboard.
// -----------------------------------------------------------------------------

export const STATS_DAYS_DEFAULT = 7;
export const STATS_DAYS_MAX = 90;
export const STATS_DATASET = 'pas_app_analytics';

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
