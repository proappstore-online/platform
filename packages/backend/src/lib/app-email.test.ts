import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { app } from '../index.js';
import worker from '../index.js';
import { makeEnv, testToken } from '../test-helpers.js';
import { sqliteD1 } from '../sqlite-d1.js';
import type { EmailSendMessage, EmailSendingBinding, Env } from '../types.js';
import {
  EmailError, EMAIL_LIMITS, setDomainForwardCopy, approveIdentity, claimDomain, declareIdentity, emailStatus, getSend, removeDomain, renderBodies, revokeIdentity,
  sendAppEmail, setAppEmailControls, setDomainVerified, suspendIdentity, type SendAppEmailInput,
} from './app-email.js';
import { WorkerCallError, workerEmailGet, workerEmailSend } from './app-worker-calls.js';
import { applyProviderEvent, handleEmailEventBatch, handleInboundEmail, type EmailSendingEvent } from './app-email-events.js';
import { cloudflareAuthResults } from './cf-email.js';

// #566 slices 1-3 against a faked Cloudflare `send_email` binding: no Email Service, DNS or
// network. The fake records every send, so a refusal is asserted as ZERO provider calls.

interface FakeEmail extends EmailSendingBinding {
  sent: EmailSendMessage[];
  /** One-shot failures for send(), consumed in order: a Cloudflare error code, or 'TypeError'. */
  failNext: string[];
}

function fakeEmail(): FakeEmail {
  const fake: FakeEmail = {
    sent: [], failNext: [],
    async send(message) {
      const fail = fake.failNext.shift();
      if (fail === 'TypeError') throw new TypeError('bad payload');
      if (fail) throw Object.assign(new Error(fail), { code: fail });
      fake.sent.push(message);
      return { messageId: `cfmsg_${fake.sent.length}` };
    },
  };
  return fake;
}

let email: FakeEmail;
let env: Env;
let queue: { send: ReturnType<typeof vi.fn> };
const NOW = Date.UTC(2026, 10, 18, 12, 0, 0);

async function seedApp(db: D1Database, id: string, creator: string) {
  await db.prepare('INSERT INTO apps (id, creator_id, created_at) VALUES (?, ?, ?)').bind(id, creator, NOW).run();
}
async function seedWorker(db: D1Database, id: string) {
  await db.prepare('INSERT INTO app_workers (app_id, enabled, deployed_at) VALUES (?, 1, ?)').bind(id, NOW).run();
}
async function seedUser(db: D1Database, id: string, address: string, login = id.replace(':', '-')) {
  await db.prepare('INSERT INTO users (id, provider, provider_id, login, email, created_at, last_login_at) VALUES (?, ?, ?, ?, ?, ?, ?)').bind(id, 'github', id, login, address, NOW, NOW).run();
}

/** A verified (attested), approved identity for `appId`. */
async function liveIdentity(appId: string, address: string, opts: { external?: boolean } = {}) {
  const domain = address.split('@')[1]!;
  await claimDomain(env, appId, domain, { now: NOW });
  await setDomainVerified(env, domain, true, NOW);
  const identity = await declareIdentity(env, appId, { address, displayName: 'Careers' }, 'gh:1', NOW);
  return approveIdentity(env, appId, identity.id, { allowExternal: opts.external === true }, 'gh:1', NOW);
}

const msg = (over: Partial<SendAppEmailInput> = {}): SendAppEmailInput => ({
  appId: 'hiring', identity: 'careers@betabuilders.org', to: 'candidate@example.com', subject: 'Interview', text: 'Hello <b>there</b>', idempotencyKey: 'k1', actor: 'system:worker', ...over,
});
const code = async (p: Promise<unknown>) => { try { await p; } catch (e) { if (e instanceof EmailError) return e.code; throw e; } return 'no error'; };

beforeEach(async () => {
  email = fakeEmail();
  queue = { send: vi.fn(async () => undefined) };
  const db = sqliteD1();
  env = makeEnv({ DB: db, EMAIL: email, APP_EVENTS: queue }) as unknown as Env;
  await seedApp(db, 'hiring', 'gh:1');
  await seedApp(db, 'other', 'gh:2');
  await seedWorker(db, 'hiring');
  await seedWorker(db, 'other');
  await seedUser(db, 'gh:1', 'owner@betabuilders.org');
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('slice 1: sender identities', () => {
  it('a claimed domain is unusable until a platform administrator attests it is an onboarded zone', async () => {
    const domain = await claimDomain(env, 'hiring', 'BetaBuilders.org', { now: NOW });
    expect(domain).toMatchObject({ domain: 'betabuilders.org', status: 'pending', records: [] });
    const identity = await declareIdentity(env, 'hiring', { address: 'Careers@BetaBuilders.org', displayName: 'Careers' }, 'gh:1', NOW);
    expect(identity).toMatchObject({ address: 'careers@betabuilders.org', status: 'pending', usable: false, domainVerified: false });
    await approveIdentity(env, 'hiring', identity.id, { allowExternal: true }, 'gh:1', NOW);

    expect(await code(sendAppEmail(env, msg(), NOW))).toBe('sender_domain_unverified');
    expect(email.sent).toHaveLength(0);

    expect(await setDomainVerified(env, 'betabuilders.org', true, NOW)).toMatchObject({ status: 'verified', verifiedAt: NOW });
    expect((await sendAppEmail(env, msg(), NOW)).status).toBe('accepted');

    // withdrawing the attestation stops every identity on the domain at once
    await setDomainVerified(env, 'betabuilders.org', false, NOW);
    expect(await code(sendAppEmail(env, msg({ idempotencyKey: 'k2' }), NOW))).toBe('sender_domain_unverified');
    expect(email.sent).toHaveLength(1);
    expect(await code(setDomainVerified(env, 'nobody.example', true))).toBe('not_found');
  });

  it('an identity needs a claimed domain and the owner approval; an approved one can be revoked and approved again', async () => {
    expect(await code(declareIdentity(env, 'hiring', { address: 'careers@betabuilders.org' }, 'gh:1', NOW))).toBe('domain_not_claimed');
    const live = await liveIdentity('hiring', 'careers@betabuilders.org');
    expect(live).toMatchObject({ status: 'approved', usable: true, allowExternal: false });
    expect((await sendAppEmail(env, msg({ to: 'owner@betabuilders.org' }), NOW)).status).toBe('accepted');

    expect(await revokeIdentity(env, 'hiring', live.id, 'gh:1', NOW)).toMatchObject({ status: 'revoked', usable: false });
    expect(await code(sendAppEmail(env, msg({ idempotencyKey: 'k2', to: 'owner@betabuilders.org' }), NOW))).toBe('sender_revoked');
    expect(email.sent).toHaveLength(1);

    await approveIdentity(env, 'hiring', live.id, { allowExternal: false }, 'gh:1', NOW);
    expect((await sendAppEmail(env, msg({ idempotencyKey: 'k3', to: 'owner@betabuilders.org' }), NOW)).status).toBe('accepted');
  });

  it('one app per verified domain; an unverified claim is displaced; the platform domain is reserved', async () => {
    await claimDomain(env, 'hiring', 'betabuilders.org', { now: NOW });
    await declareIdentity(env, 'hiring', { address: 'careers@betabuilders.org' }, 'gh:1', NOW);
    await claimDomain(env, 'other', 'betabuilders.org', { now: NOW });
    expect((await emailStatus(env, 'hiring')).domains).toHaveLength(0);
    expect((await emailStatus(env, 'hiring')).identities).toHaveLength(0);
    expect((await emailStatus(env, 'other')).domains[0]!.domain).toBe('betabuilders.org');

    await setDomainVerified(env, 'betabuilders.org', true, NOW);
    expect(await code(claimDomain(env, 'hiring', 'betabuilders.org', { now: NOW }))).toBe('domain_taken');
    expect(await code(claimDomain(env, 'hiring', 'hiring.proappstore.online', { now: NOW }))).toBe('domain_reserved');
    expect(await code(claimDomain(env, 'hiring', 'not a domain', { now: NOW }))).toBe('invalid_request');
  });

  it('app A cannot use or take app B\'s sender', async () => {
    await liveIdentity('hiring', 'careers@betabuilders.org', { external: true });
    expect(await code(sendAppEmail(env, msg({ appId: 'other' }), NOW))).toBe('sender_not_found');
    await claimDomain(env, 'other', 'other.example', { now: NOW });
    expect(await code(declareIdentity(env, 'other', { address: 'careers@betabuilders.org' }, 'gh:2', NOW))).toBe('domain_not_claimed');
    expect(email.sent).toHaveLength(0);
  });

  it('administrator kill switch: an app or one identity is refused with zero provider calls', async () => {
    const live = await liveIdentity('hiring', 'careers@betabuilders.org', { external: true });
    await suspendIdentity(env, 'hiring', live.id, true, 'abuse report');
    expect(await code(sendAppEmail(env, msg(), NOW))).toBe('sender_suspended');
    await suspendIdentity(env, 'hiring', live.id, false, null);
    await setAppEmailControls(env, 'hiring', { suspended: true, reason: 'spam' }, 'gh:admin', NOW);
    expect(await code(sendAppEmail(env, msg(), NOW))).toBe('app_suspended');
    expect(email.sent).toHaveLength(0);
    await setAppEmailControls(env, 'hiring', { suspended: false }, 'gh:admin', NOW);
    expect((await sendAppEmail(env, msg(), NOW)).status).toBe('accepted');
  });

  it('removing a domain revokes its identities', async () => {
    await liveIdentity('hiring', 'careers@betabuilders.org', { external: true });
    await removeDomain(env, 'hiring', 'betabuilders.org', NOW);
    expect((await emailStatus(env, 'hiring')).domains).toHaveLength(0);
    expect(await code(sendAppEmail(env, msg(), NOW))).toBe('sender_revoked');
  });

  it('the owner-readable status carries no secret', async () => {
    await liveIdentity('hiring', 'careers@betabuilders.org');
    const status = await emailStatus(env, 'hiring', NOW);
    expect(status).toMatchObject({ configured: true, suspended: false, limits: { daily: EMAIL_LIMITS.appDaily } });
    expect(status.identities[0]).toMatchObject({ address: 'careers@betabuilders.org', usable: true });
    expect(Object.keys(status.domains[0]!).sort()).toEqual(['createdAt', 'domain', 'id', 'records', 'status', 'verifiedAt']);
  });
});

describe('slice 2: trusted send', () => {
  beforeEach(async () => { await liveIdentity('hiring', 'careers@betabuilders.org', { external: true }); });

  it('pins From to the identity, returns the provider id and a server timestamp, and sends text and html separately', async () => {
    const r = await sendAppEmail(env, msg({ replyTo: 'Hiring@Betabuilders.org' }), NOW);
    expect(r).toMatchObject({ status: 'accepted', providerId: 'cfmsg_1', from: 'careers@betabuilders.org', to: ['candidate@example.com'], createdAt: NOW, acceptedAt: NOW, replayed: false });
    expect(email.sent).toEqual([{
      from: { email: 'careers@betabuilders.org', name: 'Careers' }, to: ['candidate@example.com'], subject: 'Interview', replyTo: 'hiring@betabuilders.org',
      text: 'Hello <b>there</b>', html: '<div>Hello &lt;b&gt;there&lt;/b&gt;</div>',
    }]);
  });

  it('text is escaped into the html part; html is sent as the html part only, and the text part is stripped of tags', () => {
    expect(renderBodies({ text: 'a & b\n<script>x</script>' })).toEqual({ text: 'a & b\n<script>x</script>', html: '<div>a &amp; b<br>\n&lt;script&gt;x&lt;/script&gt;</div>' });
    expect(renderBodies({ html: '<p>Hi <b>you</b></p><style>p{}</style>' })).toEqual({ text: 'Hi you', html: '<p>Hi <b>you</b></p><style>p{}</style>' });
    expect(() => renderBodies({})).toThrow(EmailError);
    expect(() => renderBodies({ text: 'x'.repeat(EMAIL_LIMITS.maxBodyChars + 1) })).toThrow(EmailError);
  });

  it('refuses malformed input before anything else, including header injection', async () => {
    for (const bad of [
      { idempotencyKey: '' }, { idempotencyKey: 'has space' }, { subject: 'a\r\nBcc: x@y.z' }, { subject: '' }, { to: [] }, { to: 'not-an-email' },
      { to: 'a@b.co\r\nBcc: x@y.z' }, { to: Array.from({ length: 11 }, (_, i) => `a${i}@example.com`) }, { replyTo: 'x' }, { text: '', html: '' },
    ]) {
      expect(await code(sendAppEmail(env, msg(bad as Partial<SendAppEmailInput>), NOW))).toBe('invalid_request');
    }
    expect(email.sent).toHaveLength(0);
  });

  it('an idempotent retry returns the same record and sends once; a different message under the key conflicts', async () => {
    const first = await sendAppEmail(env, msg(), NOW);
    const again = await sendAppEmail(env, msg(), NOW + 5000);
    expect(again).toMatchObject({ id: first.id, providerId: first.providerId, createdAt: NOW, replayed: true });
    expect(email.sent).toHaveLength(1);
    expect(await code(sendAppEmail(env, msg({ subject: 'Different' }), NOW))).toBe('idempotency_conflict');
    expect(email.sent).toHaveLength(1);
    expect((await sendAppEmail(env, msg({ idempotencyKey: 'k9' }), NOW)).id).not.toBe(first.id);
  });

  it('an unknown outcome is never sent again: Cloudflare has no idempotency key, so a retry could deliver twice', async () => {
    email.failNext.push('E_INTERNAL_SERVER_ERROR');
    const unknown = await sendAppEmail(env, msg(), NOW);
    expect(unknown).toMatchObject({ status: 'unknown', providerId: null, errorCode: 'provider_unavailable' });
    expect(await sendAppEmail(env, msg(), NOW + 1000)).toMatchObject({ id: unknown.id, status: 'unknown', replayed: true });
    expect(email.sent).toHaveLength(0);
  });

  it('a send Cloudflare reported as not sent (rate limit, not ready) completes on a retry under the same key', async () => {
    email.failNext.push('E_RATE_LIMIT_EXCEEDED');
    const busy = await sendAppEmail(env, msg(), NOW);
    expect(busy).toMatchObject({ status: 'unknown', errorCode: 'provider_busy' });
    const retry = await sendAppEmail(env, msg(), NOW + 1000);
    expect(retry).toMatchObject({ id: busy.id, status: 'accepted', providerId: 'cfmsg_1', replayed: true });
    expect(email.sent).toHaveLength(1);
    await sendAppEmail(env, msg(), NOW + 2000);
    expect(email.sent).toHaveLength(1);
  });

  it('a provider rejection is `refused` and final for that key; a suppressed recipient says so', async () => {
    email.failNext.push('E_SENDER_DOMAIN_NOT_AVAILABLE');
    const refused = await sendAppEmail(env, msg(), NOW);
    expect(refused).toMatchObject({ status: 'refused', providerId: null, errorCode: 'provider_rejected' });
    expect(await sendAppEmail(env, msg(), NOW)).toMatchObject({ id: refused.id, status: 'refused', replayed: true });
    email.failNext.push('E_RECIPIENT_SUPPRESSED');
    expect(await sendAppEmail(env, msg({ idempotencyKey: 'k2' }), NOW)).toMatchObject({ status: 'refused', errorCode: 'recipient_suppressed' });
    email.failNext.push('TypeError');
    expect(await sendAppEmail(env, msg({ idempotencyKey: 'k3' }), NOW)).toMatchObject({ status: 'refused', errorCode: 'provider_rejected' });
    expect(email.sent).toHaveLength(0);
  });

  it('enforces the daily, per-identity and burst quotas, atomically, and counts refused sends for none', async () => {
    await setAppEmailControls(env, 'hiring', { dailyLimit: 2, identityDailyLimit: 5, burstLimit: 5 }, 'gh:admin', NOW);
    await sendAppEmail(env, msg({ idempotencyKey: 'a' }), NOW);
    await sendAppEmail(env, msg({ idempotencyKey: 'b' }), NOW);
    expect(await code(sendAppEmail(env, msg({ idempotencyKey: 'c' }), NOW))).toBe('quota_app_daily');
    expect((await sendAppEmail(env, msg({ idempotencyKey: 'a' }), NOW)).replayed).toBe(true);
    expect(await code(sendAppEmail(env, msg({ idempotencyKey: 'd' }), NOW + 86_400_001))).toBe('no error');

    await setAppEmailControls(env, 'hiring', { dailyLimit: 100, identityDailyLimit: 1, burstLimit: 5 }, 'gh:admin', NOW);
    expect(await code(sendAppEmail(env, msg({ idempotencyKey: 'e' }), NOW + 86_400_002))).toBe('quota_identity_daily');
    await setAppEmailControls(env, 'hiring', { dailyLimit: 100, identityDailyLimit: 100, burstLimit: 1 }, 'gh:admin', NOW);
    const t = NOW + 3 * 86_400_000;
    await sendAppEmail(env, msg({ idempotencyKey: 'f' }), t);
    expect(await code(sendAppEmail(env, msg({ idempotencyKey: 'g' }), t + 1000))).toBe('quota_burst');
    expect(await code(sendAppEmail(env, msg({ idempotencyKey: 'h' }), t + 61_000))).toBe('no error');
  });

  it('one app\'s quota never limits another app', async () => {
    await setAppEmailControls(env, 'hiring', { dailyLimit: 1 }, 'gh:admin', NOW);
    await sendAppEmail(env, msg(), NOW);
    expect(await code(sendAppEmail(env, msg({ idempotencyKey: 'x' }), NOW))).toBe('quota_app_daily');
    await liveIdentity('other', 'jobs@other.example', { external: true });
    expect((await sendAppEmail(env, msg({ appId: 'other', identity: 'jobs@other.example' }), NOW)).status).toBe('accepted');
  });

  it('suppressed recipients are refused with zero provider calls, per app', async () => {
    await env.DB.prepare("INSERT INTO email_suppressions (app_id, address, reason, created_at) VALUES ('hiring', 'candidate@example.com', 'bounced', ?)").bind(NOW).run();
    expect(await code(sendAppEmail(env, msg({ to: ['ok@example.com', 'candidate@example.com'] }), NOW))).toBe('recipient_suppressed');
    expect(email.sent).toHaveLength(0);
    await liveIdentity('other', 'jobs@other.example', { external: true });
    expect((await sendAppEmail(env, msg({ appId: 'other', identity: 'jobs@other.example' }), NOW)).status).toBe('accepted');
  });

  it('external recipients need an identity the owner approved for them', async () => {
    const internal = await liveIdentity('other', 'jobs@other.example');
    await seedUser(env.DB, 'gh:2', 'boss@other.example');
    await seedUser(env.DB, 'gh:3', 'editor@other.example', 'editor3');
    await env.DB.prepare("INSERT INTO app_roles (app_id, user_id, role_name) VALUES ('other', 'gh:3', 'editor')").run();
    expect(await code(sendAppEmail(env, msg({ appId: 'other', identity: internal.id, to: 'stranger@example.com' }), NOW))).toBe('external_recipient_not_allowed');
    expect(email.sent).toHaveLength(0);
    expect((await sendAppEmail(env, msg({ appId: 'other', identity: internal.id, to: ['boss@other.example', 'EDITOR@other.example'] }), NOW)).status).toBe('accepted');
    expect(await code(sendAppEmail(env, msg({ appId: 'other', identity: internal.id, idempotencyKey: 'k5', to: 'owner@betabuilders.org' }), NOW))).toBe('external_recipient_not_allowed');
    await approveIdentity(env, 'other', internal.id, { allowExternal: true }, 'gh:2', NOW);
    expect((await sendAppEmail(env, msg({ appId: 'other', identity: internal.id, idempotencyKey: 'k6', to: 'stranger@example.com' }), NOW)).status).toBe('accepted');
  });

  it('is inert without the EMAIL binding: a clear refusal and no provider call at all', async () => {
    const bare = { ...env, EMAIL: undefined } as Env;
    expect(await code(sendAppEmail(bare, msg(), NOW))).toBe('email_not_configured');
    expect(await code(claimDomain(bare, 'hiring', 'x.example', { now: NOW }))).toBe('email_not_configured');
    expect(email.sent).toHaveLength(0);
    expect(await emailStatus(bare, 'hiring')).toMatchObject({ configured: false });
  });

  it('send records are readable by their own app only', async () => {
    const r = await sendAppEmail(env, msg(), NOW);
    expect(await getSend(env, 'hiring', r.id)).toMatchObject({ id: r.id, providerId: 'cfmsg_1', subject: 'Interview', actor: 'system:worker', events: [] });
    expect(await code(getSend(env, 'other', r.id))).toBe('not_found');
  });
});

describe('the app worker binding (pas.email)', () => {
  beforeEach(async () => { await liveIdentity('hiring', 'careers@betabuilders.org', { external: true }); });
  const wcode = async (p: Promise<unknown>) => { try { await p; } catch (e) { if (e instanceof WorkerCallError) return e.message; throw e; } return 'no error'; };

  it('sends as the binding\'s app and system:worker, and refuses a caller-supplied From, provider id, timestamp or app', async () => {
    const r = await workerEmailSend(env, 'hiring', { identity: 'careers@betabuilders.org', to: 'c@example.com', subject: 'Hi', text: 'x', idempotencyKey: 'w1' }) as { id: string; status: string };
    expect(r.status).toBe('accepted');
    expect((await getSend(env, 'hiring', r.id)).actor).toBe('system:worker');
    for (const field of ['from', 'providerId', 'sentAt', 'appId', 'headers']) {
      expect(await wcode(workerEmailSend(env, 'hiring', { identity: 'careers@betabuilders.org', to: 'c@example.com', subject: 'Hi', text: 'x', idempotencyKey: `w-${field}`, [field]: 'evil@x.com' })))
        .toMatch(/^BadRequest: invalid_request/);
    }
    expect(email.sent).toHaveLength(1);
  });

  it('maps refusals to a worker error class with the stable code', async () => {
    const input = { to: 'c@example.com', subject: 'Hi', text: 'x', idempotencyKey: 'w2' };
    expect(await wcode(workerEmailSend(env, 'hiring', { ...input, identity: 'ghost@betabuilders.org' }))).toMatch(/^Forbidden: sender_not_found/);
    await setAppEmailControls(env, 'hiring', { suspended: true }, 'a', NOW);
    expect(await wcode(workerEmailSend(env, 'hiring', { ...input, identity: 'careers@betabuilders.org' }))).toMatch(/^Forbidden: app_suspended/);
    await setAppEmailControls(env, 'hiring', { dailyLimit: 0 }, 'a', NOW);
    expect(await wcode(workerEmailSend(env, 'hiring', { ...input, identity: 'careers@betabuilders.org' }))).toMatch(/^RateLimited: quota_app_daily/);
    expect(await wcode(workerEmailSend({ ...env, EMAIL: undefined } as Env, 'hiring', { ...input, identity: 'careers@betabuilders.org' }))).toMatch(/^Unavailable: email_not_configured/);
    expect(await wcode(workerEmailGet(env, 'other', 'nope'))).toMatch(/^NotFound: not_found/);
    expect(await wcode(workerEmailSend(env, 'hiring', null))).toMatch(/^BadRequest/);
  });
});

// ── slice 3 ─────────────────────────────────────────────────────────────────

const queued = () => queue.send.mock.calls.map((c) => c[0] as { app_id: string; name: string; id: string; payload: { body: string }; ref: { table: string; id: string } });
const queuedEvent = (i: number) => JSON.parse(queued()[i]!.payload.body) as Record<string, unknown>;
const T0 = '2026-11-18T12:01:00.000Z';

/** Deliver one event through the queue consumer; reports whether the message was acked. */
async function consume(...events: EmailSendingEvent[]) {
  const messages = events.map((body) => ({ body, attempts: 1, ack: vi.fn(), retry: vi.fn() }));
  await handleEmailEventBatch({ queue: 'pas-email-events', messages } as unknown as MessageBatch<EmailSendingEvent>, env);
  return messages.map((m) => (m.ack.mock.calls.length ? 'ack' : m.retry.mock.calls.length ? 'retry' : 'none'));
}
const cfEvent = (kind: string, messageId: string | null, over: Record<string, unknown> = {}, eventId = 'ev_1'): EmailSendingEvent => ({
  type: `cf.email.sending.message.${kind}`, source: { type: 'email.sending', zoneId: 'z', domain: 'betabuilders.org' },
  payload: { eventId, messageId, sender: 'careers@betabuilders.org', recipient: 'candidate@example.com', terminal: kind !== 'deferred', ...over },
  metadata: { eventTimestamp: T0 },
} as EmailSendingEvent);

describe('slice 3: delivery events', () => {
  let sent: { id: string; providerId: string | null };
  beforeEach(async () => {
    await liveIdentity('hiring', 'careers@betabuilders.org', { external: true });
    sent = await sendAppEmail(env, msg({ to: ['candidate@example.com'] }), NOW) as typeof sent;
  });

  it('delivered: sets delivered_at once, appends an event, and hands the app a hook event', async () => {
    expect(await consume(cfEvent('delivered', sent.providerId))).toEqual(['ack']);
    const record = await getSend(env, 'hiring', sent.id);
    expect(record).toMatchObject({ status: 'accepted', deliveredAt: Date.parse(T0), bouncedAt: null });
    expect(record.events).toEqual([{ type: 'email.delivered', at: Date.parse(T0), detail: null }]);
    expect(queued()).toHaveLength(1);
    expect(queued()[0]).toMatchObject({ type: 'hook', name: 'pas.email.delivered', app_id: 'hiring', ref: { table: 'app_hook_deliveries' } });
    expect(queuedEvent(0)).toEqual({
      type: 'pas.email.delivered', id: 'ev_1', sendId: sent.id, providerId: sent.providerId, from: 'careers@betabuilders.org',
      to: ['candidate@example.com'], occurredAt: Date.parse(T0), suppressed: false,
    });
  });

  it('a repeated event applies once; a later delivered event does not rewrite the first timestamp', async () => {
    await consume(cfEvent('delivered', sent.providerId));
    await consume(cfEvent('delivered', sent.providerId));
    expect(queued()).toHaveLength(1);
    expect((await getSend(env, 'hiring', sent.id)).events).toHaveLength(1);
    await consume({ ...cfEvent('delivered', sent.providerId, {}, 'ev_2'), metadata: { eventTimestamp: '2026-11-18T13:00:00.000Z' } });
    expect((await getSend(env, 'hiring', sent.id)).deliveredAt).toBe(Date.parse(T0));
  });

  it('a hard bounce suppresses the recipient and the next send is refused; a soft one does not', async () => {
    const bounced = (type: string, id: string) => cfEvent('bounced', sent.providerId, { bounce: { type, classification: 'mailbox', reason: 'mailbox full' } }, id);
    await consume(bounced('soft', 'ev_s'));
    expect(queuedEvent(0)).toMatchObject({ type: 'pas.email.bounced', permanent: false, suppressed: false, bounce: { type: 'soft', subType: 'mailbox', message: 'mailbox full' } });
    expect(await code(sendAppEmail(env, msg({ idempotencyKey: 'again' }), NOW))).toBe('no error');

    await consume(bounced('hard', 'ev_h'));
    expect(queuedEvent(1)).toMatchObject({ permanent: true, suppressed: true, to: ['candidate@example.com'] });
    expect((await env.DB.prepare('SELECT address, reason, send_id FROM email_suppressions WHERE app_id = ?').bind('hiring').all()).results).toEqual([{ address: 'candidate@example.com', reason: 'bounced', send_id: sent.id }]);
    const sends = email.sent.length;
    expect(await code(sendAppEmail(env, msg({ idempotencyKey: 'after-bounce' }), NOW))).toBe('recipient_suppressed');
    expect(email.sent).toHaveLength(sends);
    expect((await getSend(env, 'hiring', sent.id)).bouncedAt).toBe(Date.parse(T0));
  });

  it('a complaint suppresses exactly the complaining recipient, never an address the send did not go to', async () => {
    await consume(cfEvent('complained', sent.providerId, { complaint: { type: 'abuse' } }, 'ev_c1'));
    await consume(cfEvent('complained', sent.providerId, { recipient: 'victim@example.com' }, 'ev_c2'));
    expect((await env.DB.prepare('SELECT address, reason FROM email_suppressions').all()).results).toEqual([{ address: 'candidate@example.com', reason: 'complained' }]);
    expect(queuedEvent(0)).toMatchObject({ type: 'pas.email.complained', suppressed: true });
    expect(queuedEvent(1)).toMatchObject({ type: 'pas.email.complained', suppressed: false });
  });

  it('an event is delivered to the app that owns the send and to no other', async () => {
    await liveIdentity('other', 'jobs@other.example', { external: true });
    const theirs = await sendAppEmail(env, msg({ appId: 'other', identity: 'jobs@other.example', idempotencyKey: 'o1' }), NOW);
    await consume(cfEvent('delivered', theirs.providerId, {}, 'ev_o'));
    expect(queued().map((q) => q.app_id)).toEqual(['other']);
    expect((await getSend(env, 'hiring', sent.id)).events).toHaveLength(0);
  });

  it('records deferred and failed as history without telling the app; ignores mail it did not send and unknown events', async () => {
    await consume(cfEvent('deferred', sent.providerId, {}, 'ev_d'), cfEvent('failed', sent.providerId, { failure: { reason: 'x' } }, 'ev_f'));
    expect((await getSend(env, 'hiring', sent.id)).events.map((e) => e.type)).toEqual(['email.deferred', 'email.failed']);
    expect(await consume(cfEvent('delivered', 'legacy-message', {}, 'ev_x'), { type: 'cf.email.sending.other', payload: { eventId: 'ev_y' } } as EmailSendingEvent, { type: 'junk' } as EmailSendingEvent)).toEqual(['ack', 'ack', 'ack']);
    expect(queued()).toHaveLength(0);
  });

  it('fails the delivery row when the app has no worker; the history is kept', async () => {
    await env.DB.prepare('UPDATE app_workers SET enabled = 0 WHERE app_id = ?').bind('hiring').run();
    await consume(cfEvent('delivered', sent.providerId));
    expect(queued()).toHaveLength(0);
    expect(await env.DB.prepare("SELECT status, error FROM app_hook_deliveries WHERE app_id = 'hiring'").first()).toEqual({ status: 'failed', error: 'app worker not deployed' });
    expect((await getSend(env, 'hiring', sent.id)).deliveredAt).not.toBeNull();
  });

  it('a queue failure retries the message, and the retry delivers exactly once', async () => {
    queue.send.mockRejectedValueOnce(new Error('queue down'));
    expect(await consume(cfEvent('delivered', sent.providerId))).toEqual(['retry']);
    expect(queued()).toHaveLength(1);
    expect(await consume(cfEvent('delivered', sent.providerId))).toEqual(['ack']);
    expect(queued()).toHaveLength(2);
    expect(queued()[1]!.id).toBe(queued()[0]!.id); // same envelope id: the app de-duplicates on it
    expect(await consume(cfEvent('delivered', sent.providerId))).toEqual(['ack']);
    expect(queued()).toHaveLength(2);
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM email_send_events').first()).toEqual({ n: 1 });
  });

  it('the worker\'s queue() routes pas-email-events to the event consumer', async () => {
    const message = { body: cfEvent('delivered', sent.providerId), attempts: 1, ack: vi.fn(), retry: vi.fn() };
    await worker.queue({ queue: 'pas-email-events', messages: [message] } as never, env, { waitUntil() {} } as never);
    expect(message.ack).toHaveBeenCalled();
    expect(queued()).toHaveLength(1);
  });

  it('applyProviderEvent returns false for an event it already applied', async () => {
    expect(await applyProviderEvent(env, cfEvent('deferred', 'none', {}, 'ev_z'), NOW)).toBe(true);
    expect(await applyProviderEvent(env, cfEvent('deferred', 'none', {}, 'ev_z'), NOW)).toBe(false);
  });
});

describe('slice 3: inbound (Email Routing email() handler)', () => {
  const mime = (over: { to?: string; text?: string; auth?: string | null; extra?: string } = {}) => [
    ...(over.auth === null ? [] : [`Authentication-Results: ${over.auth ?? 'mx.cloudflare.net; spf=pass smtp.mailfrom=example.com; dkim=pass header.d=example.com; dmarc=fail header.from=example.com'}`]),
    'From: Dana Candidate <dana@example.com>', `To: ${over.to ?? 'Careers <careers@betabuilders.org>'}`, 'Subject: Re: Interview', 'Date: Wed, 18 Nov 2026 12:04:59 +0000',
    'Message-ID: <r1@example.com>', 'In-Reply-To: <m1@x>', 'References: <m1@x>', 'X-Other: dropped', 'MIME-Version: 1.0',
    'Content-Type: multipart/mixed; boundary="b"', ...(over.extra ? [over.extra] : []), '',
    '--b', 'Content-Type: text/plain; charset=utf-8', '', over.text ?? 'Thursday works', '',
    '--b', 'Content-Type: application/pdf; name="cv.pdf"', 'Content-Disposition: attachment; filename="cv.pdf"', 'Content-Transfer-Encoding: base64', '', btoa('%PDF-1.4 fake'), '--b--', '',
  ].join('\r\n');
  const incoming = (raw: string, to = 'careers@betabuilders.org') => {
    const bytes = new TextEncoder().encode(raw);
    const headers = new Headers();
    for (const line of raw.split('\r\n\r\n')[0]!.split('\r\n')) { const i = line.indexOf(':'); if (i > 0) headers.append(line.slice(0, i), line.slice(i + 1).trim()); }
    return { from: 'bounce@example.com', to, headers, rawSize: bytes.byteLength, raw: new Response(bytes).body!, setReject: vi.fn(), forward: vi.fn(async () => {}) } as unknown as ForwardableEmailMessage & { setReject: ReturnType<typeof vi.fn>; forward: ReturnType<typeof vi.fn> };
  };
  beforeEach(async () => { await liveIdentity('hiring', 'careers@betabuilders.org'); });

  it('routes mail for a verified identity to its app as a hook event with the Cloudflare authentication results', async () => {
    const message = incoming(mime());
    await handleInboundEmail(env, message, NOW);
    expect(message.setReject).not.toHaveBeenCalled();
    expect(queued()).toHaveLength(1);
    expect(queued()[0]).toMatchObject({ type: 'hook', name: 'pas.email.inbound', app_id: 'hiring' });
    const id = (await env.DB.prepare("SELECT id FROM email_identities WHERE address = 'careers@betabuilders.org'").first<{ id: string }>())!.id;
    const event = queuedEvent(0);
    expect(event).toMatchObject({
      type: 'pas.email.inbound', identity: { id, address: 'careers@betabuilders.org' }, messageId: '<r1@example.com>',
      from: 'Dana Candidate <dana@example.com>', to: ['careers@betabuilders.org'], subject: 'Re: Interview', text: expect.stringMatching(/^Thursday works\s*$/), html: null, truncated: false,
      headers: { 'in-reply-to': '<m1@x>', references: '<m1@x>', date: 'Wed, 18 Nov 2026 12:04:59 +0000' },
      authentication: { spf: 'pass', dkim: 'pass', dmarc: 'fail' },
      attachments: [{ id: '0', filename: 'cv.pdf', contentType: 'application/pdf', quarantined: true }],
    });
    expect(event.id).toBe(`inbound:${event.providerId}:${id}`);
    expect(await env.DB.prepare('SELECT app_id, from_address, subject FROM email_inbound').first()).toEqual({ app_id: 'hiring', from_address: 'dana@example.com', subject: 'Re: Interview' });
  });

  it('SMTP redelivery of the same message routes once', async () => {
    await handleInboundEmail(env, incoming(mime()), NOW);
    await handleInboundEmail(env, incoming(mime()), NOW + 1000);
    expect(queued()).toHaveLength(1);
  });

  it('mail for no live identity is rejected at the door and goes nowhere', async () => {
    const unknown = incoming(mime(), 'nobody@betabuilders.org');
    await handleInboundEmail(env, unknown, NOW);
    expect(unknown.setReject).toHaveBeenCalledWith(expect.stringMatching(/^550/));
    const id = (await env.DB.prepare("SELECT id FROM email_identities WHERE address = 'careers@betabuilders.org'").first<{ id: string }>())!.id;
    const rejected = async () => { const m = incoming(mime()); await handleInboundEmail(env, m, NOW); return m.setReject.mock.calls.length; };
    await revokeIdentity(env, 'hiring', id, 'gh:1', NOW);
    expect(await rejected()).toBe(1);
    await approveIdentity(env, 'hiring', id, { allowExternal: false }, 'gh:1', NOW);
    await suspendIdentity(env, 'hiring', id, true, 'x');
    expect(await rejected()).toBe(1);
    await suspendIdentity(env, 'hiring', id, false, null);
    await setAppEmailControls(env, 'hiring', { suspended: true }, 'a', NOW);
    expect(await rejected()).toBe(1);
    await setAppEmailControls(env, 'hiring', { suspended: false }, 'a', NOW);
    await setDomainVerified(env, 'betabuilders.org', false, NOW);
    expect(await rejected()).toBe(1);
    expect(queued()).toHaveLength(0);
  });

  it('mail for app A\'s address never reaches app B', async () => {
    await liveIdentity('other', 'jobs@other.example');
    await handleInboundEmail(env, incoming(mime({ to: 'jobs@other.example' }), 'jobs@other.example'), NOW);
    expect(queued().map((q) => q.app_id)).toEqual(['other']);
  });

  it('rejects an oversize message and cuts an oversize body', async () => {
    const big = incoming(mime());
    Object.defineProperty(big, 'rawSize', { value: 26 * 1024 * 1024 });
    await handleInboundEmail(env, big, NOW);
    expect(big.setReject).toHaveBeenCalledWith(expect.stringMatching(/^552/));
    expect(queued()).toHaveLength(0);
    // over the queue's message size the body spills to R2 (lib/app-event-queue.ts)
    const r2 = new Map<string, Uint8Array>();
    const environment = { ...env, STORAGE: { put: async (k: string, v: Uint8Array) => { r2.set(k, v); }, delete: async (k: string) => { r2.delete(k); } } } as unknown as Env;
    await handleInboundEmail(environment, incoming(mime({ text: 'x'.repeat(250_000) })), NOW);
    const event = JSON.parse(new TextDecoder().decode(r2.get((queued()[0] as unknown as { body_key: string }).body_key))) as Record<string, unknown>;
    expect(event).toMatchObject({ truncated: true });
    expect((event.text as string).length).toBe(200_000);
  });

  it('a queue failure throws, so Email Routing reports a temporary failure and the sender retries', async () => {
    queue.send.mockRejectedValueOnce(new Error('queue down'));
    await expect(handleInboundEmail(env, incoming(mime()), NOW)).rejects.toThrow('queue down');
    await handleInboundEmail(env, incoming(mime()), NOW + 1000);
    expect(queued()).toHaveLength(2);
    expect(queued()[1]!.id).toBe(queued()[0]!.id);
  });

  it('forwards a copy to forward_copy_to after the event is queued', async () => {
    await setDomainForwardCopy(env, 'betabuilders.org', 'Owner@Gmail.com');
    const message = incoming(mime());
    message.forward.mockImplementation(async () => { expect(queued()).toHaveLength(1); });
    await handleInboundEmail(env, message, NOW);
    expect(message.forward.mock.calls).toEqual([['owner@gmail.com']]);
    expect(message.setReject).not.toHaveBeenCalled();
  });

  it('a forward that throws is logged as a short code and never fails the message', async () => {
    await setDomainForwardCopy(env, 'betabuilders.org', 'owner@gmail.com');
    const message = incoming(mime());
    message.forward.mockRejectedValue(new Error('destination owner@gmail.com not verified'));
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(handleInboundEmail(env, message, NOW)).resolves.toBeUndefined();
    expect(message.setReject).not.toHaveBeenCalled();
    expect(queued()).toHaveLength(1);
    expect(log.mock.calls).toEqual([['[email] inbound copy-forward failed code=forward_failed']]);
    log.mockRestore();
  });

  it('does not forward when forward_copy_to is not set, or after it is cleared', async () => {
    const plain = incoming(mime());
    await handleInboundEmail(env, plain, NOW);
    expect(plain.forward).not.toHaveBeenCalled();
    await setDomainForwardCopy(env, 'betabuilders.org', 'owner@gmail.com');
    await setDomainForwardCopy(env, 'betabuilders.org', null);
    const cleared = incoming(mime());
    await handleInboundEmail(env, cleared, NOW + 1000);
    expect(cleared.forward).not.toHaveBeenCalled();
  });

  it('refuses a forward_copy_to that is not an email address, and an unclaimed domain', async () => {
    await expect(setDomainForwardCopy(env, 'betabuilders.org', 'not-an-address')).rejects.toMatchObject({ code: 'invalid_request' });
    await expect(setDomainForwardCopy(env, 'nobody.example', 'owner@gmail.com')).rejects.toMatchObject({ code: 'not_found' });
  });

  it('trusts only the leading mx.cloudflare.net Authentication-Results header', () => {
    expect(cloudflareAuthResults(new Headers({ 'authentication-results': 'mx.cloudflare.net; spf=pass; dkim=none; dmarc=pass' }))).toEqual({ spf: 'pass', dkim: 'none', dmarc: 'pass' });
    expect(cloudflareAuthResults(new Headers({ 'authentication-results': 'evil.example; spf=pass; dkim=pass; dmarc=pass' }))).toBeNull();
    expect(cloudflareAuthResults(new Headers({ 'authentication-results': 'mx.cloudflare.net; spf=fail; dkim=fail; dmarc=fail; mx.cloudflare.net; spf=pass; dkim=pass; dmarc=pass' }))).toEqual({ spf: 'fail', dkim: 'fail', dmarc: 'fail' });
    expect(cloudflareAuthResults(new Headers())).toBeNull();
  });
});

describe('verified-email routes', () => {
  const OWNER = 'gh:1';
  let owner: string;
  let stranger: string;
  let admin: string;
  const call = (path: string, token: string | null, method = 'GET', body?: unknown) =>
    app.request(`/v1${path}`, { method, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }, env);
  beforeEach(async () => {
    owner = await testToken(OWNER);
    stranger = await testToken('gh:9');
    admin = await testToken('gh:100', { roles: ['user', 'admin'] });
  });

  it('runs the whole path over HTTP: claim, administrator attests, declare, approve, send, read', async () => {
    expect((await call('/apps/hiring/email', null)).status).toBe(401);
    expect((await call('/apps/hiring/email', stranger)).status).toBe(403);
    const claimed = await call('/apps/hiring/email/domains', owner, 'POST', { domain: 'betabuilders.org' });
    expect(claimed.status).toBe(201);
    expect(await claimed.json()).toMatchObject({ domain: 'betabuilders.org', status: 'pending', records: [] });
    expect(await (await call('/apps/hiring/email/domains/betabuilders.org/verify', owner, 'POST')).json()).toMatchObject({ status: 'pending' });
    expect((await call('/admin/email/domains/betabuilders.org', owner, 'POST', { verified: true })).status).toBe(403); // the owner cannot attest their own domain
    expect(await (await call('/admin/email/domains/betabuilders.org', admin, 'POST', { verified: true })).json()).toMatchObject({ status: 'verified' });
    expect(await (await call('/apps/hiring/email/domains/betabuilders.org/verify', owner, 'POST')).json()).toMatchObject({ status: 'verified' });
    // copy-forward: administrator only, validated, and it leaves the attestation alone
    expect((await call('/admin/email/domains/betabuilders.org', owner, 'POST', { forwardCopyTo: 'me@gmail.com' })).status).toBe(403);
    expect((await call('/admin/email/domains/betabuilders.org', admin, 'POST', { forwardCopyTo: 'nope' })).status).toBe(400);
    expect(await (await call('/admin/email/domains/betabuilders.org', admin, 'POST', { forwardCopyTo: 'me@gmail.com' })).json()).toMatchObject({ status: 'verified' });
    expect(await env.DB.prepare("SELECT forward_copy_to FROM email_domains WHERE domain = 'betabuilders.org'").first()).toEqual({ forward_copy_to: 'me@gmail.com' });
    const declared = await (await call('/apps/hiring/email/identities', owner, 'POST', { address: 'careers@betabuilders.org', displayName: 'Careers' })).json() as { id: string };
    const send = { identity: 'careers@betabuilders.org', to: 'candidate@example.com', subject: 'Hello', text: 'Hi', idempotencyKey: 'r1' };
    const refused = await call('/apps/hiring/email/send', owner, 'POST', send);
    expect(refused.status).toBe(403);
    expect(await refused.json()).toMatchObject({ code: 'sender_not_approved' });
    expect((await call(`/apps/hiring/email/identities/${declared.id}/approve`, stranger, 'POST', { allowExternal: true })).status).toBe(403);
    expect(await (await call(`/apps/hiring/email/identities/${declared.id}/approve`, owner, 'POST', { allowExternal: true })).json()).toMatchObject({ usable: true, allowExternal: true });
    const ok = await call('/apps/hiring/email/send', owner, 'POST', send);
    expect(ok.status).toBe(201);
    const result = await ok.json() as { id: string; providerId: string };
    expect(result.providerId).toBe('cfmsg_1');
    expect((await call('/apps/hiring/email/send', owner, 'POST', send)).status).toBe(200); // replay
    expect(email.sent).toHaveLength(1);
    expect(await (await call(`/apps/hiring/email/sends/${result.id}`, owner)).json()).toMatchObject({ providerId: 'cfmsg_1', events: [] });
    expect((await call(`/apps/hiring/email/sends/${result.id}`, stranger)).status).toBe(403);
    expect(((await (await call('/apps/hiring/email/sends', owner)).json()) as { sends: unknown[] }).sends).toHaveLength(1);
    expect(await (await call('/apps/hiring/email/suppressions', owner)).json()).toEqual({ suppressions: [] });
    expect(await (await call('/apps/hiring/email', owner)).json()).toMatchObject({ identities: [{ address: 'careers@betabuilders.org', usable: true }] });
  });

  it('the Resend webhook route is gone', async () => {
    expect((await call('/email/provider-events', null, 'POST', {})).status).toBe(404);
  });

  it('refuses a From, provider id or timestamp in the request body', async () => {
    await liveIdentity('hiring', 'careers@betabuilders.org', { external: true });
    const res = await call('/apps/hiring/email/send', owner, 'POST', { identity: 'careers@betabuilders.org', to: 'c@example.com', subject: 'Hi', text: 'x', idempotencyKey: 'f1', from: 'ceo@betabuilders.org' });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: 'invalid_request' });
    expect(email.sent).toHaveLength(0);
  });

  it('an editor can send and declare, but only the owner can approve or manage domains', async () => {
    const editor = await testToken('gh:7');
    await env.DB.prepare("INSERT INTO app_roles (app_id, user_id, role_name) VALUES ('hiring', 'gh:7', 'editor')").run();
    const live = await liveIdentity('hiring', 'careers@betabuilders.org', { external: true });
    expect((await call('/apps/hiring/email/send', editor, 'POST', { identity: live.id, to: 'c@example.com', subject: 'Hi', text: 'x', idempotencyKey: 'e1' })).status).toBe(201);
    expect((await call('/apps/hiring/email/identities', editor, 'POST', { address: 'jobs@betabuilders.org' })).status).toBe(201);
    expect((await call(`/apps/hiring/email/identities/${live.id}/revoke`, editor, 'POST')).status).toBe(403);
    expect((await call('/apps/hiring/email/domains', editor, 'POST', { domain: 'x.example' })).status).toBe(403);
  });

  it('answers 503 with a clear message until the EMAIL binding exists', async () => {
    env = { ...env, EMAIL: undefined } as Env;
    const res = await call('/apps/hiring/email/domains', owner, 'POST', { domain: 'betabuilders.org' });
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ code: 'email_not_configured' });
    expect(await (await call('/apps/hiring/email', owner)).json()).toMatchObject({ configured: false });
  });

  it('only an administrator can use the kill switch, and it takes effect at once', async () => {
    const live = await liveIdentity('hiring', 'careers@betabuilders.org', { external: true });
    const send = { identity: live.id, to: 'c@example.com', subject: 'Hi', text: 'x' };
    expect((await call('/admin/email/apps/hiring', owner, 'POST', { suspended: true })).status).toBe(403);
    const off = await call('/admin/email/apps/hiring', admin, 'POST', { suspended: true, reason: 'spam report', dailyLimit: 10 });
    expect(await off.json()).toMatchObject({ suspended: true, suspendedReason: 'spam report', limits: { daily: 10 } });
    expect(await (await call('/apps/hiring/email/send', owner, 'POST', { ...send, idempotencyKey: 's1' })).json()).toMatchObject({ code: 'app_suspended' });
    await call('/admin/email/apps/hiring', admin, 'POST', { suspended: false });
    const off2 = await call(`/admin/email/apps/hiring/identities/${live.id}/suspend`, admin, 'POST', { suspended: true, reason: 'x' });
    expect(await off2.json()).toMatchObject({ suspended: true, usable: false });
    expect(await (await call('/apps/hiring/email/send', owner, 'POST', { ...send, idempotencyKey: 's2' })).json()).toMatchObject({ code: 'sender_suspended' });
    expect(email.sent).toHaveLength(0);
  });
});
