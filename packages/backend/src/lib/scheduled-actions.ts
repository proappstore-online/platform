/**
 * Durable executor for manifest scheduled actions (#123). The backend cron is
 * only a nudge: a due minute is inserted, claimed and finished in D1 so cron
 * retries/overlaps are harmless. We deliberately do not seek missed minutes;
 * a schedule is maintenance, not a catch-up queue.
 */
import type { Env } from '../types.js';
import { prepareActionBatch, prepareActionQuery, type ToolManifest } from './action-sql.js';
import { forwardToDataWorker } from '../routes/actions.js';
import { scheduledCronMatches } from '../routes/tools.js';
import { dispatchWebhook } from './webhook-dispatch.js';
import { SCHEDULER_TICK_MINUTES } from './scheduler-tick.js';
import { appWorkerHost, LOADER_MAX_CONCURRENT, type AppWorkerExports } from './app-worker-host.js';

const SYSTEM_SCHEDULE_USER = 'system:schedule';
export const SCHEDULE_TICK_MS = SCHEDULER_TICK_MINUTES * 60_000;
export const STALE_SCHEDULE_CLAIM_MS = 10 * 60_000;
export const SCHEDULE_FAILURE_BREAKER = 5;

interface ScheduledToolRow { app_id: string; name: string; manifest: string; source: 'code' | 'console' | null }
interface ScheduledRunRow { run_id: string; app_id: string; action_name: string; source: 'code' | 'console'; claimed_at: number | null }

export interface ScheduledActionReport {
  due: number;
  claimed: number;
  succeeded: number;
  failed: number;
  recovered: number;
  skipped: number;
  /** App-worker schedules (#255), counted apart from actions. */
  workers?: WorkerScheduleReport;
}

export interface WorkerScheduleReport { due: number; claimed: number; succeeded: number; failed: number; skipped: number }

function minute(timestamp: number): number {
  return Math.floor(timestamp / 60_000) * 60_000;
}

function errorText(value: unknown): string {
  const text = value instanceof Error ? value.message : String(value);
  return text.slice(0, 1_000);
}

function changesFrom(endpoint: string, body: string): number | null {
  try {
    const decoded = JSON.parse(body) as { meta?: { changes?: unknown }; results?: Array<{ meta?: { changes?: unknown } }> };
    if (endpoint === 'batch') {
      return (decoded.results ?? []).reduce((total, result) => total + (Number(result.meta?.changes) || 0), 0);
    }
    const value = Number(decoded.meta?.changes);
    return Number.isFinite(value) ? value : null;
  } catch { return null; }
}

async function recoverStaleClaims(env: Env, now: number): Promise<number> {
  const rows = await env.DB.prepare(
    "SELECT run_id, app_id, action_name, source, claimed_at FROM scheduled_action_runs WHERE status = 'claimed' AND claimed_at < ?",
  ).bind(now - STALE_SCHEDULE_CLAIM_MS).all<ScheduledRunRow>();
  let recovered = 0;
  for (const row of rows.results ?? []) {
    const updated = await env.DB.prepare(
      "UPDATE scheduled_action_runs SET status = 'failed', finished_at = ?, error = ? WHERE run_id = ? AND status = 'claimed'",
    ).bind(now, 'scheduled executor did not finish (stale claim recovered)', row.run_id).run();
    if (updated.meta?.changes) {
      recovered += 1;
      await recordFailure(env, row.app_id, row.action_name, row.source, now);
    }
  }
  return recovered;
}

/** Insert then atomically claim the exact due minute. A live claim suppresses
 * later due minutes for that action: no overlap and no backfill queue. */
async function claimDue(
  env: Env,
  row: ScheduledToolRow,
  dueAt: number,
  now: number,
): Promise<string | null> {
  const source = row.source === 'console' ? 'console' : 'code';
  const disabled = await env.DB.prepare(
    'SELECT schedule_disabled_at FROM scheduled_action_state WHERE app_id = ? AND action_name = ? AND schedule_disabled_at IS NOT NULL',
  ).bind(row.app_id, row.name).first<{ schedule_disabled_at: number }>();
  if (disabled) return null;
  const active = await env.DB.prepare(
    "SELECT 1 AS active FROM scheduled_action_runs WHERE app_id = ? AND action_name = ? AND status = 'claimed' LIMIT 1",
  ).bind(row.app_id, row.name).first();
  if (active) return null;

  const runId = crypto.randomUUID();
  await env.DB.prepare(
    "INSERT OR IGNORE INTO scheduled_action_runs (run_id, app_id, action_name, source, due_at, status) VALUES (?, ?, ?, ?, ?, 'due')",
  ).bind(runId, row.app_id, row.name, source, dueAt).run();
  const claimed = await env.DB.prepare(
    // The earlier active-row read is a fast path. The NOT EXISTS predicate is
    // the race-proof guard: an overlapping tick can otherwise read "no active
    // claim" just before this one commits, then claim its next due minute.
    "UPDATE scheduled_action_runs SET status = 'claimed', claimed_at = ? WHERE app_id = ? AND action_name = ? AND due_at = ? AND status = 'due' AND NOT EXISTS (SELECT 1 FROM scheduled_action_runs AS active WHERE active.app_id = ? AND active.action_name = ? AND active.status = 'claimed')",
  ).bind(now, row.app_id, row.name, dueAt, row.app_id, row.name).run();
  if (!claimed.meta?.changes) return null;
  // A prior invocation can die after INSERT and before the claim. In that
  // case the durable due row owns a different UUID; always finish the UUID we
  // actually claimed rather than leaving it stranded as `claimed`.
  const actual = await env.DB.prepare(
    "SELECT run_id FROM scheduled_action_runs WHERE app_id = ? AND action_name = ? AND due_at = ? AND status = 'claimed'",
  ).bind(row.app_id, row.name, dueAt).first<{ run_id: string }>();
  return actual?.run_id ?? null;
}

async function recordSuccess(env: Env, runId: string, appId: string, action: string, source: string, changes: number | null, now: number): Promise<void> {
  const finished = await env.DB.prepare(
    "UPDATE scheduled_action_runs SET status = 'succeeded', finished_at = ?, changes = ?, error = NULL WHERE run_id = ? AND status = 'claimed'",
  ).bind(now, changes, runId).run();
  // Do not let a late completion clear a breaker after stale-claim recovery
  // has already converted this run to failed.
  if (!finished.meta?.changes) return;
  await env.DB.prepare(
    "INSERT INTO scheduled_action_state (app_id, action_name, source, consecutive_failures, schedule_disabled_at) VALUES (?, ?, ?, 0, NULL) ON CONFLICT(app_id, action_name) DO UPDATE SET source = excluded.source, consecutive_failures = 0, schedule_disabled_at = NULL",
  ).bind(appId, action, source).run();
}

/** Increment the durable streak. Exactly the transition to five creates an
 * owner-visible alert; retries of the same disabled schedule cannot spam it. */
async function recordFailure(env: Env, appId: string, action: string, source: string, now: number): Promise<number> {
  await env.DB.prepare(
    `INSERT INTO scheduled_action_state (app_id, action_name, source, consecutive_failures, schedule_disabled_at)
     VALUES (?, ?, ?, 1, NULL)
     ON CONFLICT(app_id, action_name) DO UPDATE SET
       source = excluded.source,
       consecutive_failures = scheduled_action_state.consecutive_failures + 1,
       schedule_disabled_at = CASE WHEN scheduled_action_state.consecutive_failures + 1 >= ? AND scheduled_action_state.schedule_disabled_at IS NULL THEN ? ELSE scheduled_action_state.schedule_disabled_at END`,
  ).bind(appId, action, source, SCHEDULE_FAILURE_BREAKER, now).run();
  const state = await env.DB.prepare(
    'SELECT consecutive_failures, schedule_disabled_at FROM scheduled_action_state WHERE app_id = ? AND action_name = ?',
  ).bind(appId, action).first<{ consecutive_failures: number; schedule_disabled_at: number | null }>();
  const failures = state?.consecutive_failures ?? 1;
  if (failures >= SCHEDULE_FAILURE_BREAKER && state?.schedule_disabled_at === now) {
    const windowStart = minute(now);
    const alert = await env.DB.prepare(
      'INSERT OR IGNORE INTO app_alerts (app_id, kind, window_start, window_end, count, affected_users, baseline, top, build_meta, created_at) VALUES (?, ?, ?, ?, ?, 0, 0, ?, NULL, ?)',
    ).bind(
      appId,
      'scheduled_action_failures',
      windowStart,
      windowStart + SCHEDULE_TICK_MS,
      failures,
      JSON.stringify({ categories: [{ category: 'scheduled_action', count: failures }], operations: [{ operation: action, count: failures }], fingerprints: [] }),
      now,
    ).run();
    if (alert.meta?.changes) {
      // Follow the existing app_alerts delivery channel. Console history is
      // always present; an owner-configured webhook receives the same redacted
      // operational facts without a new notification subsystem.
      await dispatchWebhook(env.DB, appId, 'app.alert', {
        event: 'app.alert', app_id: appId, kind: 'scheduled_action_failures',
        action, count: failures, detected_at: now,
      });
    }
    console.error(`[schedule] disabled app=${appId} action=${action} after ${failures} consecutive failures`);
  }
  return failures;
}

async function executeClaimed(env: Env, row: ScheduledToolRow, manifest: ToolManifest, runId: string, now: number): Promise<'succeeded' | 'failed'> {
  const source = row.source === 'console' ? 'console' : 'code';
  try {
    const endpoint = manifest.operation === 'batch' ? 'batch' : 'execute';
    const payload = manifest.operation === 'batch'
      ? { statements: prepareActionBatch(manifest, manifest.schedule!.params, SYSTEM_SCHEDULE_USER) }
      : prepareActionQuery(manifest, manifest.schedule!.params, SYSTEM_SCHEDULE_USER);
    const response = await forwardToDataWorker(env, row.app_id, endpoint, payload, null);
    const body = await response.text();
    if (!response.ok) throw new Error(`data worker ${response.status}: ${body.slice(0, 800)}`);
    await recordSuccess(env, runId, row.app_id, row.name, source, changesFrom(endpoint, body), now);
    console.log(`[schedule] succeeded app=${row.app_id} action=${row.name} run=${runId}`);
    return 'succeeded';
  } catch (error) {
    await failRun(env, row.app_id, row.name, source, runId, errorText(error), now);
    return 'failed';
  }
}

/** Finish a claimed run as failed and advance the breaker — once, even if recovery got there first. */
async function failRun(env: Env, appId: string, action: string, source: string, runId: string, message: string, now: number): Promise<void> {
  const failedRun = await env.DB.prepare(
    "UPDATE scheduled_action_runs SET status = 'failed', finished_at = ?, error = ? WHERE run_id = ? AND status = 'claimed'",
  ).bind(now, message, runId).run();
  const failures = failedRun.meta?.changes ? await recordFailure(env, appId, action, source, now) : null;
  console.error(`[schedule] failed app=${appId} action=${action} run=${runId} failures=${failures}: ${message}`);
}

// ── App-worker schedules (#255, ADR-009 §3–§4) ───────────────────────────────

/** Run rows of a worker schedule are named `worker:<name>`; `:` is not legal in an action name, so they never collide. */
export const WORKER_RUN_PREFIX = 'worker:';
/** A worker schedule gets 5 minutes, under the 10-minute stale-claim window, so a hung run fails before recovery sees it. */
export const WORKER_SCHEDULE_TIMEOUT_MS = 5 * 60_000;

export interface ClaimedWorkerRun { appId: string; schedule: string; params: Record<string, unknown>; runId: string }

/**
 * Deliver one claimed worker run and say whether it succeeded. The one place a
 * run reaches the worker: #257 swaps this for "enqueue" (status `queued`).
 */
export type WorkerRunDispatch = (env: Env, run: ClaimedWorkerRun, ctx?: AppWorkerExports) => Promise<{ ok: true } | { ok: false; error: string }>;

export const invokeWorkerRun: WorkerRunDispatch = async (env, run, ctx) => {
  try {
    const result = await appWorkerHost(env, ctx).invoke(
      run.appId,
      // The envelope id is the run id: stable for this run, so handlers can be idempotent on it (ADR-009 §3).
      { id: run.runId, type: 'schedule', name: run.schedule, attempt: 1, payload: run.params },
      { timeoutMs: WORKER_SCHEDULE_TIMEOUT_MS },
    );
    if (result.status === 'succeeded') return { ok: true };
    return { ok: false, error: result.status === 'timeout' ? `worker timed out after ${WORKER_SCHEDULE_TIMEOUT_MS} ms` : `worker answered ${result.httpStatus ?? 'no response'}: ${(result.body ?? '').slice(0, 300)}` };
  } catch (e) {
    return { ok: false, error: errorText(e) };
  }
};

interface WorkerScheduleRow { app_id: string; name: string; cron: string; params: string }

/** A run-now due_at: `now` in ms, never on a minute, so it is told apart from (and never collides with) a tick's row. */
export function runNowDueAt(now: number): number {
  return now % 60_000 === 0 ? now + 1 : now;
}

/** Active worker schedules: enabled, deployed worker of an app that still exists (#253's activeAppWorker rule). */
const ACTIVE_WORKER_SCHEDULES = `
  FROM app_worker_schedules s
  INNER JOIN app_workers w ON w.app_id = s.app_id
  INNER JOIN apps a ON a.id = s.app_id
  WHERE w.enabled = 1 AND w.deployed_at IS NOT NULL`;

function paramsOf(raw: string): Record<string, unknown> {
  try {
    const v = JSON.parse(raw) as unknown;
    return v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {};
  } catch { return {}; }
}

/** Run `tasks` with at most `limit` in flight. */
async function inPool<T>(items: T[], limit: number, task: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  await Promise.allSettled(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) await task(items[next++]!);
  }));
}

/**
 * Claim this tick's worker runs, then deliver them concurrently (≤ 4 at once,
 * the loader's per-request cap) instead of inline, so one slow worker cannot
 * hold up the rest. Run-now rows (`due`, inserted by the owner's route with a
 * millisecond due_at) are claimed first, through the same race-proof claim.
 */
export async function runWorkerSchedules(
  env: Env, now: number, dueAt: number, ctx?: AppWorkerExports, dispatch: WorkerRunDispatch = invokeWorkerRun,
): Promise<WorkerScheduleReport> {
  const report: WorkerScheduleReport = { due: 0, claimed: 0, succeeded: 0, failed: 0, skipped: 0 };
  const schedules = (await env.DB.prepare(`SELECT s.app_id, s.name, s.cron, s.params ${ACTIVE_WORKER_SCHEDULES}`).all<WorkerScheduleRow>()).results ?? [];
  const byRun = new Map(schedules.map((s) => [`${s.app_id}\u0000${WORKER_RUN_PREFIX}${s.name}`, s]));
  const runs: ClaimedWorkerRun[] = [];
  const claim = async (s: WorkerScheduleRow, at: number) => {
    report.due += 1;
    const runId = await claimDue(env, { app_id: s.app_id, name: `${WORKER_RUN_PREFIX}${s.name}`, manifest: '', source: 'code' }, at, now);
    if (!runId) { report.skipped += 1; return; }
    report.claimed += 1;
    runs.push({ appId: s.app_id, schedule: s.name, params: paramsOf(s.params), runId });
  };

  const pending = (await env.DB.prepare(
    // Only run-now rows: their due_at is never minute-aligned (runNowDueAt). A minute-aligned
    // 'due' row is a tick's orphan, and the scheduler never backfills missed minutes.
    `SELECT app_id, action_name, due_at FROM scheduled_action_runs
      WHERE status = 'due' AND action_name LIKE '${WORKER_RUN_PREFIX}%' AND due_at % 60000 <> 0 ORDER BY due_at`,
  ).all<{ app_id: string; action_name: string; due_at: number }>()).results ?? [];
  for (const p of pending) {
    const s = byRun.get(`${p.app_id}\u0000${p.action_name}`);
    if (s) await claim(s, p.due_at);
  }
  for (const s of schedules) if (scheduledCronMatches(s.cron, dueAt)) await claim(s, dueAt);

  await inPool(runs, LOADER_MAX_CONCURRENT, async (run) => {
    const action = `${WORKER_RUN_PREFIX}${run.schedule}`;
    const outcome = await dispatch(env, run, ctx).catch((e) => ({ ok: false as const, error: errorText(e) }));
    const finishedAt = Date.now();
    try {
      if (outcome.ok) {
        await recordSuccess(env, run.runId, run.appId, action, 'code', null, finishedAt);
        report.succeeded += 1;
      } else {
        await failRun(env, run.appId, action, 'code', run.runId, outcome.error, finishedAt);
        report.failed += 1;
      }
    } catch (e) {
      console.error(`[schedule] recording worker run ${run.runId} failed: ${errorText(e)}`);
    }
  });
  return report;
}

export async function runScheduledActions(opts: { env: Env; now?: number; ctx?: AppWorkerExports; dispatch?: WorkerRunDispatch }): Promise<ScheduledActionReport> {
  const now = opts.now ?? Date.now();
  const dueAt = minute(now);
  const report: ScheduledActionReport = { due: 0, claimed: 0, succeeded: 0, failed: 0, recovered: 0, skipped: 0 };
  report.recovered = await recoverStaleClaims(opts.env, now);
  const rows = await opts.env.DB.prepare('SELECT app_id, name, manifest, source FROM app_tools').all<ScheduledToolRow>();
  for (const row of rows.results ?? []) {
    let manifest: ToolManifest;
    try { manifest = JSON.parse(row.manifest) as ToolManifest; } catch { continue; }
    if (!manifest.schedule || !scheduledCronMatches(manifest.schedule.cron, dueAt)) continue;
    report.due += 1;
    const runId = await claimDue(opts.env, row, dueAt, now);
    if (!runId) { report.skipped += 1; continue; }
    report.claimed += 1;
    const outcome = await executeClaimed(opts.env, row, manifest, runId, now);
    report[outcome] += 1;
  }
  // After, and isolated from, the action loop: a worker failure never fails an action run (#255).
  try {
    report.workers = await runWorkerSchedules(opts.env, now, dueAt, opts.ctx, opts.dispatch);
  } catch (e) {
    console.error(`[schedule] worker schedules failed: ${errorText(e)}`);
  }
  return report;
}
