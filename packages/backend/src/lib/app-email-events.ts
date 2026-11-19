/**
 * Cloudflare Email Service events for verified app email (#566, slice 3): delivery, bounce
 * and complaint events from the Email Sending events queue, and inbound mail from the
 * backend worker's `email()` handler (Email Routing).
 *
 * Nothing here is reachable from the internet: the queue and the routing handler are
 * Cloudflare-internal, so there is no signature to verify. Then:
 *  - the event id de-duplicates, so a queue redelivery applies once;
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
import PostalMime from 'postal-mime';
import { cloudflareAuthResults } from './cf-email.js';

export const EMAIL_EVENTS_QUEUE = 'pas-email-events';

const EMAIL_HOOKS = {
  inbound: 'pas.email.inbound',
  delivered: 'pas.email.delivered',
  bounced: 'pas.email.bounced',
  complained: 'pas.email.complained',
} as const;

/** Each text/html body of an inbound event is cut here; `truncated` says so. */
const MAX_INBOUND_BODY_CHARS = 200_000;

/** One message of the Email Sending events queue (`cf.email.sending.message.*`). */
export interface EmailSendingEvent {
  type?: unknown;
  payload?: {
    eventId?: unknown; messageId?: unknown; recipient?: unknown; terminal?: unknown;
    bounce?: { type?: unknown; classification?: unknown; reason?: unknown } | null;
  };
  metadata?: { eventTimestamp?: unknown };
}

/** Cloudflare refuses to deliver a message over this; so does the handler. */
const MAX_INBOUND_RAW_BYTES = 25 * 1024 * 1024;

const addressOf = (v: unknown): string => {
  const s = String(v ?? '').trim();
  const m = /<([^<>]+)>\s*$/.exec(s);
  return (m ? m[1]! : s).trim().toLowerCase();
};
const toMs = (v: unknown, fallback: number): number => {
  const t = typeof v === 'string' ? Date.parse(v) : NaN;
  return Number.isNaN(t) ? fallback : t;
};

/**
 * Hand a platform-originated event to an app worker as a hook delivery. The row is the same
 * `app_hook_deliveries` the queue consumer owns, unique per (app, hook, key), so repeating a
 * key never delivers twice, while a delivery that failed is queued again.
 */
async function deliverAppEmailEvent(env: Env, appId: string, hook: string, key: string, payload: Record<string, unknown>, now: number): Promise<void> {
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
 * Apply one Email Sending event. Returns false when it was already applied. Throws when
 * processing could not finish, so the queue retries; every step is safe to repeat.
 */
export async function applyProviderEvent(env: Env, event: EmailSendingEvent, now = Date.now()): Promise<boolean> {
  const type = typeof event.type === 'string' ? event.type.slice(0, 100) : 'unknown';
  const p = event.payload ?? {};
  const eventId = typeof p.eventId === 'string' ? p.eventId : '';
  if (!eventId) return false; // not an event this feature understands
  await env.DB.prepare('INSERT OR IGNORE INTO email_provider_events (provider_event_id, type, received_at) VALUES (?, ?, ?)').bind(eventId, type, now).run();
  const seen = await env.DB.prepare('SELECT processed_at FROM email_provider_events WHERE provider_event_id = ?').bind(eventId).first<{ processed_at: number | null }>();
  if (seen?.processed_at) return false;

  const kind = /^cf\.email\.sending\.message\.(delivered|deferred|bounced|failed|rejected|complained)$/.exec(type)?.[1];
  if (kind) await applySendEvent(env, eventId, kind, event, now);

  await env.DB.prepare('UPDATE email_provider_events SET processed_at = ? WHERE provider_event_id = ?').bind(now, eventId).run();
  return true;
}

interface SendLookup { id: string; app_id: string; identity_id: string; from_address: string; to_json: string }

async function applySendEvent(env: Env, eventId: string, kind: string, event: EmailSendingEvent, now: number): Promise<void> {
  const p = event.payload ?? {};
  const providerId = typeof p.messageId === 'string' ? p.messageId : '';
  // Mail the platform did not send through this feature (e.g. the legacy sender) has no record: nothing to attribute.
  const send = providerId ? await env.DB.prepare('SELECT id, app_id, identity_id, from_address, to_json FROM email_sends WHERE provider_id = ?').bind(providerId).first<SendLookup>() : null;
  if (!send) return;
  const occurredAt = toMs(event.metadata?.eventTimestamp, now);
  const bounce = p.bounce ?? null;
  const bounceType = String(bounce?.type ?? '');
  const permanent = kind === 'bounced' && (/hard|permanent/i.test(bounceType) || (bounceType === '' && p.terminal === true));
  const sentTo = JSON.parse(send.to_json) as string[];
  // Cloudflare reports per recipient. Only an address this send went to can be affected.
  const recipient = addressOf(p.recipient);
  const affected = sentTo.includes(recipient) ? [recipient] : [];
  const suppress = kind === 'complained' || permanent;
  const detail = kind === 'bounced' && bounce
    ? { bounce: { type: bounceType, subType: String(bounce.classification ?? ''), message: String(bounce.reason ?? '').slice(0, 300) } }
    : null;
  const type = `email.${kind}`;

  await env.DB.prepare('INSERT OR IGNORE INTO email_send_events (id, send_id, app_id, type, detail, occurred_at, provider_event_id) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .bind(crypto.randomUUID(), send.id, send.app_id, type, detail ? JSON.stringify(detail) : null, occurredAt, eventId).run();
  const column = kind === 'delivered' ? 'delivered_at' : kind === 'bounced' ? 'bounced_at' : kind === 'complained' ? 'complained_at' : null;
  if (column) await env.DB.prepare(`UPDATE email_sends SET ${column} = COALESCE(${column}, ?) WHERE id = ?`).bind(occurredAt, send.id).run();
  if (suppress) {
    for (const address of affected) {
      await env.DB.prepare('INSERT OR IGNORE INTO email_suppressions (app_id, address, reason, send_id, created_at) VALUES (?, ?, ?, ?, ?)')
        .bind(send.app_id, address, kind === 'complained' ? 'complained' : 'bounced', send.id, now).run();
    }
  }
  // History only for the rest (deferred, failed, rejected): the app is told about delivery, bounce and complaint.
  const name = kind === 'delivered' ? EMAIL_HOOKS.delivered : kind === 'bounced' ? EMAIL_HOOKS.bounced : kind === 'complained' ? EMAIL_HOOKS.complained : null;
  if (!name) return;
  await deliverAppEmailEvent(env, send.app_id, name, eventId, {
    type: name, id: eventId, sendId: send.id, providerId, from: send.from_address, to: affected.length ? affected : sentTo, occurredAt,
    ...(detail ?? {}), ...(kind === 'bounced' ? { permanent } : {}), suppressed: suppress && affected.length > 0,
  }, now);
}

/** The queue() entry for `pas-email-events`: apply each event; a failure retries that message only. */
export async function handleEmailEventBatch(batch: MessageBatch<EmailSendingEvent>, env: Env): Promise<void> {
  await Promise.allSettled(batch.messages.map(async (message) => {
    try {
      await applyProviderEvent(env, message.body);
      message.ack();
    } catch (e) {
      console.error(`[app-email] event failed: ${String((e as Error)?.message ?? e).slice(0, 300)}`);
      message.retry({ delaySeconds: Math.min(2 ** message.attempts * 10, 600) });
    }
  }));
}

interface InboundTarget { id: string; app_id: string; address: string; forward_copy_to: string | null }

/**
 * Email Routing's `email()` handler. Mail for an approved, unsuspended identity on a verified
 * domain of an app that is not suspended is parsed and handed to that app as `pas.email.inbound`;
 * anything else is rejected at the SMTP door, so the sender is told and nothing is dropped
 * silently. Any other failure throws: Email Routing then reports a temporary failure and the
 * sender retries, so a message is never lost to an app that is down.
 */
export async function handleInboundEmail(env: Env, message: ForwardableEmailMessage, now = Date.now()): Promise<void> {
  const recipient = addressOf(message.to);
  const target = await env.DB.prepare(
    `SELECT i.id, i.app_id, i.address, d.forward_copy_to FROM email_identities i
       JOIN email_domains d ON d.domain = i.domain AND d.app_id = i.app_id AND d.status = 'verified'
      WHERE i.status = 'approved' AND i.suspended = 0 AND i.address = ?
        AND NOT EXISTS (SELECT 1 FROM email_app_settings s WHERE s.app_id = i.app_id AND s.suspended = 1)`,
  ).bind(recipient).first<InboundTarget>();
  if (!target) {
    message.setReject('550 5.1.1 no such mailbox');
    return;
  }
  if (message.rawSize > MAX_INBOUND_RAW_BYTES) {
    message.setReject('552 5.3.4 message too large');
    return;
  }
  const raw = await new Response(message.raw).arrayBuffer();
  const mail = await PostalMime.parse(raw);
  // Identity of this message: its content, so SMTP redelivery of the same message routes once.
  const providerId = [...new Uint8Array(await crypto.subtle.digest('SHA-256', raw))].map((b) => b.toString(16).padStart(2, '0')).join('');
  const cap = (s: string | undefined) => (s && s.length > MAX_INBOUND_BODY_CHARS ? s.slice(0, MAX_INBOUND_BODY_CHARS) : (s ?? null));
  const truncated = (mail.text?.length ?? 0) > MAX_INBOUND_BODY_CHARS || (mail.html?.length ?? 0) > MAX_INBOUND_BODY_CHARS;
  const header = (name: string) => mail.headers.find((h) => h.key === name)?.value;
  const headers = Object.fromEntries((['in-reply-to', 'references', 'reply-to', 'date'] as const)
    .flatMap((k) => { const v = header(k); return v ? [[k, v.slice(0, 1000)] as const] : []; }));
  const from = mail.from ? (mail.from.name ? `${mail.from.name} <${mail.from.address}>` : String(mail.from.address)) : message.from;
  const receivedAt = toMs(header('date'), now) || now;

  await env.DB.prepare('INSERT OR IGNORE INTO email_inbound (id, app_id, identity_id, provider_id, from_address, subject, received_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .bind(crypto.randomUUID(), target.app_id, target.id, providerId, addressOf(from), String(mail.subject ?? '').slice(0, 500), now).run();
  const key = `inbound:${providerId}:${target.id}`;
  await deliverAppEmailEvent(env, target.app_id, EMAIL_HOOKS.inbound, key, {
    type: EMAIL_HOOKS.inbound, id: key, receivedAt, identity: { id: target.id, address: target.address }, providerId,
    messageId: mail.messageId ?? null, from, to: (mail.to ?? []).map((a) => String(a.address)).filter(Boolean), subject: mail.subject ?? '',
    text: cap(mail.text), html: cap(mail.html), truncated, headers,
    // Email Routing's own SPF/DKIM/DMARC verdicts. A display name or From header proves nothing.
    authentication: cloudflareAuthResults(message.headers),
    // Attachment bytes are never delivered: metadata only, quarantined until a later slice defines their handling.
    attachments: mail.attachments.map((a, i) => ({ id: String(i), filename: a.filename ?? '', contentType: a.mimeType, size: typeof a.content === 'string' ? a.content.length : a.content.byteLength, quarantined: true as const })),
  }, now);
  // The owner's own mailbox keeps a copy while the address moves to the worker. Only after the event is queued, and a
  // failure never rejects the message. Log a short code only: no address, header or body.
  if (target.forward_copy_to) {
    try { await message.forward(target.forward_copy_to); } catch { console.error('[email] inbound copy-forward failed code=forward_failed'); }
  }
}
