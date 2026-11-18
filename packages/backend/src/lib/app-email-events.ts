/**
 * Provider webhook events for verified app email (#566, slice 3): delivery, bounce,
 * complaint and inbound mail.
 *
 * The route verifies the Svix signature (lib/resend.ts) before anything here runs. Then:
 *  - the provider event id de-duplicates, so a provider retry applies once;
 *  - a send event is mapped by provider message id to the send record and so to its app;
 *    an inbound message is mapped by recipient address to an approved, verified identity;
 *  - the send record's history is appended to (email_send_events), never rewritten;
 *  - a permanent bounce or a complaint adds the recipient to that app's suppression list;
 *  - the app's worker receives a hook event (`pas.email.delivered|bounced|complained|inbound`)
 *    through the existing app-events queue: at-least-once, retried, dead-lettered, and
 *    identified by a stable envelope id so a handler can de-duplicate on it.
 */
import type { Env } from '../types.js';
import { activeAppWorker } from './app-worker-host.js';
import { enqueueHookDelivery } from './app-event-queue.js';
import { hookLeaseMs, STALE_RECEIVED_SQL } from '../routes/hooks.js';
import * as resend from './resend.js';

export const EMAIL_HOOKS = {
  inbound: 'pas.email.inbound',
  delivered: 'pas.email.delivered',
  bounced: 'pas.email.bounced',
  complained: 'pas.email.complained',
} as const;

/** Each text/html body of an inbound event is cut here; `truncated` says so. */
export const MAX_INBOUND_BODY_CHARS = 200_000;

interface ProviderEvent { type?: unknown; created_at?: unknown; data?: Record<string, unknown> }

const addressOf = (v: unknown): string => {
  const s = String(v ?? '').trim();
  const m = /<([^<>]+)>\s*$/.exec(s);
  return (m ? m[1]! : s).trim().toLowerCase();
};
const addressesOf = (v: unknown): string[] => (Array.isArray(v) ? v : v ? [v] : []).map(addressOf).filter(Boolean);
const toMs = (v: unknown, fallback: number): number => {
  const t = typeof v === 'string' ? Date.parse(v) : NaN;
  return Number.isNaN(t) ? fallback : t;
};

/**
 * Hand a platform-originated event to an app worker as a hook delivery. The row is the same
 * `app_hook_deliveries` the queue consumer owns, unique per (app, hook, key), so repeating a
 * key never delivers twice, while a delivery that failed is queued again.
 */
export async function deliverAppEmailEvent(env: Env, appId: string, hook: string, key: string, payload: Record<string, unknown>, now: number): Promise<void> {
  const rowId = crypto.randomUUID();
  const attemptToken = crypto.randomUUID();
  const leaseUntil = now + hookLeaseMs('worker');
  const inserted = await env.DB.prepare(
    `INSERT OR IGNORE INTO app_hook_deliveries (id, app_id, hook, delivery_id, sender_delivery_id, event, received_at, status, attempts, lease_until, attempt_token)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'received', 1, ?, ?)`,
  ).bind(rowId, appId, hook, key, key, hook, now, leaseUntil, attemptToken).run();
  let id = rowId;
  let attempt = 1;
  let token = attemptToken;
  if (!inserted.meta.changes) {
    const retried = await env.DB.prepare(
      `UPDATE app_hook_deliveries SET status = 'received', attempts = attempts + 1, error = NULL, finished_at = NULL, lease_until = ?, attempt_token = ?
        WHERE app_id = ? AND hook = ? AND delivery_id = ? AND (status IN ('failed', 'quota_exceeded') OR (${STALE_RECEIVED_SQL})) RETURNING id, attempts, attempt_token`,
    ).bind(leaseUntil, attemptToken, appId, hook, key, now).first<{ id: string; attempts: number; attempt_token: string }>();
    if (!retried) return; // delivered, or still in flight under its lease
    ({ id, attempts: attempt, attempt_token: token } = retried);
  }
  const fail = (error: string) =>
    env.DB.prepare("UPDATE app_hook_deliveries SET status = 'failed', finished_at = ?, error = ? WHERE id = ? AND attempt_token = ? AND status = 'received'").bind(Date.now(), error, id, token).run();
  if (!(await activeAppWorker(env, appId))) {
    await fail('app worker not deployed');
    return;
  }
  try {
    await enqueueHookDelivery(env, {
      appId, hook, target: 'worker', rowId: id, attempt, attemptToken: token,
      body: new TextEncoder().encode(JSON.stringify(payload)), headers: new Headers({ 'content-type': 'application/json' }),
    });
  } catch (e) {
    await fail(`could not enqueue: ${String((e as Error)?.message ?? e).slice(0, 300)}`);
    throw e;
  }
}

/**
 * Apply one verified provider event. Returns false when it was already applied. Throws when
 * processing could not finish, so the route answers 5xx and the provider retries; every step
 * is safe to repeat.
 */
export async function applyProviderEvent(env: Env, providerEventId: string, event: ProviderEvent, now = Date.now()): Promise<boolean> {
  const type = typeof event.type === 'string' ? event.type.slice(0, 100) : 'unknown';
  await env.DB.prepare('INSERT OR IGNORE INTO email_provider_events (provider_event_id, type, received_at) VALUES (?, ?, ?)').bind(providerEventId, type, now).run();
  const seen = await env.DB.prepare('SELECT processed_at FROM email_provider_events WHERE provider_event_id = ?').bind(providerEventId).first<{ processed_at: number | null }>();
  if (seen?.processed_at) return false;

  const data = event.data ?? {};
  if (type === 'email.received') await applyInbound(env, providerEventId, data, event, now);
  else if (type === 'email.delivered' || type === 'email.bounced' || type === 'email.complained') await applySendEvent(env, providerEventId, type, data, event, now);
  // Other types (sent, delivery_delayed, ...) are acknowledged and not recorded.

  await env.DB.prepare('UPDATE email_provider_events SET processed_at = ? WHERE provider_event_id = ?').bind(now, providerEventId).run();
  return true;
}

interface SendLookup { id: string; app_id: string; identity_id: string; from_address: string; to_json: string }

async function applySendEvent(env: Env, eventId: string, type: string, data: Record<string, unknown>, event: ProviderEvent, now: number): Promise<void> {
  const providerId = typeof data.email_id === 'string' ? data.email_id : '';
  // Mail the platform did not send through this feature (e.g. the legacy sender) has no record: nothing to attribute.
  const send = providerId ? await env.DB.prepare('SELECT id, app_id, identity_id, from_address, to_json FROM email_sends WHERE provider_id = ?').bind(providerId).first<SendLookup>() : null;
  if (!send) return;
  const occurredAt = toMs(event.created_at, now);
  const bounce = (data.bounce ?? null) as { type?: unknown; subType?: unknown; message?: unknown } | null;
  const permanent = type === 'email.bounced' && String(bounce?.type ?? '').toLowerCase() === 'permanent';
  const sentTo = JSON.parse(send.to_json) as string[];
  // Only addresses this send went to: a provider event cannot suppress an address the app never mailed.
  const affected = addressesOf(data.to).filter((a) => sentTo.includes(a));
  const suppress = type === 'email.complained' || permanent;
  const detail = type === 'email.bounced' && bounce
    ? { bounce: { type: String(bounce.type ?? ''), subType: String(bounce.subType ?? ''), message: String(bounce.message ?? '').slice(0, 300) } }
    : null;

  await env.DB.prepare('INSERT OR IGNORE INTO email_send_events (id, send_id, app_id, type, detail, occurred_at, provider_event_id) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .bind(crypto.randomUUID(), send.id, send.app_id, type, detail ? JSON.stringify(detail) : null, occurredAt, eventId).run();
  const column = type === 'email.delivered' ? 'delivered_at' : type === 'email.bounced' ? 'bounced_at' : 'complained_at';
  await env.DB.prepare(`UPDATE email_sends SET ${column} = COALESCE(${column}, ?) WHERE id = ?`).bind(occurredAt, send.id).run();
  if (suppress) {
    for (const address of affected) {
      await env.DB.prepare('INSERT OR IGNORE INTO email_suppressions (app_id, address, reason, send_id, created_at) VALUES (?, ?, ?, ?, ?)')
        .bind(send.app_id, address, type === 'email.complained' ? 'complained' : 'bounced', send.id, now).run();
    }
  }
  const name = type === 'email.delivered' ? EMAIL_HOOKS.delivered : type === 'email.bounced' ? EMAIL_HOOKS.bounced : EMAIL_HOOKS.complained;
  await deliverAppEmailEvent(env, send.app_id, name, eventId, {
    type: name, id: eventId, sendId: send.id, providerId, from: send.from_address, to: affected.length ? affected : sentTo, occurredAt,
    ...(detail ?? {}), ...(type === 'email.bounced' ? { permanent } : {}), suppressed: suppress,
  }, now);
}

interface InboundTarget { id: string; app_id: string; address: string }

async function applyInbound(env: Env, eventId: string, data: Record<string, unknown>, event: ProviderEvent, now: number): Promise<void> {
  const providerId = typeof data.email_id === 'string' ? data.email_id : '';
  if (!providerId) return;
  const recipients = [...new Set([...addressesOf(data.to), ...addressesOf(data.cc), ...addressesOf(data.received_for)])];
  if (!recipients.length) return;
  // Only an approved, unsuspended identity on a verified domain of an app that is not suspended receives mail.
  const targets = (await env.DB.prepare(
    `SELECT i.id, i.app_id, i.address FROM email_identities i
       JOIN email_domains d ON d.domain = i.domain AND d.app_id = i.app_id AND d.status = 'verified'
      WHERE i.status = 'approved' AND i.suspended = 0 AND i.address IN (${recipients.map(() => '?').join(',')})
        AND NOT EXISTS (SELECT 1 FROM email_app_settings s WHERE s.app_id = i.app_id AND s.suspended = 1)`,
  ).bind(...recipients).all<InboundTarget>()).results ?? [];
  if (!targets.length) return; // not for any live identity: acknowledged, nothing to route

  const apiKey = env.RESEND_API_KEY;
  if (!apiKey) throw new Error('RESEND_API_KEY is not set');
  const mail = await resend.getReceivedEmail(apiKey, providerId);
  const cap = (s: string | null) => (s && s.length > MAX_INBOUND_BODY_CHARS ? s.slice(0, MAX_INBOUND_BODY_CHARS) : s);
  const truncated = (mail.text?.length ?? 0) > MAX_INBOUND_BODY_CHARS || (mail.html?.length ?? 0) > MAX_INBOUND_BODY_CHARS;
  const keep = ['in-reply-to', 'references', 'reply-to', 'date'] as const;
  const headers = Object.fromEntries(keep.filter((k) => mail.headers[k] !== undefined).map((k) => [k, mail.headers[k]!.slice(0, 1000)]));
  const receivedAt = toMs(data.created_at ?? event.created_at, now);

  for (const t of targets) {
    await env.DB.prepare('INSERT OR IGNORE INTO email_inbound (id, app_id, identity_id, provider_id, from_address, subject, received_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .bind(crypto.randomUUID(), t.app_id, t.id, providerId, addressOf(mail.from || data.from), String(mail.subject ?? data.subject ?? '').slice(0, 500), receivedAt).run();
    const key = `${eventId}:${t.id}`;
    await deliverAppEmailEvent(env, t.app_id, EMAIL_HOOKS.inbound, key, {
      type: EMAIL_HOOKS.inbound, id: key, receivedAt, identity: { id: t.id, address: t.address }, providerId,
      messageId: mail.message_id ?? (typeof data.message_id === 'string' ? data.message_id : null),
      from: mail.from || String(data.from ?? ''), to: mail.to.length ? mail.to : addressesOf(data.to), subject: mail.subject,
      text: cap(mail.text), html: cap(mail.html), truncated, headers,
      // The provider's own SPF/DKIM/DMARC verdicts. A display name or From header proves nothing.
      authentication: mail.authentication,
      // Attachment bytes are never delivered: metadata only, quarantined until a later slice defines their handling.
      attachments: mail.attachments.map((a) => ({ id: a.id, filename: a.filename, contentType: a.content_type, size: a.size, quarantined: true })),
    }, now);
  }
}
