import { Hono } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import type { Env } from '../types.js';
import { requireUser, HttpError } from '../lib/auth.js';

/**
 * Creator payout preview — what would this month's payout be if usage froze
 * right now and the cron ran?
 *
 * The actual payout cron isn't wired yet; this endpoint computes the same
 * math from usage_daily so creators get a credible preview. Important
 * caveats:
 *
 *   - We assume every active user is a paid subscriber. In reality you'd
 *     join with the `subscriptions` table; for now most "users" in
 *     usage_daily are dogfood/test accounts and a strict join would render
 *     $0 for everyone. The Console explains the caveat alongside the number.
 *
 *   - We hard-code the $5 subscriber price + 10% platform fee. When the
 *     pricing endpoint is configurable, this will read from there.
 *
 *   - Per-subscriber weighting: a user who spends 80% of their session time
 *     in app A contributes 80% × $4.50 = $3.60 to app A. Sum across
 *     subscribers gives the app's pool share; sum across the creator's
 *     owned apps gives their payout.
 */
export const payoutsRoutes = new Hono<{ Bindings: Env }>();

const SUBSCRIBER_PRICE_CENTS = 500;
const PLATFORM_FEE_BPS = 1000; // 10%
const PER_SUBSCRIBER_POOL_CENTS = Math.round(
  (SUBSCRIBER_PRICE_CENTS * (10000 - PLATFORM_FEE_BPS)) / 10000,
); // 450

interface UsageRow {
  user_id: string;
  app_id: string;
  sec: number;
}

interface MonthBucket {
  /** YYYY-MM */
  month: string;
  /** YYYY-MM-01 */
  startDay: string;
  /** YYYY-MM-<last day> */
  endDay: string;
  /** True for the still-in-progress current month. */
  isCurrent: boolean;
  /** Days elapsed in the current month, or total days in past months. */
  daysCovered: number;
  /** Total days in the calendar month (always 28–31). */
  totalDays: number;
}

interface MonthPreview {
  month: string;
  isCurrent: boolean;
  daysCovered: number;
  totalDays: number;
  activeUsers: number;
  estimatedCents: number;
  perApp: { appId: string; estimatedCents: number }[];
}

interface PreviewResponse {
  subscriberPriceCents: number;
  platformFeeBps: number;
  perSubscriberPoolCents: number;
  months: MonthPreview[];
}

function utcDayKey(now: number = Date.now()): string {
  return new Date(now).toISOString().slice(0, 10);
}

function daysInMonth(year: number, month1Based: number): number {
  return new Date(Date.UTC(year, month1Based, 0)).getUTCDate();
}

function computeMonthBuckets(todayKey: string, count: number): MonthBucket[] {
  const [y, m] = todayKey.split('-').map(Number) as [number, number, number];
  const buckets: MonthBucket[] = [];
  for (let i = 0; i < count; i++) {
    // Walk back i months from "today's month."
    const date = new Date(Date.UTC(y, m - 1 - i, 1));
    const mm = date.getUTCMonth() + 1;
    const yyyy = date.getUTCFullYear();
    const total = daysInMonth(yyyy, mm);
    const monthStr = `${yyyy}-${String(mm).padStart(2, '0')}`;
    const startDay = `${monthStr}-01`;
    const endDay = `${monthStr}-${String(total).padStart(2, '0')}`;
    const isCurrent = i === 0;
    const daysCovered = isCurrent
      ? Number(todayKey.split('-')[2])
      : total;
    buckets.push({ month: monthStr, startDay, endDay, isCurrent, daysCovered, totalDays: total });
  }
  return buckets;
}

/**
 * Compute one month's preview for the given creator. Pure function over
 * (ownedAppIds, usage_daily rows in window). Exported for unit-testing the
 * proportional-split logic without going through D1.
 */
export function computeMonthPreview(
  bucket: MonthBucket,
  ownedAppIds: Set<string>,
  rows: UsageRow[],
): MonthPreview {
  // Aggregate rows into {userId -> {total, perApp{appId -> sec}}}.
  interface User { total: number; perApp: Map<string, number> }
  const users = new Map<string, User>();
  for (const r of rows) {
    let u = users.get(r.user_id);
    if (!u) { u = { total: 0, perApp: new Map() }; users.set(r.user_id, u); }
    u.total += r.sec;
    u.perApp.set(r.app_id, (u.perApp.get(r.app_id) ?? 0) + r.sec);
  }

  let totalCents = 0;
  const perAppCents = new Map<string, number>();
  for (const user of users.values()) {
    if (user.total <= 0) continue;
    for (const appId of ownedAppIds) {
      const appSec = user.perApp.get(appId);
      if (!appSec) continue;
      const slice = (appSec / user.total) * PER_SUBSCRIBER_POOL_CENTS;
      totalCents += slice;
      perAppCents.set(appId, (perAppCents.get(appId) ?? 0) + slice);
    }
  }

  const perApp = Array.from(perAppCents.entries())
    .map(([appId, c]) => ({ appId, estimatedCents: Math.round(c) }))
    .filter((p) => p.estimatedCents > 0)
    .sort((a, b) => b.estimatedCents - a.estimatedCents);

  return {
    month: bucket.month,
    isCurrent: bucket.isCurrent,
    daysCovered: bucket.daysCovered,
    totalDays: bucket.totalDays,
    activeUsers: users.size,
    estimatedCents: Math.round(totalCents),
    perApp,
  };
}

payoutsRoutes.get('/payouts/me/preview', async (c) => {
  try {
    const user = await requireUser(c);
    const monthsParam = c.req.query('months');
    const monthsCount = Math.min(Math.max(Number(monthsParam) || 2, 1), 12);

    // Owned apps — needed so we only sum slices for the caller's own apps.
    const ownedApps = await c.env.DB.prepare('SELECT id FROM apps WHERE creator_id = ?')
      .bind(user.id)
      .all<{ id: string }>();
    const ownedAppIds = new Set((ownedApps.results ?? []).map((r) => r.id));

    const buckets = computeMonthBuckets(utcDayKey(), monthsCount);

    const months: MonthPreview[] = [];
    if (ownedAppIds.size === 0) {
      // No apps → zeros for every requested month, but still return the shape.
      for (const b of buckets) {
        months.push({
          month: b.month,
          isCurrent: b.isCurrent,
          daysCovered: b.daysCovered,
          totalDays: b.totalDays,
          activeUsers: 0,
          estimatedCents: 0,
          perApp: [],
        });
      }
    } else {
      for (const bucket of buckets) {
        const { results } = await c.env.DB.prepare(
          `SELECT user_id, app_id, SUM(session_seconds) AS sec
             FROM usage_daily
            WHERE day >= ? AND day <= ?
            GROUP BY user_id, app_id`,
        )
          .bind(bucket.startDay, bucket.endDay)
          .all<{ user_id: string; app_id: string; sec: number }>();
        months.push(
          computeMonthPreview(
            bucket,
            ownedAppIds,
            (results ?? []).map((r) => ({ user_id: r.user_id, app_id: r.app_id, sec: Number(r.sec) })),
          ),
        );
      }
    }

    const resp: PreviewResponse = {
      subscriberPriceCents: SUBSCRIBER_PRICE_CENTS,
      platformFeeBps: PLATFORM_FEE_BPS,
      perSubscriberPoolCents: PER_SUBSCRIBER_POOL_CENTS,
      months,
    };
    return c.json(resp);
  } catch (err) {
    if (err instanceof HttpError) return c.text(err.message, err.status as ContentfulStatusCode);
    throw err;
  }
});
