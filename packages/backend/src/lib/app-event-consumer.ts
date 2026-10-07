/**
 * The `queue()` side of the app-events queue (#257, ADR-009 §3–§4).
 *
 * `pas-app-events` (one message per invocation: a schedule may run 5 minutes,
 * and one message per invocation keeps the loader under its 4-concurrent cap):
 * 2xx acks and finishes the referenced row; anything else retries after
 * `2 ** attempt * 10` seconds. A message that exhausts its retries goes to
 * `pas-app-events-dlq`, whose consumer fails the row — and, for a schedule,
 * counts ONE failure toward the breaker, never one per attempt. No replay.
 */
import type { Env } from '../types.js';
import { AppWorkerQuotaError } from './app-worker-usage.js';
import type { AppWorkerExports } from './app-worker-host.js';
import { deleteSpilledBody, hookBodyOf, APP_EVENT_MAX_RETRIES, APP_EVENTS_DLQ, type AppEventMessage } from './app-event-queue.js';
import { invokeWorkerRun, recordFailure, recordSuccess, WORKER_RUN_PREFIX } from './scheduled-actions.js';
import { deliverHook } from '../routes/hooks.js';

type Msg = Message<AppEventMessage>;

const errorText = (e: unknown) => String((e as Error)?.message ?? e).slice(0, 500);

async function changed(stmt: D1PreparedStatement): Promise<boolean> {
  return Boolean((await stmt.run()).meta?.changes);
}

/** The error of a failed try, or null on success. `final`: retrying cannot help (the app's daily quota is spent), so the delivery ends now. */
async function deliver(env: Env, m: AppEventMessage, queueAttempts: number, ctx?: AppWorkerExports): Promise<{ error: string | null; final?: true }> {
  const attempt = m.attempt + queueAttempts - 1;
  if (m.type === 'schedule') {
    const result = await invokeWorkerRun(env, { appId: m.app_id, schedule: m.name, params: m.payload as Record<string, unknown>, runId: m.id, attempt }, ctx);
    return result.ok ? { error: null } : { error: result.error, ...(result.final ? { final: true as const } : {}) };
  }
  try {
    const headers = new Headers((m.payload as { headers?: Record<string, string> }).headers ?? {});
    return { error: await deliverHook(env, { appId: m.app_id, hook: m.name, target: 'worker', rowId: m.id, attempt, body: await hookBodyOf(env, m), headers }, ctx) };
  } catch (e) {
    if (e instanceof AppWorkerQuotaError) return { error: `quota exceeded (${e.quota}); redeliver it from the sender after 00:00 UTC`, final: true };
    return { error: errorText(e) };
  }
}

async function finishDelivered(env: Env, m: AppEventMessage): Promise<void> {
  const now = Date.now();
  if (m.type === 'schedule') {
    await recordSuccess(env, m.id, m.app_id, `${WORKER_RUN_PREFIX}${m.name}`, 'code', null, now, 'queued');
  } else {
    await env.DB.prepare("UPDATE app_hook_deliveries SET status = 'delivered', finished_at = ?, error = NULL WHERE id = ? AND status = 'received'").bind(now, m.id).run();
  }
  await deleteSpilledBody(env, m);
}

/** Keep the last error; a hook's `attempts` counts tries, so it advances for the retry that follows — and not after the last try. */
async function noteFailedTry(env: Env, m: AppEventMessage, error: string, retrying: boolean): Promise<void> {
  if (m.type === 'schedule') {
    await env.DB.prepare("UPDATE scheduled_action_runs SET error = ? WHERE run_id = ? AND status = 'queued'").bind(error, m.id).run();
  } else {
    await env.DB.prepare(`UPDATE app_hook_deliveries SET attempts = attempts + ${retrying ? 1 : 0}, error = ? WHERE id = ? AND status = 'received'`).bind(error, m.id).run();
  }
}

async function handleEvent(env: Env, message: Msg, ctx?: AppWorkerExports): Promise<void> {
  const m = message.body;
  if (m.v !== 1) { console.error(`[app-events] dropping message with unknown version ${String(m.v)}`); message.ack(); return; }
  const { error, final } = await deliver(env, m, message.attempts, ctx);
  if (error === null) {
    await finishDelivered(env, m);
    message.ack();
  } else if (final) {
    // A schedule fails (and counts once toward the breaker); a hook is recorded `quota_exceeded`, as it was before the queue.
    await failQueued(env, m, error, 'quota_exceeded');
    message.ack();
  } else {
    await noteFailedTry(env, m, error, message.attempts <= APP_EVENT_MAX_RETRIES);
    console.error(`[app-events] ${m.type} ${m.app_id}/${m.name} id=${m.id} attempt ${message.attempts} failed: ${error}`);
    message.retry({ delaySeconds: 2 ** message.attempts * 10 });
  }
}

/**
 * End a queued delivery as failed. Only the update that wins the row counts a
 * schedule toward the breaker: the 60-minute queued sweep may have failed it
 * already, and the two must never both count one run.
 */
async function failQueued(env: Env, m: AppEventMessage, message: string, hookStatus: 'failed' | 'quota_exceeded' = 'failed'): Promise<void> {
  const now = Date.now();
  if (m.type === 'schedule') {
    const won = await changed(env.DB.prepare(
      "UPDATE scheduled_action_runs SET status = 'failed', finished_at = ?, error = ? WHERE run_id = ? AND status = 'queued'",
    ).bind(now, message, m.id));
    if (won) await recordFailure(env, m.app_id, `${WORKER_RUN_PREFIX}${m.name}`, 'code', now);
  } else {
    await env.DB.prepare("UPDATE app_hook_deliveries SET status = ?, finished_at = ?, error = ? WHERE id = ? AND status = 'received'")
      .bind(hookStatus, now, message.slice(0, 500), m.id).run();
  }
  await deleteSpilledBody(env, m);
}

async function deadLetter(env: Env, message: Msg): Promise<void> {
  const m = message.body;
  const text = `dead-lettered after ${APP_EVENT_MAX_RETRIES + 1} attempts`;
  // The consumer kept the last try's error on the row: say what it was.
  const row = await env.DB.prepare(m.type === 'schedule' ? 'SELECT error FROM scheduled_action_runs WHERE run_id = ?' : 'SELECT error FROM app_hook_deliveries WHERE id = ?')
    .bind(m.id).first<{ error: string | null }>();
  await failQueued(env, m, row?.error ? `${text}: ${row.error}` : text);
  console.error(`[app-events] ${text}: ${m.type} ${m.app_id}/${m.name} id=${m.id}`);
}

/** `queue()` entry for both queues. `Promise.allSettled`: one message's failure must not strand the batch. */
export async function handleAppEventBatch(batch: MessageBatch<AppEventMessage>, env: Env, ctx?: AppWorkerExports): Promise<void> {
  const dlq = batch.queue === APP_EVENTS_DLQ;
  await Promise.allSettled(batch.messages.map(async (message) => {
    try {
      await (dlq ? deadLetter(env, message) : handleEvent(env, message, ctx));
      if (dlq) message.ack();
    } catch (e) {
      console.error(`[app-events] ${dlq ? 'dead-lettering' : 'handling'} ${message.body.id} failed: ${errorText(e)}`);
      message.retry({ delaySeconds: dlq ? 60 : 2 ** message.attempts * 10 });
    }
  }));
}
