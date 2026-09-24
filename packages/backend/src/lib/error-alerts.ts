/**
 * Error-spike alerts (#107). The cron (index.ts `scheduled`, every 15 min) and
 * the on-demand owner route call evaluateErrorSpikes: aggregate the signals
 * the platform already keeps — app_logs (client runtime errors from the SDK and
 * server-side operation failures, #105/#106) and QA runs — per app over a
 * rolling window, compare with the previous window, and record one app_alerts
 * row per spike. Rows are read by the console; app owners may additionally
 * receive them on a registered webhook (event 'app.alert', lib/webhook-dispatch).
 *
 * Privacy: an alert names the app, the window, counts, categories, operation
 * names, fingerprints and build metadata. It never carries log messages,
 * request bodies, tokens, credentials or user identifiers — affected users is
 * a count.
 */
import { dispatchWebhook } from './webhook-dispatch.js';

export const ALERT_WINDOW_MS = 15 * 60_000;
/** Client `error` rows in the window: at least this many, and at least SPIKE_FACTOR × the previous window. */
export const ERROR_SPIKE_MIN = 20;
export const SPIKE_FACTOR = 3;
/** Server-side action failures (category 'action', any status) in a 5-minute window — the runbook's "> 20 / 5 min". */
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
  count: number;
  affected_users: number;
  baseline: number;
  top: AlertTop;
  build: unknown | null;
}

export interface AlertReport {
  checkedAt: string;
  windowMs: number;
  alerts: Alert[];
  /** Alerts newly recorded this run (the unique bucket index absorbs re-runs). */
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

async function latestBuild(db: D1Database, appId: string, since: number): Promise<unknown | null> {
  const row = await db.prepare(
    'SELECT build_meta FROM app_logs WHERE app_id = ? AND ingested_at >= ? AND build_meta IS NOT NULL ORDER BY ingested_at DESC LIMIT 1',
  ).bind(appId, since).first<{ build_meta: string }>();
  if (!row) return null;
  try { return JSON.parse(row.build_meta); } catch { return null; }
}

/**
 * Count-per-app of rows matching `where` in [since, until), with distinct
 * affected users (session id or anonymous client id — counted, never listed).
 */
async function perApp(db: D1Database, since: number, until: number, where: string, appId?: string) {
  const rows = await db.prepare(
    `SELECT app_id, COUNT(*) AS n, COUNT(DISTINCT COALESCE(user_id, client_id)) AS affected FROM app_logs WHERE ingested_at >= ? AND ingested_at < ? AND ${where}${appId ? ' AND app_id = ?' : ''} GROUP BY app_id`,
  ).bind(since, until, ...(appId ? [appId] : [])).all<{ app_id: string; n: number; affected: number }>();
  return new Map((rows.results ?? []).map((r) => [r.app_id, { n: r.n, affected: r.affected }]));
}

const CLIENT_ERRORS = "level = 'error' AND source != 'server'";
const ACTION_FAILURES = "source = 'server' AND category = 'action'";
const SERVER_5XX = "source = 'server' AND level = 'error'";

export async function evaluateErrorSpikes(opts: { env: Env; now?: number; appId?: string; windowMs?: number }): Promise<AlertReport> {
  const { env } = opts;
  const now = opts.now ?? Date.now();
  const windowMs = opts.windowMs ?? ALERT_WINDOW_MS;
  const db = env.DB;
  // Bucket the window so the cron's re-runs land on the same row (unique index).
  const windowEnd = Math.floor(now / windowMs) * windowMs + windowMs;
  const windowStart = windowEnd - windowMs;
  const prevStart = windowStart - windowMs;
  const alerts: Alert[] = [];

  // 1. Client runtime error spike: many errors, and a jump against the previous window.
  const cur = await perApp(db, windowStart, windowEnd, CLIENT_ERRORS, opts.appId);
  const prev = await perApp(db, prevStart, windowStart, CLIENT_ERRORS, opts.appId);
  for (const [appId, c] of cur) {
    const baseline = prev.get(appId)?.n ?? 0;
    if (c.n >= ERROR_SPIKE_MIN && c.n >= baseline * SPIKE_FACTOR) {
      alerts.push({ app_id: appId, kind: 'error_spike', window_start: windowStart, window_end: windowEnd, count: c.n, affected_users: c.affected, baseline,
        top: await topFor(db, appId, windowStart, windowEnd, CLIENT_ERRORS, []), build: await latestBuild(db, appId, windowStart) });
    }
  }

  // 2. Action failures: the runbook's "> 20 in 5 minutes" for one app.
  const actEnd = windowEnd, actStart = windowEnd - ACTION_FAILURE_WINDOW_MS;
  const act = await perApp(db, actStart, actEnd, ACTION_FAILURES, opts.appId);
  for (const [appId, c] of act) {
    if (c.n >= ACTION_FAILURE_MIN) {
      alerts.push({ app_id: appId, kind: 'action_failures', window_start: windowStart, window_end: windowEnd, count: c.n, affected_users: c.affected, baseline: prev.get(appId)?.n ?? 0,
        top: await topFor(db, appId, actStart, actEnd, ACTION_FAILURES, []), build: await latestBuild(db, appId, windowStart) });
    }
  }

  // 3. Sustained backend 5xx recorded server-side for an app.
  const s5 = await perApp(db, windowStart, windowEnd, SERVER_5XX, opts.appId);
  for (const [appId, c] of s5) {
    if (c.n >= SERVER_5XX_MIN) {
      alerts.push({ app_id: appId, kind: 'server_5xx', window_start: windowStart, window_end: windowEnd, count: c.n, affected_users: c.affected, baseline: 0,
        top: await topFor(db, appId, windowStart, windowEnd, SERVER_5XX, []), build: await latestBuild(db, appId, windowStart) });
    }
  }

  // 4. QA: consecutive failed platform-run flows since the last pass (deploy/cron triggers — #62 fixed the stuck-run signal).
  const qa = await db.prepare(
    `SELECT app_id, status, finished_at FROM app_test_runs WHERE trigger_kind IN ('deploy', 'cron') AND status IN ('passed', 'failed', 'error') AND finished_at >= ?${opts.appId ? ' AND app_id = ?' : ''} ORDER BY app_id, finished_at DESC`,
  ).bind(windowEnd - 24 * 60 * 60_000, ...(opts.appId ? [opts.appId] : [])).all<{ app_id: string; status: string; finished_at: number }>();
  const streak = new Map<string, { n: number; latest: number; done: boolean }>();
  for (const r of qa.results ?? []) {
    const s = streak.get(r.app_id) ?? { n: 0, latest: r.finished_at, done: false };
    if (!s.done) { if (r.status === 'passed') s.done = true; else s.n += 1; }
    streak.set(r.app_id, s);
  }
  for (const [appId, s] of streak) {
    if (s.n >= QA_CONSECUTIVE_FAILURES && s.latest >= windowStart) {
      alerts.push({ app_id: appId, kind: 'qa_failures', window_start: windowStart, window_end: windowEnd, count: s.n, affected_users: 0, baseline: 0,
        top: { categories: [{ category: 'qa', count: s.n }], operations: [], fingerprints: [] }, build: await latestBuild(db, appId, windowStart - 24 * 60 * 60_000) });
    }
  }

  // Persist (idempotent per bucket) and deliver to any registered webhook.
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
