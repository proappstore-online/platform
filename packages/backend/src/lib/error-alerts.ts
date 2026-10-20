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
import { recordHealth } from './metric-aggregates.js';
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
/** The kinds this evaluator records — and the only ones its redelivery sweep touches;
 *  other app_alerts writers (scheduled actions, app-worker quota) dispatch their own. */
export const EVALUATOR_KINDS: readonly AlertKind[] = ['error_spike', 'action_failures', 'server_5xx', 'qa_failures'];
/**
 * #389: a delivery is claimed on its app_alerts row for this long. It outlasts a
 * dispatch (at most MAX_WEBHOOKS_PER_APP attempts of WEBHOOK_TIMEOUT_MS), so
 * overlapping runs never both send; a run that dies mid-send is retried after it.
 */
export const DISPATCH_LEASE_MS = 10 * 60_000;
/** Undelivered alerts older than this are left alone: past the point of being news. */
export const REDELIVERY_HORIZON_MS = 24 * 60 * 60_000;

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
  /** Alerts this run claimed and dispatched — new ones, and any a dead run left undelivered. */
  dispatched: number;
  /** Scheduled runs only: the range that fell out of the catch-up horizon unevaluated since the last run, if any. */
  gap: { start: number; end: number } | null;
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

export async function evaluateErrorSpikes(opts: { env: Env; now?: number; appId?: string; windowMs?: number; scheduled?: boolean }): Promise<AlertReport> {
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

  // Persist, idempotent per interval. Delivery is separate (below), from the stored row,
  // so an alert recorded by a run that died before sending is still sent once.
  let recorded = 0;
  for (const a of alerts) {
    const res = await db.prepare(
      'INSERT OR IGNORE INTO app_alerts (app_id, kind, window_start, window_end, count, affected_users, baseline, top, build_meta, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    ).bind(a.app_id, a.kind, a.window_start, a.window_end, a.count, a.affected_users, a.baseline, JSON.stringify(a.top), a.build === null ? null : JSON.stringify(a.build), now).run();
    if (res.meta?.changes) {
      recorded += 1;
      console.warn(`[alert] ${a.kind} app=${a.app_id} count=${a.count} affected=${a.affected_users} baseline=${a.baseline} window=${new Date(a.window_start).toISOString()}..${new Date(a.window_end).toISOString()}`);
    }
  }
  const dispatched = await deliverPendingAlerts(db, now, opts.appId);
  // Only the platform-wide scheduled run owns the cursor: an owner's on-demand run
  // covers one app and says nothing about the others.
  const gap = opts.scheduled && !opts.appId ? await advanceCursor(db, slices[0]! - ACTION_FAILURE_WINDOW_MS, slices[slices.length - 1]!, now) : null;
  return { checkedAt: new Date(now).toISOString(), windowMs, alerts, recorded, dispatched, gap };
}

const CURSOR_ID = 'scheduled';

/**
 * #389: the recorded gap. The cursor is the end of the latest five-minute slice a
 * scheduled run evaluated (the finest interval; every 15-minute window ends on
 * one). When this run's catch-up horizon starts after it, the slices between were
 * never evaluated: that range is kept on the cursor row, flagged on the
 * evaluator's telemetry health and logged, never replayed as stale alerts. The
 * cursor only moves forward, so overlapping or out-of-order runs cannot rewind it.
 */
async function advanceCursor(db: D1Database, coveredFrom: number, coveredTo: number, now: number): Promise<{ start: number; end: number } | null> {
  const prev = await db.prepare('SELECT last_window_end FROM alert_evaluator_cursor WHERE id = ?').bind(CURSOR_ID).first<{ last_window_end: number }>();
  const gap = prev && prev.last_window_end < coveredFrom ? { start: prev.last_window_end, end: coveredFrom } : null;
  await db.prepare(
    `INSERT INTO alert_evaluator_cursor (id, last_window_end, updated_at) VALUES (?1, ?2, ?3)
     ON CONFLICT(id) DO UPDATE SET last_window_end = MAX(last_window_end, excluded.last_window_end), updated_at = excluded.updated_at`,
  ).bind(CURSOR_ID, coveredTo, now).run();
  if (gap) {
    await db.prepare('UPDATE alert_evaluator_cursor SET gap_start = ?, gap_end = ?, gap_recorded_at = ? WHERE id = ?')
      .bind(gap.start, gap.end, now, CURSOR_ID).run();
    console.warn(`[alert] gap: intervals ${new Date(gap.start).toISOString()}..${new Date(gap.end).toISOString()} were not evaluated (more than ${CATCH_UP_MS / 60_000} min without a scheduled run)`);
    await recordHealth(db, 'evaluator', '', false, 'gap', now);
  }
  return gap;
}

interface AlertRow {
  id: number; app_id: string; kind: AlertKind; window_start: number; window_end: number; count: number;
  affected_users: number; baseline: number; top: string; build_meta: string | null; created_at: number;
}

/** The app.alert payload, rebuilt from the stored row: the same body on a first send and on a redelivery. */
export function alertPayload(r: AlertRow) {
  return {
    event: ALERT_EVENT, app_id: r.app_id, kind: r.kind, window_start: r.window_start, window_end: r.window_end, count: r.count,
    affected_users: r.affected_users, baseline: r.baseline, top: JSON.parse(r.top) as AlertTop,
    build: r.build_meta === null ? null : JSON.parse(r.build_meta) as unknown, detail_basis: DETAIL_BASIS, detected_at: r.created_at,
  };
}

/**
 * #389: dispatch every evaluator alert that is recorded but not yet dispatched.
 * Each row is claimed with a conditional UPDATE first, so of two overlapping runs
 * only one sends; it is stamped dispatched once dispatchWebhook returns (a failed
 * HTTP delivery is webhook_deliveries' to retry, #395). A run that dies after
 * recording, or mid-send, leaves the row undispatched and its claim expires after
 * DISPATCH_LEASE_MS — at-least-once in that one case, never a lost alert. The
 * payload's (app_id, kind, window_start) is the receiver's idempotency key.
 */
export async function deliverPendingAlerts(db: D1Database, now: number, appId?: string): Promise<number> {
  const kinds = EVALUATOR_KINDS.map(() => '?').join(', ');
  const { results } = await db.prepare(
    `SELECT id, app_id, kind, window_start, window_end, count, affected_users, baseline, top, build_meta, created_at FROM app_alerts
      WHERE dispatched_at IS NULL AND created_at > ? AND kind IN (${kinds})${appId ? ' AND app_id = ?' : ''}
      ORDER BY created_at, id LIMIT 100`,
  ).bind(now - REDELIVERY_HORIZON_MS, ...EVALUATOR_KINDS, ...(appId ? [appId] : [])).all<AlertRow>();
  let dispatched = 0;
  for (const row of results ?? []) {
    const claim = await db.prepare(
      `UPDATE app_alerts SET dispatch_claimed_at = ?1
        WHERE id = ?2 AND dispatched_at IS NULL AND (dispatch_claimed_at IS NULL OR dispatch_claimed_at <= ?1 - ?3)`,
    ).bind(now, row.id, DISPATCH_LEASE_MS).run();
    if (!claim.meta?.changes) continue;
    await dispatchWebhook(db, row.app_id, ALERT_EVENT, alertPayload(row));
    await db.prepare('UPDATE app_alerts SET dispatched_at = ?1 WHERE id = ?2 AND dispatch_claimed_at = ?1')
      .bind(now, row.id).run();
    dispatched += 1;
  }
  return dispatched;
}
