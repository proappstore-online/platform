/**
 * Native location relay (#654). A reviewed catalog entry with a relay (NATIVE_RELAYS) has the points its grants accept run
 * one app action as the device's owner (`:__user_id`), with params lat, lng, accuracy and at. Nothing else reaches the app:
 * no device id or label.
 *
 * One `native_relays` row per (app, user) owns at most one app-events message at a time. An upload that saves points arms
 * the row; if a message is already queued, the upload coalesces into it, because a delivery reads the newest current point
 * when it runs (through the read's own authorization, NATIVE_LOCATION_SCOPE), never a copy taken at upload. Deliveries
 * are spaced at least RELAY_SPACING_MS apart per (app, user), and only a point newer than the last one relayed is sent.
 */
import type { Env } from '../types.js';
import { HttpError } from './auth.js';
import { batchPayload, prepareActionBatch, prepareActionQuery, referencesChildFlag, type ToolManifest } from './action-sql.js';
import { sendAppEvent, type AppEventMessage } from './app-event-queue.js';
import { isChildAccount } from './user-flags.js';
import { NATIVE_LOCATION_SCOPE, NATIVE_RETENTION_MS, nativeEntry, nativeRelayActionError, nativeRelayOf } from './native-companion.js';
import { forwardToDataWorker, loadManifest } from '../routes/actions.js';

const RELAY_SPACING_MS = 3_000;
/** Past the queue's whole retry window (~10 min of backoff): a row still queued after this lost its message. */
const RELAY_LEASE_MS = 15 * 60_000;

interface RelayPoint { at: number; lat: number; lng: number; accuracy: number }

/**
 * Queue a delivery for (app, user) unless one is already queued. Called after an upload saved points for a relayed app,
 * and after a delivery that finds a newer point waiting.
 */
export async function armNativeRelay(env: Env, appId: string, userId: string, now = Date.now()): Promise<void> {
  const relay = nativeRelayOf(appId);
  if (!relay) return;
  const token = crypto.randomUUID();
  const claimed = await env.DB.prepare(`INSERT INTO native_relays (app_id, user_id, status, attempt_token, lease_until) VALUES (?1, ?2, 'queued', ?3, ?4)
    ON CONFLICT(app_id, user_id) DO UPDATE SET status = 'queued', attempt_token = excluded.attempt_token, lease_until = excluded.lease_until
    WHERE native_relays.status = 'idle' OR native_relays.lease_until < ?5 RETURNING sent_at`)
    .bind(appId, userId, token, now + RELAY_LEASE_MS, now).first<{ sent_at: number | null }>();
  if (!claimed) return;
  const wait = claimed.sent_at === null ? 0 : claimed.sent_at + RELAY_SPACING_MS - now;
  const message: AppEventMessage = {
    v: 1, id: userId, app_id: appId, type: 'native', name: relay.action, attempt: 1, attempt_token: token, issued_at: now,
    payload: null, ref: { table: 'native_relays', id: userId },
  };
  try {
    await sendAppEvent(env, message, wait > 0 ? Math.ceil(wait / 1000) : 0);
  } catch (e) {
    // Release the row so the next upload arms it again; the points stay readable meanwhile.
    await release(env, message);
    throw e;
  }
}

async function release(env: Env, m: AppEventMessage, set = '', ...values: unknown[]): Promise<boolean> {
  const result = await env.DB.prepare(`UPDATE native_relays SET status = 'idle', attempt_token = NULL, lease_until = NULL${set}
    WHERE app_id = ? AND user_id = ? AND status = 'queued' AND attempt_token = ?`).bind(...values, m.app_id, m.id, m.attempt_token).run();
  return Boolean(result.meta?.changes);
}

async function newestPoint(env: Env, appId: string, userId: string, version: string, after: number, now: number): Promise<RelayPoint | null> {
  return env.DB.prepare(`SELECT p.recorded_at AS at, p.latitude AS lat, p.longitude AS lng, p.accuracy
    ${NATIVE_LOCATION_SCOPE} AND p.recorded_at > ?
    ORDER BY p.recorded_at DESC LIMIT 1`).bind(appId, userId, version, now, now - NATIVE_RETENTION_MS, after).first<RelayPoint>();
}

/** Run the relay action with one point. Returns null on success, else the error and whether retrying could help. */
async function runAction(env: Env, appId: string, userId: string, action: string, point: RelayPoint): Promise<{ error: string; final: boolean } | null> {
  let manifest: ToolManifest;
  try {
    manifest = await loadManifest(env.DB, appId, action);
  } catch (e) {
    if (e instanceof HttpError && e.status === 404) return { error: `action "${action}" is not registered`, final: true };
    throw e;
  }
  // Re-checked at delivery: the manifest may have changed since registration.
  const invalid = nativeRelayActionError(appId, manifest);
  if (invalid) return { error: invalid, final: true };
  const input = { lat: point.lat, lng: point.lng, accuracy: point.accuracy, at: point.at };
  const isChild = referencesChildFlag(manifest) ? await isChildAccount(env.DB, userId) : false;
  let endpoint: 'batch' | 'execute', payload: unknown;
  try {
    endpoint = manifest.operation === 'batch' ? 'batch' : 'execute';
    payload = endpoint === 'batch' ? batchPayload(manifest, prepareActionBatch(manifest, input, userId, isChild)) : prepareActionQuery(manifest, input, userId, isChild);
  } catch (e) {
    return { error: `action "${action}": ${(e as Error).message}`, final: true };
  }
  const res = await forwardToDataWorker(env, appId, endpoint, payload, null);
  if (res.ok) return null;
  // A 4xx is the app's action refusing this point; sending the same point again cannot change that.
  return { error: `action "${action}" failed (${res.status}): ${(await res.text()).slice(0, 300)}`, final: res.status < 500 };
}

/**
 * Deliver one native relay message. `ack`: the message is done (delivered, nothing to deliver, stale or a final failure);
 * otherwise the error is retried by the queue, and the row stays queued so new uploads keep coalescing into it.
 */
export async function deliverNativeRelay(env: Env, m: AppEventMessage): Promise<{ ack: true } | { ack: false; error: string }> {
  const row = await env.DB.prepare("SELECT delivered_at FROM native_relays WHERE app_id = ? AND user_id = ? AND status = 'queued' AND attempt_token = ?")
    .bind(m.app_id, m.id, m.attempt_token).first<{ delivered_at: number | null }>();
  if (!row) return { ack: true }; // a stale message: the row was released or re-armed under another token
  const relay = nativeRelayOf(m.app_id), entry = relay && await nativeEntry(m.app_id, relay.capability);
  const now = Date.now();
  const point = relay && entry ? await newestPoint(env, m.app_id, m.id, entry.version, row.delivered_at ?? 0, now) : null;
  if (!relay || !point) {
    await release(env, m);
    return { ack: true };
  }
  const failed = await runAction(env, m.app_id, m.id, relay.action, point);
  if (failed && !failed.final) return { ack: false, error: failed.error };
  if (failed) console.error(`[native-relay] ${m.app_id} dropped a point: ${failed.error}`);
  // Delivered, or given up on: either way this point is done, so a broken action is tried once per point, not in a loop.
  if (await release(env, m, ', delivered_at = ?, sent_at = ?', point.at, now)
    && await newestPoint(env, m.app_id, m.id, entry!.version, point.at, now)) {
    // A point saved while this delivery ran found the row queued and coalesced into it: relay it after the spacing.
    await armNativeRelay(env, m.app_id, m.id, now);
  }
  return { ack: true };
}

/** A relay message that exhausted its retries: free the row, so the next upload relays the newest point again. */
export async function deadLetterNativeRelay(env: Env, m: AppEventMessage): Promise<void> {
  if (await release(env, m)) console.error(`[native-relay] ${m.app_id}: a delivery was dead-lettered`);
}
