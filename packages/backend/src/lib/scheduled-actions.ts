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

const SYSTEM_SCHEDULE_USER = 'system:schedule';
export const SCHEDULE_TICK_MS = 5 * 60_000;
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
}

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
    const message = errorText(error);
    const failedRun = await env.DB.prepare(
      "UPDATE scheduled_action_runs SET status = 'failed', finished_at = ?, error = ? WHERE run_id = ? AND status = 'claimed'",
    ).bind(now, message, runId).run();
    const failures = failedRun.meta?.changes ? await recordFailure(env, row.app_id, row.name, source, now) : null;
    console.error(`[schedule] failed app=${row.app_id} action=${row.name} run=${runId} failures=${failures}: ${message}`);
    return 'failed';
  }
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
  return report;
}
