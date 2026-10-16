/**
 * Outbound webhook dispatch — HMAC-signed delivery to registered URLs.
 *
 * Fire-and-forget: callers should use `ctx.waitUntil(dispatchWebhook(...))`
 * so the response isn't blocked by delivery latency.
 *
 * Hardened (#224): redirects are never followed — the SSRF guard in
 * routes/webhooks-config.ts checks the URL only at registration, so a 3xx to an
 * internal host would bypass it — and a receiver gets WEBHOOK_TIMEOUT_MS to
 * answer, so a hung endpoint cannot stall a caller (the scheduled-actions tick
 * awaits delivery inline).
 */

export const WEBHOOK_TIMEOUT_MS = 10_000;

/** The X-Webhook-Signature value: hex HMAC-SHA256 of the body under the hook's secret. */
export async function signWebhookBody(secret: string, body: string): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, encoder.encode(body));
  return Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * Webhooks per app (#27). Every event fans out to all of an app's matching
 * hooks, so an uncapped list turns one end-user upload into that many signed
 * POSTs. Registration refuses past it; dispatch also stops at it, which bounds
 * any app that registered more before the cap existed (oldest hooks win).
 */
export const MAX_WEBHOOKS_PER_APP = 10;

/**
 * #395: which events are retried. Only `app.alert` — an incident notification
 * that is lost is the failure the owner opted in to hear about. Every other
 * event keeps its single attempt, as before.
 */
export const RETRIED_EVENTS = new Set(['app.alert']);
/** At most this many attempts per delivery, with this backoff (seconds) after attempts 1, 2 and 3. */
export const MAX_DELIVERY_ATTEMPTS = 4;
export const RETRY_BACKOFF_S = [60, 300, 1800] as const;
/** Due retries sent per cron tick, so a backlog drains at a bounded rate. */
export const RETRY_BATCH = 50;

/** One POST of `body` to `hook`: the HTTP status, or null with a short reason. Never throws. */
async function attemptDelivery(hook: { url: string; secret: string }, event: string, body: string): Promise<{ status: number | null; reason?: string }> {
  try {
    const signature = await signWebhookBody(hook.secret, body);
    const res = await fetch(hook.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Webhook-Signature': signature,
        'X-Webhook-Event': event,
      },
      body,
      redirect: 'manual',
      signal: AbortSignal.timeout(WEBHOOK_TIMEOUT_MS),
    });
    await res.body?.cancel().catch(() => {});
    return { status: res.status };
  } catch (err) {
    return {
      status: null,
      reason: err instanceof Error && err.name === 'TimeoutError'
        ? `timed out after ${WEBHOOK_TIMEOUT_MS} ms`
        : (err instanceof Error ? err.message : 'network error').slice(0, 200),
    };
  }
}

const delivered = (status: number | null) => status !== null && status >= 200 && status < 300;

/** When attempt `attempts` (1-based) failed, the next one is due — or null when the delivery is done. */
function nextAttemptAt(event: string, attempts: number, status: number | null, nowS: number): number | null {
  if (delivered(status) || !RETRIED_EVENTS.has(event) || attempts >= MAX_DELIVERY_ATTEMPTS) return null;
  // A 4xx other than 408/429 is the receiver refusing this payload: retrying will not change it.
  if (status !== null && status >= 400 && status < 500 && status !== 408 && status !== 429) return null;
  return nowS + RETRY_BACKOFF_S[Math.min(attempts, RETRY_BACKOFF_S.length) - 1]!;
}

function failureReason(status: number | null, reason: string | undefined): string | null {
  if (delivered(status)) return null;
  return status === null ? (reason ?? 'network error') : `HTTP ${status}`;
}

export async function dispatchWebhook(
  db: D1Database,
  appId: string,
  event: string,
  payload: object,
): Promise<void> {
  try {
    const { results: hooks } = await db.prepare(
      `SELECT id, url, secret FROM app_webhooks WHERE app_id = ?1 AND event = ?2 AND active = 1
       ORDER BY created_at, id LIMIT ?3`,
    ).bind(appId, event, MAX_WEBHOOKS_PER_APP).all<{ id: string; url: string; secret: string }>();
    if (!hooks.length) return;
    const body = JSON.stringify(payload);
    await Promise.allSettled(
      hooks.map(async (hook) => {
        const { status, reason } = await attemptDelivery(hook, event, body);
        if (!delivered(status)) {
          console.error(JSON.stringify({
            event: 'webhook_delivery_failed', app_id: appId, webhook_id: hook.id, webhook_event: event,
            ...(status === null ? { reason } : { status }),
          }));
        }
        const nowS = Math.floor(Date.now() / 1000);
        await db.prepare(
          `INSERT INTO webhook_deliveries (id, webhook_id, event, payload, status, attempts, last_attempt_at, created_at, next_attempt_at, last_error)
           VALUES (?1, ?2, ?3, ?4, ?5, 1, ?6, ?6, ?7, ?8)`,
        ).bind(crypto.randomUUID(), hook.id, event, body, status, nowS, nextAttemptAt(event, 1, status, nowS), failureReason(status, reason)).run();
      }),
    );
  } catch {
    // Webhook delivery is fire-and-forget: the calling operation already succeeded.
  }
}

/**
 * #395: resend due `app.alert` deliveries — at most RETRY_BATCH per call, each up
 * to MAX_DELIVERY_ATTEMPTS in total. A webhook deactivated or deleted since stops
 * its retries. Never throws. Returns how many were attempted.
 */
export async function retryDueDeliveries(db: D1Database, nowMs: number = Date.now()): Promise<number> {
  try {
    const nowS = Math.floor(nowMs / 1000);
    const { results } = await db.prepare(
      `SELECT d.id, d.event, d.payload, d.attempts, w.url, w.secret, w.active
         FROM webhook_deliveries d LEFT JOIN app_webhooks w ON w.id = d.webhook_id
        WHERE d.next_attempt_at IS NOT NULL AND d.next_attempt_at <= ?1
        ORDER BY d.next_attempt_at LIMIT ?2`,
    ).bind(nowS, RETRY_BATCH).all<{ id: string; event: string; payload: string; attempts: number; url: string | null; secret: string | null; active: number | null }>();
    for (const d of results ?? []) {
      if (!d.url || !d.secret || d.active !== 1) {
        await db.prepare("UPDATE webhook_deliveries SET next_attempt_at = NULL, last_error = 'webhook removed' WHERE id = ?").bind(d.id).run();
        continue;
      }
      const { status, reason } = await attemptDelivery({ url: d.url, secret: d.secret }, d.event, d.payload);
      const attempts = d.attempts + 1;
      await db.prepare(
        'UPDATE webhook_deliveries SET status = ?2, attempts = ?3, last_attempt_at = ?4, next_attempt_at = ?5, last_error = ?6 WHERE id = ?1',
      ).bind(d.id, status, attempts, nowS, nextAttemptAt(d.event, attempts, status, nowS), failureReason(status, reason)).run();
    }
    return results?.length ?? 0;
  } catch (e) {
    console.error(`[webhook-retry] failed: ${(e as Error).message}`);
    return 0;
  }
}
