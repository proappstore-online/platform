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
import { appWorkerHost, type AppWorkerExports } from './app-worker-host.js';
import { HOOK_BODY_PREFIX, scheduleMessage, sendAppEvent } from './app-event-queue.js';
import { STALE_RECEIVED_SQL } from '../routes/hooks.js';
import { AppWorkerQuotaError } from './app-worker-usage.js';

const SYSTEM_SCHEDULE_USER = 'system:schedule';
export const SCHEDULE_TICK_MS = SCHEDULER_TICK_MINUTES * 60_000;
export const STALE_SCHEDULE_CLAIM_MS = 10 * 60_000;
/** A queued worker run (#257) is mid-retry for up to ~40 min (620 s of backoff plus 6 invocations of 5 min); 60 min is past that. */
export const STALE_QUEUED_RUN_MS = 60 * 60_000;
/** Run states in which a run is live: no later run of the same action is claimed over it. */
type LiveRunStatus = 'claimed' | 'queued';
export const SCHEDULE_FAILURE_BREAKER = 5;
/**
 * #319: a `running` app-worker invocation older than this was cut off (an evicted
 * isolate, a killed consumer) and will never record its outcome. Above the
 * longest invocation budget, a 5-minute schedule, and equal to the stale-claim window.
 */
export const STALE_INVOCATION_MS = 10 * 60_000;

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
  /** #319: stale hook deliveries failed and stale invocations timed out on this tick. */
  recovery?: { hook_deliveries: number; invocations: number };
}

/**
 * #319: end what was cut off and will never finish on its own. Each UPDATE matches
 * only rows that are still stale, so a concurrent tick or a late finish cannot
 * double-count or overwrite a newer state.
 *
 * - A hook delivery still `received` past its lease (routes/hooks.ts) becomes
 *   `failed`. The sender's redelivery then retries it through the normal path, and
 *   any body spilled to R2 for the queue is deleted.
 * - An invocation still `running` after STALE_INVOCATION_MS becomes `timeout`. Its
 *   PAS calls and caller grant stop working, because both need it `running`.
 */
export async function recoverStaleAppWorkerState(env: Env, now: number): Promise<{ hook_deliveries: number; invocations: number }> {
  const hooks = await env.DB.prepare(
    `UPDATE app_hook_deliveries SET status = 'failed', finished_at = ?,
            error = 'processing was cut off and never finished (lease expired); redeliver it from the sender'
      WHERE ${STALE_RECEIVED_SQL} RETURNING id, app_id`,
  ).bind(now, now).all<{ id: string; app_id: string }>();
  for (const r of hooks.results ?? []) {
    await env.STORAGE.delete(`${HOOK_BODY_PREFIX}${r.app_id}/${r.id}`).catch(() => {});
  }
  const invocations = await env.DB.prepare(
    `UPDATE app_worker_invocations SET status = 'timeout', finished_at = ?,
            error = 'abandoned: the invocation never finished (stale running invocation recovered)'
      WHERE status = 'running' AND started_at < ? RETURNING id`,
  ).bind(now, now - STALE_INVOCATION_MS).all<{ id: string }>();
  return { hook_deliveries: hooks.results?.length ?? 0, invocations: invocations.results?.length ?? 0 };
}

/** `queued`: runs handed to the app-events queue; `failed`: runs that could not be enqueued. The outcome of a queued run is the consumer's. */
export interface WorkerScheduleReport { due: number; claimed: number; queued: number; failed: number; skipped: number }

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

async function recoverStale(env: Env, now: number, status: LiveRunStatus, maxAgeMs: number, message: string): Promise<number> {
  const rows = await env.DB.prepare(
    `SELECT run_id, app_id, action_name, source, claimed_at FROM scheduled_action_runs WHERE status = '${status}' AND claimed_at < ?`,
  ).bind(now - maxAgeMs).all<ScheduledRunRow>();
  let recovered = 0;
  for (const row of rows.results ?? []) {
    const updated = await env.DB.prepare(
      `UPDATE scheduled_action_runs SET status = 'failed', finished_at = ?, error = ? WHERE run_id = ? AND status = '${status}'`,
    ).bind(now, message, row.run_id).run();
    if (updated.meta?.changes) {
      recovered += 1;
      await recordFailure(env, row.app_id, row.action_name, row.source, now);
    }
  }
  return recovered;
}

/** Fail claimed runs whose executor died, and queued runs whose retry budget is long spent. Only the update that wins a row counts it toward the breaker. */
async function recoverStaleClaims(env: Env, now: number): Promise<number> {
  return await recoverStale(env, now, 'claimed', STALE_SCHEDULE_CLAIM_MS, 'scheduled executor did not finish (stale claim recovered)')
    + await recoverStale(env, now, 'queued', STALE_QUEUED_RUN_MS, 'queued run never finished (stale queued run recovered)');
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
    "SELECT 1 AS active FROM scheduled_action_runs WHERE app_id = ? AND action_name = ? AND status IN ('claimed', 'queued') LIMIT 1",
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
    "UPDATE scheduled_action_runs SET status = 'claimed', claimed_at = ? WHERE app_id = ? AND action_name = ? AND due_at = ? AND status = 'due' AND NOT EXISTS (SELECT 1 FROM scheduled_action_runs AS active WHERE active.app_id = ? AND active.action_name = ? AND active.status IN ('claimed', 'queued'))",
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

export async function recordSuccess(env: Env, runId: string, appId: string, action: string, source: string, changes: number | null, now: number, from: LiveRunStatus = 'claimed'): Promise<void> {
  const finished = await env.DB.prepare(
    `UPDATE scheduled_action_runs SET status = 'succeeded', finished_at = ?, changes = ?, error = NULL WHERE run_id = ? AND status = '${from}'`,
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
export async function recordFailure(env: Env, appId: string, action: string, source: string, now: number): Promise<number> {
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
async function failRun(env: Env, appId: string, action: string, source: string, runId: string, message: string, now: number, from: LiveRunStatus = 'claimed'): Promise<void> {
  const failedRun = await env.DB.prepare(
    `UPDATE scheduled_action_runs SET status = 'failed', finished_at = ?, error = ? WHERE run_id = ? AND status = '${from}'`,
  ).bind(now, message, runId).run();
  const failures = failedRun.meta?.changes ? await recordFailure(env, appId, action, source, now) : null;
  console.error(`[schedule] failed app=${appId} action=${action} run=${runId} failures=${failures}: ${message}`);
}

// ── App-worker schedules (#255, ADR-009 §3–§4) ───────────────────────────────

/** Run rows of a worker schedule are named `worker:<name>`; `:` is not legal in an action name, so they never collide. */
export const WORKER_RUN_PREFIX = 'worker:';
/** A worker schedule gets 5 minutes, under the 10-minute stale-claim window, so a hung run fails before recovery sees it. */
export const WORKER_SCHEDULE_TIMEOUT_MS = 5 * 60_000;

export interface ClaimedWorkerRun { appId: string; schedule: string; params: Record<string, unknown>; runId: string; attempt?: number }

/** One invocation of a worker schedule, as the queue consumer (#257) runs it; the outcome is the consumer's to act on. */
export async function invokeWorkerRun(env: Env, run: ClaimedWorkerRun, ctx?: AppWorkerExports): Promise<{ ok: true } | { ok: false; error: string; final?: true }> {
  try {
    const result = await appWorkerHost(env, ctx).invoke(
      run.appId,
      // The envelope id is the run id: stable for this run, so handlers can be idempotent on it (ADR-009 §3).
      { id: run.runId, type: 'schedule', name: run.schedule, attempt: run.attempt ?? 1, payload: run.params },
      { timeoutMs: WORKER_SCHEDULE_TIMEOUT_MS },
    );
    if (result.status === 'succeeded') return { ok: true };
    return { ok: false, error: result.status === 'timeout' ? `worker timed out after ${WORKER_SCHEDULE_TIMEOUT_MS} ms` : `worker answered ${result.httpStatus ?? 'no response'}: ${(result.body ?? '').slice(0, 300)}` };
  } catch (e) {
    // Over the daily quota (#275): a retry cannot succeed, so the consumer ends the run instead.
    return { ok: false, error: errorText(e), ...(e instanceof AppWorkerQuotaError ? { final: true as const } : {}) };
  }
}

/**
 * Hand a claimed (or run-now) worker run to the queue: `claimed` becomes `queued`. The row goes `queued`
 * first, so the consumer's finish (`WHERE status = 'queued'`) can never beat it;
 * if the send then fails the run fails, once, like any other failure.
 */
export async function queueWorkerRun(env: Env, run: ClaimedWorkerRun, now: number): Promise<boolean> {
  const action = `${WORKER_RUN_PREFIX}${run.schedule}`;
  // A no-op for an owner's run-now row, which is inserted `queued`.
  await env.DB.prepare("UPDATE scheduled_action_runs SET status = 'queued' WHERE run_id = ? AND status = 'claimed'").bind(run.runId).run();
  try {
    await sendAppEvent(env, scheduleMessage(run, now));
    return true;
  } catch (e) {
    await failRun(env, run.appId, action, 'code', run.runId, `could not enqueue: ${errorText(e)}`, Date.now(), 'queued');
    return false;
  }
}

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

export function paramsOf(raw: string): Record<string, unknown> {
  try {
    const v = JSON.parse(raw) as unknown;
    return v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {};
  } catch { return {}; }
}

/**
 * Claim this tick's worker runs and put each on the app-events queue, where the
 * consumer delivers it with retries. A run-now row left `due` (by the route before
 * #257, which waited for this tick) is claimed first, through the same race-proof claim.
 */
export async function runWorkerSchedules(env: Env, now: number, dueAt: number): Promise<WorkerScheduleReport> {
  const report: WorkerScheduleReport = { due: 0, claimed: 0, queued: 0, failed: 0, skipped: 0 };
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

  await Promise.allSettled(runs.map(async (run) => {
    try {
      report[(await queueWorkerRun(env, run, now)) ? 'queued' : 'failed'] += 1;
    } catch (e) {
      console.error(`[schedule] queueing worker run ${run.runId} failed: ${errorText(e)}`);
    }
  }));
  return report;
}

export async function runScheduledActions(opts: { env: Env; now?: number }): Promise<ScheduledActionReport> {
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
    report.workers = await runWorkerSchedules(opts.env, now, dueAt);
  } catch (e) {
    console.error(`[schedule] worker schedules failed: ${errorText(e)}`);
  }
  // #319: after the tick's own work, end what was cut off. Never let the sweep stop the tick.
  try {
    report.recovery = await recoverStaleAppWorkerState(opts.env, now);
  } catch (e) {
    console.error(`[schedule] stale app-worker recovery failed: ${(e as Error)?.message ?? e}`);
  }
  return report;
}
