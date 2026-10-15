/**
 * Error-spike alerts (#107). The cron (index.ts `scheduled`, every five-minute
 * tick, at the tick's scheduled time) and the on-demand owner route call
 * evaluateErrorSpikes: aggregate the signals the platform already keeps —
 * app_logs (client runtime errors from the SDK and server-side operation
 * failures, #105/#106) and QA runs — per app over completed intervals (15
 * minutes; 5 for action failures), compare with the previous interval, and
 * record one app_alerts row per spike and interval (#389). Rows are read by the console; app owners may additionally
 * receive them on a registered webhook (event 'app.alert', lib/webhook-dispatch).
 *
 * Privacy: an alert names the app, the window, counts, categories, operation
 * names, fingerprints and build metadata. It never carries log messages,
 * request bodies, tokens, credentials or user identifiers — affected users is
 * a count.
 */
import { dispatchWebhook } from './webhook-dispatch.js';
import type { MetricSignal } from './metric-aggregates.js';

export const ALERT_WINDOW_MS = 15 * 60_000;
/**
 * #389: each evaluation re-checks every completed interval that ended in this
 * horizon, so up to 30 minutes of late or missed ticks are caught up. Intervals
 * older than that when the next tick runs are not evaluated: a recorded gap
 * (runbook), never a burst of stale alerts.
 */
export const CATCH_UP_MS = 30 * 60_000;
/** Client `error` rows in the window: at least this many, and at least SPIKE_FACTOR × the previous window. */
export const ERROR_SPIKE_MIN = 20;
export const SPIKE_FACTOR = 3;
/** Server-side action failures (category 'action', any status) in a completed 5-minute slice — the runbook's "> 20 / 5 min". */
export const ACTION_FAILURE_WINDOW_MS = 5 * 60_000;
export const ACTION_FAILURE_MIN = 20;
/** Server-side 5xx rows in the window — "sustained", not a one-off. */
export const SERVER_5XX_MIN = 5;
/** Consecutive failed QA runs (deploy or cron triggered) with no pass since. */
export const QA_CONSECUTIVE_FAILURES = 2;
export const ALERT_EVENT = 'app.alert';

export type AlertKind = 'error_spike' | 'action_failures' | 'server_5xx' | 'qa_failures';

export interface AlertTop {
  categories: { category: string; count: number }[];
  operations: { operation: string; count: number }[];
  fingerprints: { fingerprint: string; count: number }[];
}

export interface Alert {
  app_id: string;
  kind: AlertKind;
  window_start: number;
  window_end: number;
  /** #391: from the incident counters (app_metric_buckets), independent of detail budgets. */
  count: number;
  /** A SAMPLE: distinct users/clients among the retained detail rows, which are
   *  budgeted — a lower bound, never an exact affected-user count. */
  affected_users: number;
  baseline: number;
  /** A sample from retained detail rows, like affected_users. */
  top: AlertTop;
  build: unknown | null;
  /** #391: names which fields come from retained detail rows rather than the counters. */
  detail_basis: typeof DETAIL_BASIS;
}

/** `affected_users`, `top` and `build` are drawn from budgeted detail rows (#391). */
export const DETAIL_BASIS = 'retained_rows_sample' as const;

export interface AlertReport {
  checkedAt: string;
  windowMs: number;
  alerts: Alert[];
  /** Alerts newly recorded this run (the unique interval index absorbs re-evaluations). */
  recorded: number;
}

interface Env { DB: D1Database }

async function topFor(db: D1Database, appId: string, since: number, until: number, where: string, binds: unknown[]): Promise<AlertTop> {
  const q = async (expr: string) => {
    const rows = await db.prepare(
      `SELECT ${expr} AS k, COUNT(*) AS n FROM app_logs WHERE app_id = ? AND ingested_at >= ? AND ingested_at < ? AND ${where} GROUP BY k ORDER BY n DESC LIMIT 5`,
    ).bind(appId, since, until, ...binds).all<{ k: string | null; n: number }>();
    return (rows.results ?? []).filter((r) => r.k).map((r) => ({ k: r.k!, n: r.n }));
  };
  const [cats, ops, fps] = await Promise.all([
    q('category'),
    q("COALESCE(json_extract(data, '$.operation'), json_extract(data, '$.action'))"),
    q('fingerprint'),
  ]);
  return {
    categories: cats.map((c) => ({ category: c.k, count: c.n })),
    operations: ops.map((o) => ({ operation: o.k, count: o.n })),
    fingerprints: fps.map((f) => ({ fingerprint: f.k, count: f.n })),
  };
}

async function latestBuild(db: D1Database, appId: string, since: number, until: number): Promise<unknown | null> {
  const row = await db.prepare(
    'SELECT build_meta FROM app_logs WHERE app_id = ? AND ingested_at >= ? AND ingested_at < ? AND build_meta IS NOT NULL ORDER BY ingested_at DESC LIMIT 1',
  ).bind(appId, since, until).first<{ build_meta: string }>();
  if (!row) return null;
  try { return JSON.parse(row.build_meta); } catch { return null; }
}

/**
 * Count per app and slice of rows matching `where` in [since, until), with
 * distinct affected users (session id or anonymous client id — counted, never
 * listed). Keyed `${app_id}|${sliceStart}`; slices are aligned to `sliceMs`.
 */
async function perSlice(db: D1Database, sliceMs: number, since: number, until: number, where: string, appId?: string) {
  const rows = await db.prepare(
    `SELECT app_id, CAST(ingested_at / ?1 AS INTEGER) * ?1 AS slice, COUNT(*) AS n, COUNT(DISTINCT COALESCE(user_id, client_id)) AS affected FROM app_logs WHERE ingested_at >= ?2 AND ingested_at < ?3 AND ${where}${appId ? ' AND app_id = ?4' : ''} GROUP BY app_id, slice`,
  ).bind(sliceMs, since, until, ...(appId ? [appId] : [])).all<{ app_id: string; slice: number; n: number; affected: number }>();
  return new Map((rows.results ?? []).map((r) => [`${r.app_id}|${Number(r.slice)}`, { app_id: r.app_id, n: r.n, affected: r.affected }]));
}

/** Ends of the completed `stepMs` intervals inside the catch-up horizon, oldest first. Never after `now`. */
function completedEnds(now: number, stepMs: number): number[] {
  const ends: number[] = [];
  for (let end = Math.floor(now / stepMs) * stepMs; end > now - CATCH_UP_MS; end -= stepMs) ends.unshift(end);
  return ends;
}

/**
 * #391: alert counts per app and slice from the incident counters, which every
 * recorder writes before its detail budget. `sliceMs` is a multiple of the
 * 5-minute metric bucket. Keyed `${app_id}|${sliceStart}` like perSlice.
 */
async function countSlices(db: D1Database, sliceMs: number, since: number, until: number, signal: MetricSignal, appId?: string) {
  const rows = await db.prepare(
    `SELECT app_id, CAST(bucket_start / ?1 AS INTEGER) * ?1 AS slice, SUM(n) AS n FROM app_metric_buckets WHERE bucket_start >= ?2 AND bucket_start < ?3 AND signal = ?4${appId ? ' AND app_id = ?5' : ''} GROUP BY app_id, slice`,
  ).bind(sliceMs, since, until, signal, ...(appId ? [appId] : [])).all<{ app_id: string; slice: number; n: number }>();
  return new Map((rows.results ?? []).map((r) => [`${r.app_id}|${Number(r.slice)}`, { app_id: r.app_id, n: r.n }]));
}

const CLIENT_ERRORS = "level = 'error' AND source != 'server'";
const ACTION_FAILURES = "source = 'server' AND category = 'action'";
const SERVER_5XX = "source = 'server' AND level = 'error'";

export async function evaluateErrorSpikes(opts: { env: Env; now?: number; appId?: string; windowMs?: number }): Promise<AlertReport> {
  const { env } = opts;
  const now = opts.now ?? Date.now();
  const windowMs = opts.windowMs ?? ALERT_WINDOW_MS;
  const db = env.DB;
  const alerts: Alert[] = [];
  // #389: only completed intervals, never one that ends after `now`. Every interval
  // that ended within CATCH_UP_MS is evaluated again on each tick, so a late or
  // missed tick is caught up and the unique (app_id, kind, window_start) index
  // keeps the re-evaluations to one alert per interval.
  const windows = completedEnds(now, windowMs);
  const firstStart = windows[0]! - windowMs;
  const lastEnd = windows[windows.length - 1]!;

  // 1. Client runtime error spike (many errors, and a jump against the previous window)
  // and 2. sustained backend 5xx recorded server-side for an app, per completed window.
  // #391: counts from the incident counters; affected users from detail rows (a sample).
  const client = await countSlices(db, windowMs, firstStart - windowMs, lastEnd, 'client_error', opts.appId);
  const s5 = await countSlices(db, windowMs, firstStart, lastEnd, 'server_5xx', opts.appId);
  const clientSample = await perSlice(db, windowMs, firstStart, lastEnd, CLIENT_ERRORS, opts.appId);
  const s5Sample = await perSlice(db, windowMs, firstStart, lastEnd, SERVER_5XX, opts.appId);
  for (const windowEnd of windows) {
    const windowStart = windowEnd - windowMs;
    for (const [key, c] of client) {
      if (!key.endsWith(`|${windowStart}`)) continue;
      const baseline = client.get(`${c.app_id}|${windowStart - windowMs}`)?.n ?? 0;
      if (c.n >= ERROR_SPIKE_MIN && c.n >= baseline * SPIKE_FACTOR) {
        alerts.push({ app_id: c.app_id, kind: 'error_spike', window_start: windowStart, window_end: windowEnd, count: c.n, affected_users: clientSample.get(key)?.affected ?? 0, baseline,
          top: await topFor(db, c.app_id, windowStart, windowEnd, CLIENT_ERRORS, []), build: await latestBuild(db, c.app_id, windowStart, windowEnd), detail_basis: DETAIL_BASIS });
      }
    }
    for (const [key, c] of s5) {
      if (!key.endsWith(`|${windowStart}`) || c.n < SERVER_5XX_MIN) continue;
      alerts.push({ app_id: c.app_id, kind: 'server_5xx', window_start: windowStart, window_end: windowEnd, count: c.n, affected_users: s5Sample.get(key)?.affected ?? 0, baseline: 0,
        top: await topFor(db, c.app_id, windowStart, windowEnd, SERVER_5XX, []), build: await latestBuild(db, c.app_id, windowStart, windowEnd), detail_basis: DETAIL_BASIS });
    }
  }

  // 3. Action failures: the runbook's "> 20 in 5 minutes", per completed five-minute slice.
  const slices = completedEnds(now, ACTION_FAILURE_WINDOW_MS);
  const act = await countSlices(db, ACTION_FAILURE_WINDOW_MS, slices[0]! - 2 * ACTION_FAILURE_WINDOW_MS, slices[slices.length - 1]!, 'action_failure', opts.appId);
  const actSample = await perSlice(db, ACTION_FAILURE_WINDOW_MS, slices[0]! - ACTION_FAILURE_WINDOW_MS, slices[slices.length - 1]!, ACTION_FAILURES, opts.appId);
  for (const sliceEnd of slices) {
    const sliceStart = sliceEnd - ACTION_FAILURE_WINDOW_MS;
    for (const [key, c] of act) {
      if (!key.endsWith(`|${sliceStart}`) || c.n < ACTION_FAILURE_MIN) continue;
      alerts.push({ app_id: c.app_id, kind: 'action_failures', window_start: sliceStart, window_end: sliceEnd, count: c.n, affected_users: actSample.get(key)?.affected ?? 0,
        baseline: act.get(`${c.app_id}|${sliceStart - ACTION_FAILURE_WINDOW_MS}`)?.n ?? 0,
        top: await topFor(db, c.app_id, sliceStart, sliceEnd, ACTION_FAILURES, []), build: await latestBuild(db, c.app_id, sliceStart, sliceEnd), detail_basis: DETAIL_BASIS });
    }
  }

  // 4. QA: consecutive failed platform-run flows since the last pass (deploy/cron triggers — #62 fixed the stuck-run signal),
  // as of each window's end; the window that holds the streak's latest failure raises it.
  for (const windowEnd of windows) {
    const windowStart = windowEnd - windowMs;
    const qa = await db.prepare(
      `SELECT app_id, status, finished_at FROM app_test_runs WHERE trigger_kind IN ('deploy', 'cron') AND status IN ('passed', 'failed', 'error') AND finished_at >= ? AND finished_at < ?${opts.appId ? ' AND app_id = ?' : ''} ORDER BY app_id, finished_at DESC`,
    ).bind(windowEnd - 24 * 60 * 60_000, windowEnd, ...(opts.appId ? [opts.appId] : [])).all<{ app_id: string; status: string; finished_at: number }>();
    const streak = new Map<string, { n: number; latest: number; done: boolean }>();
    for (const r of qa.results ?? []) {
      const s = streak.get(r.app_id) ?? { n: 0, latest: r.finished_at, done: false };
      if (!s.done) { if (r.status === 'passed') s.done = true; else s.n += 1; }
      streak.set(r.app_id, s);
    }
    for (const [appId, s] of streak) {
      if (s.n >= QA_CONSECUTIVE_FAILURES && s.latest >= windowStart) {
        alerts.push({ app_id: appId, kind: 'qa_failures', window_start: windowStart, window_end: windowEnd, count: s.n, affected_users: 0, baseline: 0,
          top: { categories: [{ category: 'qa', count: s.n }], operations: [], fingerprints: [] }, build: await latestBuild(db, appId, windowStart - 24 * 60 * 60_000, windowEnd), detail_basis: DETAIL_BASIS });
      }
    }
  }

  // Persist (idempotent per interval) and deliver to any registered webhook.
  let recorded = 0;
  for (const a of alerts) {
    const res = await db.prepare(
      'INSERT OR IGNORE INTO app_alerts (app_id, kind, window_start, window_end, count, affected_users, baseline, top, build_meta, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    ).bind(a.app_id, a.kind, a.window_start, a.window_end, a.count, a.affected_users, a.baseline, JSON.stringify(a.top), a.build === null ? null : JSON.stringify(a.build), now).run();
    if (res.meta?.changes) {
      recorded += 1;
      console.warn(`[alert] ${a.kind} app=${a.app_id} count=${a.count} affected=${a.affected_users} baseline=${a.baseline} window=${new Date(a.window_start).toISOString()}..${new Date(a.window_end).toISOString()}`);
      await dispatchWebhook(db, a.app_id, ALERT_EVENT, { event: ALERT_EVENT, ...a, detected_at: now });
    }
  }
  return { checkedAt: new Date(now).toISOString(), windowMs, alerts, recorded };
}
