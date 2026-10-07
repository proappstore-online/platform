/**
 * App-worker deliveries on a queue (#257, ADR-009 §3–§4). Schedules (#255) and
 * worker hooks (#256) used to run inside the invoking request, with no retry. A
 * delivery is now one message on `pas-app-events`; the consumer
 * (app-event-consumer.ts) invokes the worker, retries with backoff, and a
 * message that exhausts its retries lands on `pas-app-events-dlq`.
 *
 * The message is the ADR-009 event envelope minus the signature: the consumer
 * signs at send time, so a retried message carries a fresh `t`.
 */
import type { Env } from '../types.js';
import { decodeEnvelopeBody, encodeEnvelopeBody } from '../app-worker-shim/body.js';
import { hookHeaders } from './hook-verifiers.js';
import type { HookDelivery } from '../routes/hooks.js';

export const APP_EVENTS_QUEUE = 'pas-app-events';
export const APP_EVENTS_DLQ = 'pas-app-events-dlq';
/** Must equal `max_retries` of the consumer in wrangler.toml. */
export const APP_EVENT_MAX_RETRIES = 5;
/** A Queues message is capped at 128 KB; leave room for the queue's own framing. */
export const MAX_MESSAGE_BYTES = 120 * 1024;
/** R2 prefix of hook bodies too large for a message — delivery only, deleted on ack or dead-letter. */
export const HOOK_BODY_PREFIX = '_hook-bodies/';

export interface AppEventMessage {
  v: 1;
  /** Envelope id: the run id (schedules) or delivery row id (hooks) — stable across retries. */
  id: string;
  app_id: string;
  type: 'schedule' | 'hook';
  name: string;
  /** The attempt number of the first try; the consumer adds the queue's own retries. */
  attempt: number;
  issued_at: number;
  payload: unknown;
  ref: { table: 'scheduled_action_runs' | 'app_hook_deliveries'; id: string };
  /** A hook body over the message limit lives here in R2 instead of `payload.body`. */
  body_key?: string;
}

export async function sendAppEvent(env: Env, message: AppEventMessage): Promise<void> {
  if (!env.APP_EVENTS) throw new Error('the APP_EVENTS queue binding is missing');
  await env.APP_EVENTS.send(message);
}

export function scheduleMessage(run: { runId: string; appId: string; schedule: string; params: Record<string, unknown> }, now: number): AppEventMessage {
  return {
    v: 1, id: run.runId, app_id: run.appId, type: 'schedule', name: run.schedule, attempt: 1, issued_at: now,
    payload: run.params, ref: { table: 'scheduled_action_runs', id: run.runId },
  };
}

/** Enqueue a worker hook delivery, spilling a body that does not fit to R2. */
export async function enqueueHookDelivery(env: Env, d: HookDelivery): Promise<void> {
  const headers = hookHeaders(d.headers);
  const message: AppEventMessage = {
    v: 1, id: d.rowId, app_id: d.appId, type: 'hook', name: d.hook, attempt: d.attempt, issued_at: Date.now(),
    payload: { headers, ...encodeEnvelopeBody(d.body, d.headers.get('content-type')) },
    ref: { table: 'app_hook_deliveries', id: d.rowId },
  };
  if (new TextEncoder().encode(JSON.stringify(message)).byteLength > MAX_MESSAGE_BYTES) {
    message.body_key = `${HOOK_BODY_PREFIX}${d.appId}/${d.rowId}`;
    message.payload = { headers };
    await env.STORAGE.put(message.body_key, d.body);
    try {
      await sendAppEvent(env, message);
    } catch (e) {
      await env.STORAGE.delete(message.body_key);
      throw e;
    }
    return;
  }
  await sendAppEvent(env, message);
}

/** The hook body of a message: from R2 when it was spilled, else decoded from the payload. */
export async function hookBodyOf(env: Env, message: AppEventMessage): Promise<Uint8Array> {
  if (message.body_key) {
    const object = await env.STORAGE.get(message.body_key);
    if (!object) throw new Error('the spilled hook body is gone');
    return new Uint8Array(await object.arrayBuffer());
  }
  const p = message.payload as { body?: unknown; body_encoding?: unknown };
  return decodeEnvelopeBody(p.body, p.body_encoding);
}

export async function deleteSpilledBody(env: Env, message: AppEventMessage): Promise<void> {
  if (message.body_key) await env.STORAGE.delete(message.body_key);
}
