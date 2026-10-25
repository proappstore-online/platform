/**
 * Reliability objectives and burn-rate alerting (#395).
 *
 * An owner may set a reliability objective per operation family of their app
 * (`app_reliability_objectives`, families of #391's request metrics). No
 * objective, no reliability alert: the platform never invents a target, and
 * the defaults below are fixture values until the owner confirms production
 * ones. The per-window #107 alerts (lib/error-alerts.ts) are unchanged.
 *
 * Good and bad events come from #391's request outcomes in Analytics Engine
 * (`pas_app_requests`), per family:
 *   - bad   = 5xx answers;
 *   - total = every counted request (ok + 4xx + 5xx). A 4xx — validation,
 *     refusal, a caller's cancellation — is a good event: it never burns budget.
 *   - Requests excluded from the metric (telemetry routes, preflights,
 *     WebSocket upgrades) are in neither.
 * AE samples (counts weighted by `_sample_interval`) and lags, so windows end
 * EVAL_LAG_MS before the evaluation time and are aligned to 5-minute buckets.
 *
 * Rules, per family with an enabled objective (Google SRE multi-window,
 * multi-burn-rate):
 *   - burn_fast:<f>  burn ≥ 14.4 over 1 h AND over the last 5 min
 *   - burn_slow:<f>  burn ≥ 6    over 6 h AND over the last 30 min
 *   - outage:<f>     the last 3 completed 5-min buckets each have ≥ 3
 *                    requests and ≥ 90% 5xx (sustained, not a blip)
 * burn = (bad / total) / (1 − target). With fewer than MIN_REQUESTS in the long
 * window a burn rule is `low_traffic`: not evaluated, no state change (a rate
 * over a handful of requests is noise) — synthetic QA flows (#107
 * `qa_failures`) are the signal for low-traffic apps. When AE cannot be read
 * the app's `monitoring_degraded` rule fires and no burn rule changes state:
 * missing telemetry is never read as success or as a burn rate.
 *
 * Incidents (`app_incidents`): one open incident per app and rule. Firing
 * inserts it and notifies; re-firing only updates `last_seen_at`; the owner may
 * acknowledge (no further notification); a rule that evaluates false recovers it
 * and notifies once. Notifications go only to the owner's existing opt-in
 * `app.alert` webhooks.
 */

import { cfAnalyticsSql } from '../routes/analytics-shared.js';
import type { Env } from '../types.js';
import { REQUEST_METRICS_DATASET } from './telemetry-datasets.js';
import { dispatchWebhook } from './webhook-dispatch.js';
import { DISPATCH_LEASE_MS } from './error-alerts.js';

export const BUCKET_MS = 5 * 60_000;
export const EVAL_LAG_MS = 5 * 60_000;
const FAST = { longMs: 60 * 60_000, shortMs: 5 * 60_000, factor: 14.4 } as const;
const SLOW = { longMs: 6 * 60 * 60_000, shortMs: 30 * 60_000, factor: 6 } as const;
/** Requests in a burn rule's long window below which it is `low_traffic`. */
const MIN_REQUESTS = 50;
const OUTAGE = { buckets: 3, minPerBucket: 3, ratio: 0.9 } as const;
/** Fixture objective for tests and dry-run examples — not a production target. */
export const FIXTURE_TARGET = 0.99;
/** Apps with objectives read per Analytics Engine query, bounding each query. */
const APPS_PER_QUERY = 50;
export const ALERT_EVENT = 'app.alert';

/** Requests of one app and family in one 5-minute bucket starting at `start` (ms). */
export interface OutcomeBucket { app: string; family: string; start: number; total: number; bad: number }
/** Reads buckets for `apps` in [since, until). Throws when telemetry cannot be read. */
export type OutcomeReader = (env: Env, apps: string[], since: number, until: number) => Promise<OutcomeBucket[]>;
export interface Objective { app: string; family: string; target: number }

type RuleStatus = 'firing' | 'ok' | 'low_traffic' | 'degraded';
export interface RuleResult {
  app: string;
  rule: string;
  status: RuleStatus;
  /** Rates and counts only — never ids, paths or payloads. */
  detail: Record<string, number | string | null>;
}

/** End of the newest window the evaluator may judge: lagged and bucket-aligned. */
export function evaluationEnd(now: number): number {
  return Math.floor((now - EVAL_LAG_MS) / BUCKET_MS) * BUCKET_MS;
}

function sum(buckets: OutcomeBucket[], since: number, until: number): { total: number; bad: number } {
  let total = 0;
  let bad = 0;
  for (const b of buckets) if (b.start >= since && b.start < until) { total += b.total; bad += b.bad; }
  return { total, bad };
}

const burn = (c: { total: number; bad: number }, target: number) => (c.total ? (c.bad / c.total) / (1 - target) : 0);
const round = (n: number) => Math.round(n * 1000) / 1000;

/** The three rules for one objective, from that app+family's buckets. Pure. */
export function assessObjective(o: Objective, buckets: OutcomeBucket[], end: number): RuleResult[] {
  const results: RuleResult[] = [];
  for (const [name, w] of [['burn_fast', FAST], ['burn_slow', SLOW]] as const) {
    const long = sum(buckets, end - w.longMs, end);
    const short = sum(buckets, end - w.shortMs, end);
    const detail = {
      family: o.family, target: o.target, factor: w.factor,
      long_total: round(long.total), long_bad: round(long.bad), long_burn: round(burn(long, o.target)),
      short_total: round(short.total), short_bad: round(short.bad), short_burn: round(burn(short, o.target)),
      window_end: end,
    };
    const status: RuleStatus = long.total < MIN_REQUESTS
      ? 'low_traffic'
      : burn(long, o.target) >= w.factor && short.total > 0 && burn(short, o.target) >= w.factor ? 'firing' : 'ok';
    results.push({ app: o.app, rule: `${name}:${o.family}`, status, detail });
  }
  const recent = Array.from({ length: OUTAGE.buckets }, (_, i) => sum(buckets, end - (i + 1) * BUCKET_MS, end - i * BUCKET_MS));
  const outage = recent.every((b) => b.total >= OUTAGE.minPerBucket && b.bad / b.total >= OUTAGE.ratio);
  results.push({
    app: o.app,
    rule: `outage:${o.family}`,
    status: outage ? 'firing' : 'ok',
    detail: { family: o.family, buckets: OUTAGE.buckets, ratios: recent.map((b) => (b.total ? round(b.bad / b.total) : 0)).join(','), window_end: end },
  });
  return results;
}

/**
 * Assess every objective. When telemetry cannot be read, each app's rules are
 * `degraded` (no state change) and its `monitoring_degraded` rule fires.
 */
export async function assessAll(env: Env, objectives: Objective[], now: number, read: OutcomeReader): Promise<RuleResult[]> {
  const end = evaluationEnd(now);
  const since = end - SLOW.longMs;
  const apps = [...new Set(objectives.map((o) => o.app))];
  const results: RuleResult[] = [];
  for (let i = 0; i < apps.length; i += APPS_PER_QUERY) {
    const chunk = apps.slice(i, i + APPS_PER_QUERY);
    const mine = objectives.filter((o) => chunk.includes(o.app));
    let buckets: OutcomeBucket[] | null = null;
    let reason = '';
    try {
      buckets = await read(env, chunk, since, end);
    } catch (e) {
      reason = e instanceof Error && /not configured/.test(e.message) ? 'analytics_not_configured' : 'analytics_unavailable';
    }
    for (const app of chunk) {
      if (!buckets) {
        results.push({ app, rule: 'monitoring_degraded', status: 'firing', detail: { reason, window_end: end } });
        for (const o of mine.filter((x) => x.app === app)) {
          for (const r of ['burn_fast', 'burn_slow', 'outage']) results.push({ app, rule: `${r}:${o.family}`, status: 'degraded', detail: { family: o.family, reason } });
        }
        continue;
      }
      results.push({ app, rule: 'monitoring_degraded', status: 'ok', detail: { window_end: end } });
      for (const o of mine.filter((x) => x.app === app)) {
        results.push(...assessObjective(o, buckets.filter((b) => b.app === app && b.family === o.family), end));
      }
    }
  }
  return results;
}

/** Analytics Engine reader: weighted 5-minute buckets per app and family, 5xx as bad. */
export const readOutcomesFromAnalytics: OutcomeReader = async (env, apps, since, until) => {
  const safe = apps.filter((a) => /^[a-z][a-z0-9-]{0,57}$/.test(a));
  if (safe.length === 0) return [];
  const sinceMin = Math.ceil((Date.now() - since) / 60_000);
  const rows = await cfAnalyticsSql<{ app: string; family: string; outcome: string; t: number | string; n: number | string }>(env,
    `SELECT index1 AS app, blob3 AS family, blob1 AS outcome,
            toUnixTimestamp(toStartOfInterval(timestamp, INTERVAL '5' MINUTE)) AS t,
            SUM(_sample_interval) AS n
       FROM ${REQUEST_METRICS_DATASET}
      WHERE index1 IN (${safe.map((a) => `'${a}'`).join(', ')})
        AND timestamp > NOW() - INTERVAL '${sinceMin}' MINUTE
      GROUP BY app, family, outcome, t`);
  const byKey = new Map<string, OutcomeBucket>();
  for (const r of rows) {
    const start = Number(r.t) * 1000;
    if (!(start >= since && start < until)) continue;
    const key = `${r.app}|${r.family}|${start}`;
    const b = byKey.get(key) ?? { app: r.app, family: r.family || 'unlabelled', start, total: 0, bad: 0 };
    const n = Number(r.n) || 0;
    b.total += n;
    if (r.outcome === '5xx') b.bad += n;
    byKey.set(key, b);
  }
  return [...byKey.values()];
};

/** Enabled objectives, all apps or one. */
export async function loadObjectives(db: D1Database, appId?: string): Promise<Objective[]> {
  const rows = await db.prepare(
    `SELECT app_id, family, target FROM app_reliability_objectives WHERE enabled = 1${appId ? ' AND app_id = ?1' : ''} ORDER BY app_id, family LIMIT 1000`,
  ).bind(...(appId ? [appId] : [])).all<{ app_id: string; family: string; target: number }>();
  return (rows.results ?? []).map((r) => ({ app: r.app_id, family: r.family, target: r.target }));
}

export interface ApplyReport { opened: number; recovered: number; notified: number }

/**
 * Apply rule results to incidents and notify on transitions only. `firing`
 * opens (or keeps open) one incident per app+rule; `ok` recovers an open one;
 * `low_traffic` and `degraded` change nothing.
 */
export async function applyResults(db: D1Database, results: RuleResult[], now: number): Promise<ApplyReport> {
  const report: ApplyReport = { opened: 0, recovered: 0, notified: 0 };
  // #395/#389: record state changes only; the notification each one owes is sent
  // by deliverPendingIncidents, from the row, so a run that dies in between
  // leaves it owed rather than lost.
  for (const r of results) {
    const detail = JSON.stringify(r.detail);
    if (r.status === 'firing') {
      const opened = await db.prepare(
        "INSERT OR IGNORE INTO app_incidents (app_id, rule, state, opened_at, last_seen_at, detail) VALUES (?1, ?2, 'firing', ?3, ?3, ?4)",
      ).bind(r.app, r.rule, now, detail).run();
      if (opened.meta?.changes) {
        report.opened += 1;
        console.warn(`[reliability] firing app=${r.app} rule=${r.rule}`);
      } else {
        await db.prepare("UPDATE app_incidents SET last_seen_at = ?3, detail = ?4 WHERE app_id = ?1 AND rule = ?2 AND state != 'recovered'")
          .bind(r.app, r.rule, now, detail).run();
      }
    } else if (r.status === 'ok') {
      const recovered = await db.prepare(
        "UPDATE app_incidents SET state = 'recovered', recovered_at = ?3, detail = ?4 WHERE app_id = ?1 AND rule = ?2 AND state != 'recovered' RETURNING id",
      ).bind(r.app, r.rule, now, detail).all<{ id: number }>();
      if (recovered.results?.length) {
        report.recovered += 1;
        console.warn(`[reliability] recovered app=${r.app} rule=${r.rule}`);
      }
    }
  }
  return report;
}

/** At most this many incident notifications per run, like the app.alert retry cap. */
const MAX_INCIDENT_NOTIFICATIONS = 50;

interface OwedRow { id: number; app_id: string; rule: string; owed: 'firing' | 'recovered'; at: number; detail: string }

/**
 * #395, the #389 pattern: send every incident transition that is recorded but not
 * yet notified — firing once, recovered once; acknowledging owes nothing.
 * Each is claimed with a conditional UPDATE (a DISPATCH_LEASE_MS lease) so two
 * overlapping runs never both send, then stamped `notified_state` once
 * dispatchWebhook returns (a failed HTTP delivery is webhook_deliveries' to retry).
 * A run that dies before sending leaves it owed; one that dies mid-send is resent
 * once after the lease. The payload is rebuilt from the row, so a late send
 * carries the transition's own time.
 */
async function deliverPendingIncidents(db: D1Database, now: number): Promise<number> {
  const { results } = await db.prepare(
    `SELECT id, app_id, rule, detail,
            CASE state WHEN 'recovered' THEN 'recovered' ELSE 'firing' END AS owed,
            CASE state WHEN 'recovered' THEN recovered_at ELSE opened_at END AS at
       FROM app_incidents
      WHERE COALESCE(notified_state, '') != CASE state WHEN 'recovered' THEN 'recovered' ELSE 'firing' END
      ORDER BY id LIMIT ?1`,
  ).bind(MAX_INCIDENT_NOTIFICATIONS).all<OwedRow>();
  let sent = 0;
  for (const row of results ?? []) {
    const claim = await db.prepare(
      `UPDATE app_incidents SET notify_claimed_at = ?1
        WHERE id = ?2 AND COALESCE(notified_state, '') != ?3
          AND (notify_claimed_at IS NULL OR notify_claimed_at <= ?1 - ?4)`,
    ).bind(now, row.id, row.owed, DISPATCH_LEASE_MS).run();
    if (!claim.meta?.changes) continue;
    let detail: unknown = {};
    try { detail = JSON.parse(row.detail); } catch { /* sent without detail */ }
    await dispatchWebhook(db, row.app_id, ALERT_EVENT, {
      event: ALERT_EVENT, kind: 'reliability', state: row.owed, app_id: row.app_id, rule: row.rule, detail, at: row.at,
    });
    // Stamp only what was claimed; the claim is released so a later recovery can be claimed.
    await db.prepare(
      `UPDATE app_incidents SET notified_state = ?3, notify_claimed_at = NULL, notify_attempts = notify_attempts + 1
        WHERE id = ?1 AND notify_claimed_at = ?2`,
    ).bind(row.id, now, row.owed).run();
    sent += 1;
  }
  return sent;
}

/**
 * #429: an open incident whose objective is gone — deleted or disabled — is never
 * assessed again, so it stayed firing forever, and through the partial unique
 * index it blocked a new incident for the same rule if the objective came back.
 * Recover it: a `<kind>:<family>` rule whose family has no enabled objective for
 * its app, and `monitoring_degraded` for an app with none at all. The recovery is
 * then notified once, like any other (deliverPendingIncidents).
 */
async function recoverOrphanedIncidents(db: D1Database, now: number): Promise<number> {
  const res = await db.prepare(
    `UPDATE app_incidents SET state = 'recovered', recovered_at = ?1, detail = ?2
      WHERE state != 'recovered' AND (
        (instr(rule, ':') > 0 AND NOT EXISTS (SELECT 1 FROM app_reliability_objectives o
           WHERE o.app_id = app_incidents.app_id AND o.enabled = 1 AND o.family = substr(app_incidents.rule, instr(app_incidents.rule, ':') + 1)))
        OR (rule = 'monitoring_degraded' AND NOT EXISTS (SELECT 1 FROM app_reliability_objectives o
           WHERE o.app_id = app_incidents.app_id AND o.enabled = 1)))`,
  ).bind(now, JSON.stringify({ reason: 'objective_removed' })).run();
  const n = res.meta?.changes ?? 0;
  if (n) console.warn(`[reliability] recovered ${n} incident(s) whose objective was removed or disabled`);
  return n;
}

/** The cron step: assess every enabled objective and apply the results. Never throws. */
export async function evaluateReliability(opts: { env: Env; now?: number | Date; read?: OutcomeReader }): Promise<ApplyReport & { evaluated: number }> {
  // A number however the caller got it (a harness can hand the scheduled time over as a Date): it is bound into D1.
  const now = Number(opts.now ?? Date.now());
  const objectives = await loadObjectives(opts.env.DB);
  const results = objectives.length ? await assessAll(opts.env, objectives, now, opts.read ?? readOutcomesFromAnalytics) : [];
  const report = await applyResults(opts.env.DB, results, now);
  report.recovered += await recoverOrphanedIncidents(opts.env.DB, now);
  // Always: an objective removed after its incident changed state still owes that notification.
  report.notified = await deliverPendingIncidents(opts.env.DB, now);
  return { ...report, evaluated: results.length };
}
