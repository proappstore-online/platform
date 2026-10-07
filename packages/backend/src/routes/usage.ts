import { Hono } from 'hono';
import type { Env } from '../types.js';
import { requireUser, requireAppOwner } from '../lib/auth.js';
import { wrap } from '../lib/route-wrap.js';
import { APP_ID_RE } from './validation.js';
import { APP_CONTEXT_HEADER } from '../lib/app-context.js';
import { utcDayKey } from '../lib/day-key.js';
import { payoutActorId, writePayoutUsagePoint } from '../lib/payout-meter.js';

/**
 * Usage telemetry — powers usage-proportional creator payouts.
 *
 * Three endpoints:
 *
 *   - POST /v1/usage/ping    SDK heartbeat from inside a running Pro app.
 *                            Writes an immutable Analytics Engine payout-meter
 *                            event, while the legacy daily rollup remains for
 *                            rate limiting and non-financial dashboard views.
 *                            session_seconds + api_calls. Clamps the per-ping
 *                            deltas so a misbehaving SDK can't inflate usage, and
 *                            claims each elapsed interval atomically, so parallel
 *                            pings can't multiply it (#320, claimPingInterval).
 *                            SECURITY (#58): attribution is bound to the app
 *                            origin the host asserts (`X-PAS-App`), never to
 *                            the client-declared `appId` alone — see the route.
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
 * The payout calculation never reads `usage_daily`: Analytics Engine is its
 * source of truth. The daily table is a legacy guard/dashboard projection and
 * can be backfilled into the meter exactly once by the operator.
 */

export const usageRoutes = new Hono<{ Bindings: Env }>();

const APP_ID_MAX_LEN = 58;

/** Per-ping clamps. Caps a misbehaving SDK to roughly one heartbeat's worth. */
const MAX_DELTA_SECONDS = 90;
const MAX_DELTA_API_CALLS = 1000;
/**
 * Ceiling on api_calls per second of REAL elapsed time (#58).
 *
 * The per-ping clamp above bounds one request; without a rate bound a caller
 * could still send MAX_DELTA_API_CALLS on every ping and inflate the total by
 * pinging faster. The SDK heartbeat is 60s, so a normal ping reports at most
 * 1000 calls over ~60s elapsed — 20/s leaves that untouched (60 × 20 = 1200,
 * above the per-ping clamp) and only bites when pings arrive faster than the
 * heartbeat, which is precisely the inflation case.
 */
const MAX_API_CALLS_PER_SECOND = 20;

/** Window clamps for the read endpoints. */
const DEFAULT_DAYS = 30;
const MAX_DAYS = 365;
const MIN_DAYS = 1;

interface PingBody {
  appId?: unknown;
  deltaSeconds?: unknown;
  deltaApiCalls?: unknown;
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

/** How many times a ping re-reads after losing its interval to a concurrent ping. */
const PING_CLAIM_ATTEMPTS = 3;

interface PingClaim { deltaSeconds: number; deltaApiCalls: number; sessionSeconds: number; apiCalls: number }

/**
 * Claim the wall-clock interval since this (app, user, day)'s last recorded ping,
 * atomically (#320). The concurrency invariant payout metering relies on:
 *
 *   every recorded second lies in exactly one interval (prior last_seen, now],
 *   claimed by exactly one ping.
 *
 * The write is a compare-and-swap on the `last_seen` this ping read. A first
 * ping of the day is `INSERT … ON CONFLICT DO NOTHING`. A later one is
 * `UPDATE … WHERE last_seen = <read value>`. A ping that loses (changes = 0)
 * re-reads and recomputes against the winner's last_seen, so it can claim only
 * time after it, normally none. Recorded session time therefore never exceeds
 * wall-clock time, however many pings run in parallel, and only a winner writes
 * a meter event.
 *
 * Unchanged from #58: the per-ping caps (MAX_DELTA_SECONDS, MAX_DELTA_API_CALLS),
 * the bound by real elapsed time (api_calls at MAX_API_CALLS_PER_SECOND of it),
 * and the per-ping cap for a day's first ping. Elapsed time is counted in whole
 * seconds, with the sub-second rest carried in last_seen. Rounding up would let
 * pings a few milliseconds apart each claim a second. A ping whose `now` is at
 * or before last_seen (a retry, an out-of-order or skewed request) claims
 * nothing and never moves last_seen back. Null: nothing was claimed.
 */
export async function claimPingInterval(
  db: D1Database, key: { appId: string; userId: string; day: string; now: number }, body: PingBody,
): Promise<PingClaim | null> {
  const { appId, userId, day, now } = key;
  const requestedSeconds = clampDelta(body.deltaSeconds, MAX_DELTA_SECONDS);
  const requestedApiCalls = clampDelta(body.deltaApiCalls, MAX_DELTA_API_CALLS);
  for (let attempt = 0; attempt < PING_CLAIM_ATTEMPTS; attempt++) {
    const prior = await db.prepare(
      'SELECT session_seconds, api_calls, last_seen FROM usage_daily WHERE app_id = ? AND user_id = ? AND day = ?',
    ).bind(appId, userId, day).first<{ session_seconds: number; api_calls: number; last_seen: number }>();

    if (!prior) {
      // First ping of the day: up to the per-ping caps. Only one concurrent first ping can insert.
      if (requestedSeconds === 0 && requestedApiCalls === 0) return null;
      const inserted = await db.prepare(
        `INSERT INTO usage_daily (app_id, user_id, day, session_seconds, api_calls, last_seen)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)
         ON CONFLICT(app_id, user_id, day) DO NOTHING`,
      ).bind(appId, userId, day, requestedSeconds, requestedApiCalls, now).run();
      if (inserted.meta.changes) {
        return { deltaSeconds: requestedSeconds, deltaApiCalls: requestedApiCalls, sessionSeconds: requestedSeconds, apiCalls: requestedApiCalls };
      }
      continue; // a concurrent first ping inserted the row: re-read and claim only what is left
    }

    const lastSeen = Number(prior.last_seen);
    // Whole seconds only. Rounding a sub-second gap up let pings a few ms apart each claim a second (#320).
    const elapsedSeconds = Math.max(0, Math.floor((now - lastSeen) / 1000));
    const deltaSeconds = Math.min(requestedSeconds, elapsedSeconds);
    const deltaApiCalls = Math.min(requestedApiCalls, elapsedSeconds * MAX_API_CALLS_PER_SECOND);
    if (now <= lastSeen || (deltaSeconds === 0 && deltaApiCalls === 0)) return null;
    // Bounded by elapsed time: advance by exactly what was claimed, so the sub-second rest carries to the next ping.
    // Bounded by the request: time past it was not claimed and is dropped, as before. Never past `now`.
    const nextSeen = deltaSeconds === elapsedSeconds ? lastSeen + elapsedSeconds * 1000 : now;
    const swapped = await db.prepare(
      `UPDATE usage_daily SET session_seconds = session_seconds + ?4, api_calls = api_calls + ?5, last_seen = ?6
        WHERE app_id = ?1 AND user_id = ?2 AND day = ?3 AND last_seen = ?7`,
    ).bind(appId, userId, day, deltaSeconds, deltaApiCalls, nextSeen, lastSeen).run();
    if (swapped.meta.changes) {
      return {
        deltaSeconds, deltaApiCalls,
        sessionSeconds: Number(prior.session_seconds) + deltaSeconds,
        apiCalls: Number(prior.api_calls) + deltaApiCalls,
      };
    }
    // Lost the race for this interval: another ping moved last_seen. Re-read.
  }
  return null;
}

usageRoutes.post('/usage/ping', wrap(async (c) => {
  const user = await requireUser(c);
  const body = await c.req.json<PingBody>().catch(() => ({} as PingBody));

  const appId = typeof body.appId === 'string' ? body.appId.trim() : '';
  if (!appId || !APP_ID_RE.test(appId) || appId.length > APP_ID_MAX_LEN) {
    return c.text('invalid appId', 400);
  }

  // SECURITY (#58): the body's `appId` is the page's word. The only claim
  // about WHICH app a caller is actually using comes from the host's
  // platform mediation, which strips any client copy of X-PAS-App and sets it
  // from the resolved route (lib/app-context.ts). A mediated ping that names a
  // different app is hostile — a subscriber redirecting their pool share onto
  // an arbitrary app — and is refused outright.
  const mediatedApp = c.req.header(APP_CONTEXT_HEADER);
  if (mediatedApp && mediatedApp !== appId) {
    return c.text('app context mismatch', 403);
  }

  // Make sure the app actually exists — otherwise a typo'd appId would
  // silently accumulate rows that no creator owns.
  const appRow = await c.env.DB.prepare('SELECT id FROM apps WHERE id = ?')
    .bind(appId)
    .first<{ id: string }>();
  if (!appRow) return c.text('unknown app', 400);

  const now = Date.now();
  const day = utcDayKey(now);

  // SECURITY (#58): no mediated origin means the request did not come from
  // the app's own origin — a direct API call, or the SDK in legacy-bearer
  // mode, which posts straight to api.proappstore.online. Such a caller can
  // name any app it likes, so its usage is acknowledged but NOT recorded:
  // usage that drives creator payouts must be attributable to an app the
  // caller is verifiably inside. Benign 200 so the SDK heartbeat never
  // error-spams; hosted apps are on the mediated path per PAS-AUTH-001.
  if (!mediatedApp) {
    return c.json({ ok: true, recorded: false, reason: 'unverified-origin', day, sessionSeconds: 0, apiCalls: 0 });
  }

  // SECURITY (#58): usage drives creator payouts from the subscription pool,
  // so only an ACTIVE PAID subscriber's usage may be recorded — otherwise
  // anyone (incl. cheaply-created throwaway accounts) could Sybil-inflate an
  // app's pool share or dilute a rival's. Non-subscribers get a benign ok
  // without a write, so the SDK heartbeat doesn't error-spam.
  const sub = await c.env.DB.prepare(
    "SELECT 1 FROM subscriptions WHERE user_id = ? AND status = 'active'",
  )
    .bind(user.id)
    .first<{ 1: number }>();
  if (!sub) {
    return c.json({ ok: true, recorded: false, reason: 'no-subscription', day, sessionSeconds: 0, apiCalls: 0 });
  }

  // Fail closed before updating the legacy projection: a successful heartbeat
  // that is absent from the financial ledger would make payouts unauditable.
  const actor = await payoutActorId(user.id, c.env.PAYOUT_METER_SALT);

  const claim = await claimPingInterval(c.env.DB, { appId, userId: user.id, day, now }, body);
  if (!claim) {
    // Nothing left to claim: no wall-clock time has passed since the last recorded ping,
    // a concurrent ping claimed it, or this ping's clock is behind the row (#320).
    return c.json({ ok: true, recorded: false, reason: 'no-elapsed-time', day, sessionSeconds: 0, apiCalls: 0 });
  }

  // AE is append-only. A unique event key makes every accepted heartbeat an
  // independently auditable delta; backfilled legacy rows use deterministic
  // keys and the payout SQL deduplicates key replays. Written only for the ping
  // that won its interval (#320), so one stretch of time is metered once.
  writePayoutUsagePoint(c.env.PAYOUT_METER, {
    appId,
    actor,
    eventKey: `sdk:${crypto.randomUUID()}`,
    source: 'sdk',
    occurredAt: now,
    sessionSeconds: claim.deltaSeconds,
    apiCalls: claim.deltaApiCalls,
  });

  return c.json({
    ok: true,
    recorded: true,
    day,
    sessionSeconds: claim.sessionSeconds,
    apiCalls: claim.apiCalls,
  });
}));

interface AppDailyRow {
  day: string;
  session_seconds: number;
  api_calls: number;
  users: number;
}

usageRoutes.get('/apps/:id/usage', wrap(async (c) => {
  const appId = c.req.param('id')!;
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
}));

interface MeAppRow {
  app_id: string;
  session_seconds: number;
  api_calls: number;
}

usageRoutes.get('/usage/me', wrap(async (c) => {
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
}));

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
usageRoutes.get('/usage/owner-summary', wrap(async (c) => {
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
}));
