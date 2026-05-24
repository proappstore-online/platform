import { Hono } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import type { Env } from '../types.js';
import { requireUser, requireAppOwner, HttpError } from '../lib/auth.js';

/**
 * Usage telemetry — powers usage-proportional creator payouts.
 *
 * Three endpoints:
 *
 *   - POST /v1/usage/ping    SDK heartbeat from inside a running Pro app.
 *                            Upserts the (app, user, day) row and bumps
 *                            session_seconds + api_calls. Clamps the per-ping
 *                            deltas so a misbehaving SDK can't inflate usage.
 *
 *   - GET  /v1/apps/:id/usage?days=N
 *                            Owner-only daily series for one app, aggregated
 *                            across all users. Powers the creator's dashboard
 *                            chart.
 *
 *   - GET  /v1/usage/me?days=N
 *                            Signed-in user's own usage across all apps.
 *                            Powers the "where did my $9 go" view.
 *
 * Grain matches the payout math: the monthly cron sums these rows to compute
 * each creator's share of the subscriber pool. Anything finer than (app, user,
 * day) is throwaway detail; anything coarser loses per-user fairness.
 */

export const usageRoutes = new Hono<{ Bindings: Env }>();

const APP_ID_RE = /^[a-z][a-z0-9-]*$/;
const APP_ID_MAX_LEN = 58;

/** Per-ping clamps. Caps a misbehaving SDK to roughly one heartbeat's worth. */
const MAX_DELTA_SECONDS = 90;
const MAX_DELTA_API_CALLS = 1000;

/** Window clamps for the read endpoints. */
const DEFAULT_DAYS = 30;
const MAX_DAYS = 365;
const MIN_DAYS = 1;

interface PingBody {
  appId?: unknown;
  deltaSeconds?: unknown;
  deltaApiCalls?: unknown;
}

/** Today's UTC day key, YYYY-MM-DD. */
function utcDayKey(now: number = Date.now()): string {
  return new Date(now).toISOString().slice(0, 10);
}

/** Subtract `n` days from a YYYY-MM-DD key, returning a new YYYY-MM-DD key. */
function addDays(dayKey: string, n: number): string {
  const [y, m, d] = dayKey.split('-').map(Number) as [number, number, number];
  const t = Date.UTC(y, m - 1, d) + n * 86400_000;
  return new Date(t).toISOString().slice(0, 10);
}

/** Build the list of YYYY-MM-DD keys for the [today-N+1, today] window, ascending. */
function buildDayWindow(today: string, days: number): string[] {
  const out: string[] = [];
  for (let i = days - 1; i >= 0; i--) {
    out.push(addDays(today, -i));
  }
  return out;
}

function parseDaysParam(raw: string | undefined): number {
  if (!raw) return DEFAULT_DAYS;
  const n = Number(raw);
  if (!Number.isFinite(n)) return DEFAULT_DAYS;
  const floored = Math.floor(n);
  if (floored < MIN_DAYS) return MIN_DAYS;
  if (floored > MAX_DAYS) return MAX_DAYS;
  return floored;
}

function clampDelta(v: unknown, max: number): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) return 0;
  if (v <= 0) return 0;
  const floored = Math.floor(v);
  return floored > max ? max : floored;
}

usageRoutes.post('/usage/ping', async (c) => {
  try {
    const user = await requireUser(c);
    const body = await c.req.json<PingBody>().catch(() => ({} as PingBody));

    const appId = typeof body.appId === 'string' ? body.appId.trim() : '';
    if (!appId || !APP_ID_RE.test(appId) || appId.length > APP_ID_MAX_LEN) {
      return c.text('invalid appId', 400);
    }

    // Make sure the app actually exists — otherwise a typo'd appId would
    // silently accumulate rows that no creator owns.
    const appRow = await c.env.DB.prepare('SELECT id FROM apps WHERE id = ?')
      .bind(appId)
      .first<{ id: string }>();
    if (!appRow) return c.text('unknown app', 400);

    const deltaSeconds = clampDelta(body.deltaSeconds, MAX_DELTA_SECONDS);
    const deltaApiCalls = clampDelta(body.deltaApiCalls, MAX_DELTA_API_CALLS);

    const now = Date.now();
    const day = utcDayKey(now);

    // Upsert: insert a fresh row if this is the first ping for this
    // (app, user, day), otherwise add to the existing totals.
    await c.env.DB.prepare(
      `INSERT INTO usage_daily (app_id, user_id, day, session_seconds, api_calls, last_seen)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6)
       ON CONFLICT(app_id, user_id, day) DO UPDATE SET
         session_seconds = session_seconds + ?4,
         api_calls = api_calls + ?5,
         last_seen = ?6`,
    )
      .bind(appId, user.id, day, deltaSeconds, deltaApiCalls, now)
      .run();

    // Read back the totals so the SDK sees the authoritative current state
    // (including the clamped deltas) without a follow-up query.
    const row = await c.env.DB.prepare(
      'SELECT session_seconds, api_calls FROM usage_daily WHERE app_id = ? AND user_id = ? AND day = ?',
    )
      .bind(appId, user.id, day)
      .first<{ session_seconds: number; api_calls: number }>();

    return c.json({
      ok: true,
      day,
      sessionSeconds: row ? Number(row.session_seconds) : deltaSeconds,
      apiCalls: row ? Number(row.api_calls) : deltaApiCalls,
    });
  } catch (err) {
    if (err instanceof HttpError) return c.text(err.message, err.status as ContentfulStatusCode);
    throw err;
  }
});

interface AppDailyRow {
  day: string;
  session_seconds: number;
  api_calls: number;
  users: number;
}

usageRoutes.get('/apps/:id/usage', async (c) => {
  try {
    const appId = c.req.param('id');
    await requireAppOwner(c, appId);

    const days = parseDaysParam(c.req.query('days'));
    const today = utcDayKey();
    const startDay = addDays(today, -(days - 1));
    const window = buildDayWindow(today, days);

    // Per-day aggregation across all users for this app.
    const { results } = await c.env.DB.prepare(
      `SELECT day,
              SUM(session_seconds) AS session_seconds,
              SUM(api_calls) AS api_calls,
              COUNT(DISTINCT user_id) AS users
         FROM usage_daily
        WHERE app_id = ?
          AND day >= ?
          AND day <= ?
        GROUP BY day`,
    )
      .bind(appId, startDay, today)
      .all<AppDailyRow>();

    const byDay = new Map<string, AppDailyRow>();
    for (const r of results ?? []) {
      byDay.set(r.day, {
        day: r.day,
        session_seconds: Number(r.session_seconds ?? 0),
        api_calls: Number(r.api_calls ?? 0),
        users: Number(r.users ?? 0),
      });
    }

    const series = window.map((day) => {
      const r = byDay.get(day);
      return {
        day,
        sessionSeconds: r ? r.session_seconds : 0,
        apiCalls: r ? r.api_calls : 0,
        users: r ? r.users : 0,
      };
    });

    // Window-wide totals. Distinct-user count has to come from the raw rows,
    // not summed from the per-day counts (a user active two days counts twice
    // if we sum naively).
    const totalsRow = await c.env.DB.prepare(
      `SELECT COALESCE(SUM(session_seconds), 0) AS session_seconds,
              COALESCE(SUM(api_calls), 0) AS api_calls,
              COUNT(DISTINCT user_id) AS users
         FROM usage_daily
        WHERE app_id = ?
          AND day >= ?
          AND day <= ?`,
    )
      .bind(appId, startDay, today)
      .first<{ session_seconds: number; api_calls: number; users: number }>();

    return c.json({
      appId,
      days,
      series,
      totals: {
        sessionSeconds: Number(totalsRow?.session_seconds ?? 0),
        apiCalls: Number(totalsRow?.api_calls ?? 0),
        users: Number(totalsRow?.users ?? 0),
      },
    });
  } catch (err) {
    if (err instanceof HttpError) return c.text(err.message, err.status as ContentfulStatusCode);
    throw err;
  }
});

interface MeAppRow {
  app_id: string;
  session_seconds: number;
  api_calls: number;
}

usageRoutes.get('/usage/me', async (c) => {
  try {
    const user = await requireUser(c);
    const days = parseDaysParam(c.req.query('days'));
    const today = utcDayKey();
    const startDay = addDays(today, -(days - 1));

    const { results } = await c.env.DB.prepare(
      `SELECT app_id,
              SUM(session_seconds) AS session_seconds,
              SUM(api_calls) AS api_calls
         FROM usage_daily
        WHERE user_id = ?
          AND day >= ?
          AND day <= ?
        GROUP BY app_id
        ORDER BY app_id`,
    )
      .bind(user.id, startDay, today)
      .all<MeAppRow>();

    const perApp = (results ?? []).map((r) => ({
      appId: r.app_id,
      sessionSeconds: Number(r.session_seconds ?? 0),
      apiCalls: Number(r.api_calls ?? 0),
    }));

    const totals = perApp.reduce(
      (acc, r) => {
        acc.sessionSeconds += r.sessionSeconds;
        acc.apiCalls += r.apiCalls;
        return acc;
      },
      { sessionSeconds: 0, apiCalls: 0 },
    );

    return c.json({
      userId: user.id,
      days,
      perApp,
      totals,
    });
  } catch (err) {
    if (err instanceof HttpError) return c.text(err.message, err.status as ContentfulStatusCode);
    throw err;
  }
});

interface OwnerSummaryRow {
  active_users: number | null;
  session_seconds: number | null;
  api_calls: number | null;
}

/**
 * Owner-wide usage summary across every app the caller owns. Powers the
 * Console Dashboard's "Active 30d" stat. Two D1 queries (apps list, then
 * aggregate over their ids) — short-circuits to zeros when the caller owns
 * no apps so the empty-state load is cheap.
 */
usageRoutes.get('/usage/owner-summary', async (c) => {
  try {
    const user = await requireUser(c);
    const days = parseDaysParam(c.req.query('days'));
    const today = utcDayKey();
    const startDay = addDays(today, -(days - 1));

    const ownedApps = await c.env.DB.prepare('SELECT id FROM apps WHERE creator_id = ?')
      .bind(user.id)
      .all<{ id: string }>();
    const appIds = (ownedApps.results ?? []).map((r) => r.id);

    if (appIds.length === 0) {
      return c.json({ days, appCount: 0, activeUsers: 0, sessionSeconds: 0, apiCalls: 0 });
    }

    const placeholders = appIds.map(() => '?').join(', ');
    const summary = await c.env.DB.prepare(
      `SELECT COUNT(DISTINCT user_id) AS active_users,
              COALESCE(SUM(session_seconds), 0) AS session_seconds,
              COALESCE(SUM(api_calls), 0) AS api_calls
         FROM usage_daily
        WHERE app_id IN (${placeholders})
          AND day >= ?
          AND day <= ?`,
    )
      .bind(...appIds, startDay, today)
      .first<OwnerSummaryRow>();

    return c.json({
      days,
      appCount: appIds.length,
      activeUsers: Number(summary?.active_users ?? 0),
      sessionSeconds: Number(summary?.session_seconds ?? 0),
      apiCalls: Number(summary?.api_calls ?? 0),
    });
  } catch (err) {
    if (err instanceof HttpError) return c.text(err.message, err.status as ContentfulStatusCode);
    throw err;
  }
});
