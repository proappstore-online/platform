/**
 * Outbound webhook dispatch — HMAC-signed delivery to registered URLs.
 *
 * Fire-and-forget: callers should use `ctx.waitUntil(dispatchWebhook(...))`
 * so the response isn't blocked by delivery latency.
 */

export async function dispatchWebhook(
  db: D1Database,
  appId: string,
  event: string,
  payload: object,
): Promise<void> {
  try {
    const { results: hooks } = await db.prepare(
      'SELECT id, url, secret FROM app_webhooks WHERE app_id = ?1 AND event = ?2 AND active = 1',
    ).bind(appId, event).all<{ id: string; url: string; secret: string }>();

    if (!hooks.length) return;

    const body = JSON.stringify(payload);
    const encoder = new TextEncoder();
    const bodyBytes = encoder.encode(body);

    await Promise.allSettled(
      hooks.map(async (hook) => {
        const deliveryId = crypto.randomUUID();
        let status: number | null = null;

        try {
          // HMAC-SHA256 signature
          const key = await crypto.subtle.importKey(
            'raw',
            encoder.encode(hook.secret),
            { name: 'HMAC', hash: 'SHA-256' },
            false,
            ['sign'],
          );
          const sig = await crypto.subtle.sign('HMAC', key, bodyBytes);
          const signature = Array.from(new Uint8Array(sig))
            .map((b) => b.toString(16).padStart(2, '0'))
            .join('');

          const res = await fetch(hook.url, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'X-Webhook-Signature': signature,
              'X-Webhook-Event': event,
            },
            body,
          });
          status = res.status;
        } catch {
          // Network error — status stays null
        }

        // Log delivery
        await db.prepare(
          `INSERT INTO webhook_deliveries (id, webhook_id, event, payload, status, attempts, last_attempt_at, created_at)
           VALUES (?1, ?2, ?3, ?4, ?5, 1, ?6, ?6)`,
        ).bind(deliveryId, hook.id, event, body, status, Math.floor(Date.now() / 1000)).run();
      }),
    );
  } catch {
    // Fire-and-forget — never reject (table may not exist before migration)
  }
}
