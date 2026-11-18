import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { app } from '../index.js';
import { makeEnv, testToken } from '../test-helpers.js';
import { sqliteD1 } from '../sqlite-d1.js';
import type { Env } from '../types.js';
import {
  EmailError, EMAIL_LIMITS, approveIdentity, claimDomain, declareIdentity, emailStatus, getSend, removeDomain, renderBodies, revokeIdentity,
  sendAppEmail, setAppEmailControls, suspendIdentity, verifyDomainClaim, type SendAppEmailInput,
} from './app-email.js';
import { WorkerCallError, workerEmailGet, workerEmailSend } from './app-worker-calls.js';
import { applyProviderEvent } from './app-email-events.js';

// #566 slices 1-3 against a faked Resend: no account, key, DNS or network. The fake keeps what the
// real provider would (domains, idempotent sends, received mail) and records every call, so a
// refusal is asserted as ZERO provider calls.

const KEY = 'resend-test-key';
const WH_SECRET = `whsec_${btoa('webhook-signing-secret-for-tests!!')}`;

interface Fake {
  calls: { method: string; path: string; auth: string | null; body: unknown; idem: string | null }[];
  sends: () => number;
  dnsOk: boolean;
  /** One-shot failures for POST /emails, consumed in order: a status, or 'timeout'. */
  failNext: (number | 'timeout')[];
  received: Record<string, unknown>;
  failReceived: boolean;
}

function fakeResend(): Fake {
  const state: Fake = { calls: [], sends: () => emails.size, dnsOk: false, failNext: [], received: {}, failReceived: false };
  const emails = new Map<string, string>(); // idempotency key -> provider id
  let n = 0;
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit = {}) => {
    const path = new URL(url).pathname + new URL(url).search.replace(/\?html_format=cid$/, '');
    const headers = new Headers(init.headers);
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    const method = init.method ?? 'GET';
    state.calls.push({ method, path, auth: headers.get('authorization'), body, idem: headers.get('idempotency-key') });
    if (method === 'POST' && path === '/domains') {
      return Response.json({ id: `dom_${++n}`, name: body.name, status: 'not_started', records: [
        { record: 'DKIM', name: 'resend._domainkey', type: 'TXT', value: 'p=MIGf...', status: 'not_started', ttl: 'Auto' },
        { record: 'SPF', name: 'send', type: 'MX', value: 'feedback-smtp.us-east-1.amazonses.com', priority: 10, status: 'not_started', ttl: 'Auto' },
        { record: 'SPF', name: 'send', type: 'TXT', value: 'v=spf1 include:amazonses.com ~all', status: 'not_started', ttl: 'Auto' },
      ] });
    }
    if (method === 'POST' && /^\/domains\/[^/]+\/verify$/.test(path)) return Response.json({ object: 'domain' });
    if (method === 'GET' && path.startsWith('/domains/')) return Response.json({ id: path.split('/')[2], name: 'x', status: state.dnsOk ? 'verified' : 'pending', records: [{ record: 'DKIM', name: 'resend._domainkey', type: 'TXT', value: 'p=MIGf...', status: state.dnsOk ? 'verified' : 'pending' }] });
    if (method === 'DELETE' && path.startsWith('/domains/')) return Response.json({ deleted: true });
    if (method === 'POST' && path === '/emails') {
      const fail = state.failNext.shift();
      if (fail === 'timeout') throw new Error('timeout');
      if (fail) return new Response('{"message":"nope"}', { status: fail });
      const key = headers.get('idempotency-key')!;
      if (!emails.has(key)) emails.set(key, `msg_${emails.size + 1}`);
      return Response.json({ id: emails.get(key) });
    }
    if (method === 'GET' && path.startsWith('/emails/receiving/')) {
      if (state.failReceived) return new Response('boom', { status: 500 });
      const id = path.split('/')[3]!;
      return state.received[id] ? Response.json(state.received[id]) : new Response('not found', { status: 404 });
    }
    return new Response('unexpected', { status: 500 });
  }));
  return state;
}
const emailPosts = (f: Fake) => f.calls.filter((c) => c.method === 'POST' && c.path === '/emails');

let fake: Fake;
let env: Env;
let queue: { send: ReturnType<typeof vi.fn> };
const NOW = Date.UTC(2026, 10, 18, 12, 0, 0);

async function seedApp(db: D1Database, id: string, creator: string) {
  await db.prepare('INSERT INTO apps (id, creator_id, created_at) VALUES (?, ?, ?)').bind(id, creator, NOW).run();
}
async function seedWorker(db: D1Database, id: string) {
  await db.prepare('INSERT INTO app_workers (app_id, enabled, deployed_at) VALUES (?, 1, ?)').bind(id, NOW).run();
}
async function seedUser(db: D1Database, id: string, email: string, login = id.replace(':', '-')) {
  await db.prepare('INSERT INTO users (id, provider, provider_id, login, email, created_at, last_login_at) VALUES (?, ?, ?, ?, ?, ?, ?)').bind(id, 'github', id, login, email, NOW, NOW).run();
}

/** A verified, approved identity for `app`. */
async function liveIdentity(appId: string, address: string, opts: { external?: boolean } = {}) {
  const domain = address.split('@')[1]!;
  await claimDomain(env, appId, domain, { now: NOW });
  fake.dnsOk = true;
  await verifyDomainClaim(env, appId, domain, NOW);
  const identity = await declareIdentity(env, appId, { address, displayName: 'Careers' }, 'gh:1', NOW);
  return approveIdentity(env, appId, identity.id, { allowExternal: opts.external === true }, 'gh:1', NOW);
}

const msg = (over: Partial<SendAppEmailInput> = {}): SendAppEmailInput => ({
  appId: 'hiring', identity: 'careers@betabuilders.org', to: 'candidate@example.com', subject: 'Interview', text: 'Hello <b>there</b>', idempotencyKey: 'k1', actor: 'system:worker', ...over,
});
const code = async (p: Promise<unknown>) => { try { await p; } catch (e) { if (e instanceof EmailError) return e.code; throw e; } return 'no error'; };

beforeEach(async () => {
  fake = fakeResend();
  queue = { send: vi.fn(async () => undefined) };
  const db = sqliteD1();
  env = makeEnv({ DB: db, RESEND_API_KEY: KEY, RESEND_WEBHOOK_SECRET: WH_SECRET, APP_EVENTS: queue }) as unknown as Env;
  await seedApp(db, 'hiring', 'gh:1');
  await seedApp(db, 'other', 'gh:2');
  await seedWorker(db, 'hiring');
  await seedWorker(db, 'other');
  await seedUser(db, 'gh:1', 'owner@betabuilders.org');
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('slice 1: sender identities', () => {
  it('a claimed domain returns the DNS records to add and is unusable until the provider verifies it', async () => {
    const domain = await claimDomain(env, 'hiring', 'BetaBuilders.org', { now: NOW });
    expect(domain).toMatchObject({ domain: 'betabuilders.org', status: 'pending', receiving: false });
    expect(domain.records.map((r) => `${r.type} ${r.name}`)).toEqual(['TXT resend._domainkey', 'MX send', 'TXT send']);
    const identity = await declareIdentity(env, 'hiring', { address: 'Careers@BetaBuilders.org', displayName: 'Careers' }, 'gh:1', NOW);
    expect(identity).toMatchObject({ address: 'careers@betabuilders.org', status: 'pending', usable: false, domainVerified: false });
    await approveIdentity(env, 'hiring', identity.id, { allowExternal: true }, 'gh:1', NOW);

    expect(await code(sendAppEmail(env, msg(), NOW))).toBe('sender_domain_unverified');
    expect(emailPosts(fake)).toHaveLength(0);

    expect((await verifyDomainClaim(env, 'hiring', 'betabuilders.org', NOW)).status).toBe('pending');
    expect(await code(sendAppEmail(env, msg(), NOW))).toBe('sender_domain_unverified');
    fake.dnsOk = true;
    expect(await verifyDomainClaim(env, 'hiring', 'betabuilders.org', NOW)).toMatchObject({ status: 'verified', verifiedAt: NOW });
    expect((await sendAppEmail(env, msg(), NOW)).status).toBe('accepted');
  });

  it('asks the provider for inbound capability only when the owner wants it', async () => {
    await claimDomain(env, 'hiring', 'mail.betabuilders.org', { receiving: true, now: NOW });
    expect(fake.calls[0]!.body).toMatchObject({ name: 'mail.betabuilders.org', capabilities: { sending: 'enabled', receiving: 'enabled' } });
  });

  it('an identity needs a claimed domain and the owner approval; an approved one can be revoked and approved again', async () => {
    expect(await code(declareIdentity(env, 'hiring', { address: 'careers@betabuilders.org' }, 'gh:1', NOW))).toBe('domain_not_claimed');
    const live = await liveIdentity('hiring', 'careers@betabuilders.org');
    expect(live).toMatchObject({ status: 'approved', usable: true, allowExternal: false });
    expect((await sendAppEmail(env, msg({ to: 'owner@betabuilders.org' }), NOW)).status).toBe('accepted');

    const revoked = await revokeIdentity(env, 'hiring', live.id, 'gh:1', NOW);
    expect(revoked).toMatchObject({ status: 'revoked', usable: false });
    const posts = emailPosts(fake).length;
    expect(await code(sendAppEmail(env, msg({ idempotencyKey: 'k2', to: 'owner@betabuilders.org' }), NOW))).toBe('sender_revoked');
    expect(emailPosts(fake)).toHaveLength(posts);

    await approveIdentity(env, 'hiring', live.id, { allowExternal: false }, 'gh:1', NOW);
    expect((await sendAppEmail(env, msg({ idempotencyKey: 'k3', to: 'owner@betabuilders.org' }), NOW)).status).toBe('accepted');
  });

  it('proof of control: one app per verified domain; an unverified claim is displaced; the platform domain is reserved', async () => {
    await claimDomain(env, 'hiring', 'betabuilders.org', { now: NOW });
    // A second app cannot take the domain by claiming it first and never verifying: it displaces the unverified claim.
    await declareIdentity(env, 'hiring', { address: 'careers@betabuilders.org' }, 'gh:1', NOW);
    await claimDomain(env, 'other', 'betabuilders.org', { now: NOW });
    expect((await emailStatus(env, 'hiring')).domains).toHaveLength(0);
    expect((await emailStatus(env, 'hiring')).identities).toHaveLength(0);
    expect((await emailStatus(env, 'other')).domains[0]!.domain).toBe('betabuilders.org');
    expect(fake.calls.some((c) => c.method === 'DELETE')).toBe(true);

    fake.dnsOk = true;
    await verifyDomainClaim(env, 'other', 'betabuilders.org', NOW);
    expect(await code(claimDomain(env, 'hiring', 'betabuilders.org', { now: NOW }))).toBe('domain_taken');
    expect(await code(claimDomain(env, 'hiring', 'hiring.proappstore.online', { now: NOW }))).toBe('domain_reserved');
    expect(await code(claimDomain(env, 'hiring', 'not a domain', { now: NOW }))).toBe('invalid_request');
  });

  it('app A cannot use or take app B\'s sender', async () => {
    await liveIdentity('hiring', 'careers@betabuilders.org', { external: true });
    expect(await code(sendAppEmail(env, msg({ appId: 'other' }), NOW))).toBe('sender_not_found');
    await claimDomain(env, 'other', 'other.example', { now: NOW });
    expect(await code(declareIdentity(env, 'other', { address: 'careers@betabuilders.org' }, 'gh:2', NOW))).toBe('domain_not_claimed');
    expect(emailPosts(fake)).toHaveLength(0);
  });

  it('administrator kill switch: an app or one identity is refused with zero provider calls', async () => {
    const live = await liveIdentity('hiring', 'careers@betabuilders.org', { external: true });
    await suspendIdentity(env, 'hiring', live.id, true, 'abuse report');
    expect(await code(sendAppEmail(env, msg(), NOW))).toBe('sender_suspended');
    await suspendIdentity(env, 'hiring', live.id, false, null);
    await setAppEmailControls(env, 'hiring', { suspended: true, reason: 'spam' }, 'gh:admin', NOW);
    expect(await code(sendAppEmail(env, msg(), NOW))).toBe('app_suspended');
    expect(emailPosts(fake)).toHaveLength(0);
    await setAppEmailControls(env, 'hiring', { suspended: false }, 'gh:admin', NOW);
    expect((await sendAppEmail(env, msg(), NOW)).status).toBe('accepted');
  });

  it('removing a domain revokes its identities and deletes it at the provider', async () => {
    const live = await liveIdentity('hiring', 'careers@betabuilders.org', { external: true });
    await removeDomain(env, 'hiring', 'betabuilders.org', NOW);
    expect((await emailStatus(env, 'hiring')).domains).toHaveLength(0);
    expect(await code(sendAppEmail(env, msg(), NOW))).toBe('sender_revoked');
    expect(live.id).toBeTruthy();
  });

  it('the owner-readable status carries no secret', async () => {
    await liveIdentity('hiring', 'careers@betabuilders.org');
    const status = await emailStatus(env, 'hiring', NOW);
    expect(status).toMatchObject({ configured: true, suspended: false, limits: { daily: EMAIL_LIMITS.appDaily } });
    const text = JSON.stringify(status);
    expect(text).not.toContain(KEY);
    expect(text).not.toContain('whsec');
    expect(status.identities[0]).toMatchObject({ address: 'careers@betabuilders.org', usable: true });
  });
});

describe('slice 2: trusted send', () => {
  beforeEach(async () => { await liveIdentity('hiring', 'careers@betabuilders.org', { external: true }); });

  it('pins From to the identity, returns the provider id and a server timestamp, and sends text and html separately', async () => {
    const r = await sendAppEmail(env, msg({ replyTo: 'Hiring@Betabuilders.org' }), NOW);
    expect(r).toMatchObject({ status: 'accepted', providerId: 'msg_1', from: 'careers@betabuilders.org', to: ['candidate@example.com'], createdAt: NOW, acceptedAt: NOW, replayed: false });
    const [post] = emailPosts(fake);
    expect(post!.auth).toBe(`Bearer ${KEY}`);
    expect(post!.idem).toBe(`pas-${r.id}`);
    expect(post!.body).toMatchObject({
      from: '"Careers" <careers@betabuilders.org>', to: ['candidate@example.com'], subject: 'Interview', reply_to: 'hiring@betabuilders.org',
      text: 'Hello <b>there</b>', html: '<div>Hello &lt;b&gt;there&lt;/b&gt;</div>',
    });
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
    expect(emailPosts(fake)).toHaveLength(0);
  });

  it('an idempotent retry returns the same record and sends once; a different message under the key conflicts', async () => {
    const first = await sendAppEmail(env, msg(), NOW);
    const again = await sendAppEmail(env, msg(), NOW + 5000);
    expect(again).toMatchObject({ id: first.id, providerId: first.providerId, createdAt: NOW, replayed: true });
    expect(emailPosts(fake)).toHaveLength(1);
    expect(await code(sendAppEmail(env, msg({ subject: 'Different' }), NOW))).toBe('idempotency_conflict');
    expect(emailPosts(fake)).toHaveLength(1);
    // the same key in another app is another record
    expect((await sendAppEmail(env, msg({ idempotencyKey: 'k9' }), NOW)).id).not.toBe(first.id);
  });

  it('a lost provider answer is `unknown`, and a retry under the same key completes without a second message', async () => {
    fake.failNext.push('timeout');
    const unknown = await sendAppEmail(env, msg(), NOW);
    expect(unknown).toMatchObject({ status: 'unknown', providerId: null, errorCode: 'provider_unavailable' });
    const retry = await sendAppEmail(env, msg(), NOW + 1000);
    expect(retry).toMatchObject({ id: unknown.id, status: 'accepted', providerId: 'msg_1', replayed: true });
    expect(emailPosts(fake).map((c) => c.idem)).toEqual([`pas-${unknown.id}`, `pas-${unknown.id}`]);
    expect(fake.sends()).toBe(1);
  });

  it('a provider rejection is `refused` and final for that key', async () => {
    fake.failNext.push(422);
    const refused = await sendAppEmail(env, msg(), NOW);
    expect(refused).toMatchObject({ status: 'refused', providerId: null, errorCode: 'provider_rejected' });
    expect(await sendAppEmail(env, msg(), NOW)).toMatchObject({ id: refused.id, status: 'refused', replayed: true });
    expect(emailPosts(fake)).toHaveLength(1);
  });

  it('enforces the daily, per-identity and burst quotas, atomically, and counts refused sends for none', async () => {
    await setAppEmailControls(env, 'hiring', { dailyLimit: 2, identityDailyLimit: 5, burstLimit: 5 }, 'gh:admin', NOW);
    await sendAppEmail(env, msg({ idempotencyKey: 'a' }), NOW);
    await sendAppEmail(env, msg({ idempotencyKey: 'b' }), NOW);
    expect(await code(sendAppEmail(env, msg({ idempotencyKey: 'c' }), NOW))).toBe('quota_app_daily');
    expect((await sendAppEmail(env, msg({ idempotencyKey: 'a' }), NOW)).replayed).toBe(true); // a replay is not a new send
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

  it('suppressed recipients are refused with zero provider calls', async () => {
    await env.DB.prepare("INSERT INTO email_suppressions (app_id, address, reason, created_at) VALUES ('hiring', 'candidate@example.com', 'bounced', ?)").bind(NOW).run();
    expect(await code(sendAppEmail(env, msg({ to: ['ok@example.com', 'candidate@example.com'] }), NOW))).toBe('recipient_suppressed');
    expect(emailPosts(fake)).toHaveLength(0);
    // suppression is per app: the same address is fine for another app
    await liveIdentity('other', 'jobs@other.example', { external: true });
    expect((await sendAppEmail(env, msg({ appId: 'other', identity: 'jobs@other.example' }), NOW)).status).toBe('accepted');
  });

  it('external recipients need an identity the owner approved for them', async () => {
    const internal = await liveIdentity('other', 'jobs@other.example');
    await seedUser(env.DB, 'gh:2', 'boss@other.example');
    await seedUser(env.DB, 'gh:3', 'editor@other.example', 'editor3');
    await env.DB.prepare("INSERT INTO app_roles (app_id, user_id, role_name) VALUES ('other', 'gh:3', 'editor')").run();
    expect(await code(sendAppEmail(env, msg({ appId: 'other', identity: internal.id, to: 'stranger@example.com' }), NOW))).toBe('external_recipient_not_allowed');
    expect(emailPosts(fake)).toHaveLength(0);
    // the owner and an app-role holder are related; the owner of another app is not
    expect((await sendAppEmail(env, msg({ appId: 'other', identity: internal.id, to: ['boss@other.example', 'EDITOR@other.example'] }), NOW)).status).toBe('accepted');
    expect(await code(sendAppEmail(env, msg({ appId: 'other', identity: internal.id, idempotencyKey: 'k5', to: 'owner@betabuilders.org' }), NOW))).toBe('external_recipient_not_allowed');
    // approving the capability allows anyone
    await approveIdentity(env, 'other', internal.id, { allowExternal: true }, 'gh:2', NOW);
    expect((await sendAppEmail(env, msg({ appId: 'other', identity: internal.id, idempotencyKey: 'k6', to: 'stranger@example.com' }), NOW)).status).toBe('accepted');
  });

  it('is inert without RESEND_API_KEY: a clear refusal and no provider call at all', async () => {
    const bare = { ...env, RESEND_API_KEY: undefined } as Env;
    expect(await code(sendAppEmail(bare, msg(), NOW))).toBe('email_not_configured');
    expect(await code(claimDomain(bare, 'hiring', 'x.example', { now: NOW }))).toBe('email_not_configured');
    const calls = fake.calls.length;
    expect(await code(sendAppEmail(bare, msg(), NOW))).toBe('email_not_configured');
    expect(fake.calls).toHaveLength(calls);
  });

  it('send records are readable by their own app only', async () => {
    const r = await sendAppEmail(env, msg(), NOW);
    expect(await getSend(env, 'hiring', r.id)).toMatchObject({ id: r.id, providerId: 'msg_1', subject: 'Interview', actor: 'system:worker', events: [] });
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
    expect(emailPosts(fake)).toHaveLength(1);
  });

  it('maps refusals to a worker error class with the stable code', async () => {
    const input = { to: 'c@example.com', subject: 'Hi', text: 'x', idempotencyKey: 'w2' };
    expect(await wcode(workerEmailSend(env, 'hiring', { ...input, identity: 'ghost@betabuilders.org' }))).toMatch(/^Forbidden: sender_not_found/);
    await setAppEmailControls(env, 'hiring', { suspended: true }, 'a', NOW);
    expect(await wcode(workerEmailSend(env, 'hiring', { ...input, identity: 'careers@betabuilders.org' }))).toMatch(/^Forbidden: app_suspended/);
    await setAppEmailControls(env, 'hiring', { dailyLimit: 0 }, 'a', NOW);
    expect(await wcode(workerEmailSend(env, 'hiring', { ...input, identity: 'careers@betabuilders.org' }))).toMatch(/^RateLimited: quota_app_daily/);
    expect(await wcode(workerEmailSend({ ...env, RESEND_API_KEY: undefined } as Env, 'hiring', { ...input, identity: 'careers@betabuilders.org' }))).toMatch(/^Unavailable: email_not_configured/);
    expect(await wcode(workerEmailGet(env, 'other', 'nope'))).toMatch(/^NotFound: not_found/);
    expect(await wcode(workerEmailSend(env, 'hiring', null))).toMatch(/^BadRequest/);
  });
});

// ── slice 3 ─────────────────────────────────────────────────────────────────

async function sign(body: string, id = 'evt_1', ts = Math.floor(Date.now() / 1000), secret = WH_SECRET) {
  const key = await crypto.subtle.importKey('raw', Uint8Array.from(atob(secret.replace(/^whsec_/, '')), (c) => c.charCodeAt(0)), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${id}.${ts}.${body}`)));
  return { 'svix-id': id, 'svix-timestamp': String(ts), 'svix-signature': `v1,${btoa(String.fromCharCode(...mac))}` };
}
async function post(event: unknown, over: { id?: string; headers?: Record<string, string>; environment?: Env } = {}) {
  const body = JSON.stringify(event);
  const headers = over.headers ?? await sign(body, over.id ?? 'evt_1');
  return app.request('/v1/email/provider-events', { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body }, over.environment ?? env);
}
const queued = () => queue.send.mock.calls.map((c) => c[0] as { app_id: string; name: string; id: string; payload: { body: string; body_encoding?: string }; ref: { table: string; id: string } });
const queuedEvent = (i: number) => JSON.parse(queued()[i]!.payload.body) as Record<string, unknown>;

describe('slice 3: provider events', () => {
  let sent: { id: string; providerId: string | null };
  beforeEach(async () => {
    await liveIdentity('hiring', 'careers@betabuilders.org', { external: true });
    sent = await sendAppEmail(env, msg({ to: ['candidate@example.com'] }), NOW) as typeof sent;
  });
  const delivered = (over: Record<string, unknown> = {}) => ({ type: 'email.delivered', created_at: '2026-11-18T12:01:00.000Z', data: { email_id: sent.providerId, to: ['candidate@example.com'], ...over } });

  describe('verification', () => {
    it('answers 503 until the webhook secret exists', async () => {
      expect((await post(delivered(), { environment: { ...env, RESEND_WEBHOOK_SECRET: undefined } as Env })).status).toBe(503);
    });
    it('rejects unsigned, forged, wrong-body and stale events and changes nothing', async () => {
      const body = JSON.stringify(delivered());
      const good = await sign(body, 'evt_a');
      expect((await post(delivered(), { headers: {} })).status).toBe(401);
      expect((await post(delivered(), { headers: { ...good, 'svix-signature': 'v1,AAAA' } })).status).toBe(401);
      expect((await post(delivered(), { headers: await sign(body, 'evt_a', Math.floor(Date.now() / 1000), `whsec_${btoa('someone-elses-secret-someone-else!')}`) })).status).toBe(401);
      expect((await post({ ...delivered(), type: 'email.bounced' }, { headers: good })).status).toBe(401); // signed for another body
      expect((await post(delivered(), { headers: await sign(body, 'evt_a', Math.floor(Date.now() / 1000) - 3600) })).status).toBe(401);
      expect((await post(delivered(), { headers: { ...good, 'svix-id': 'evt_b' } })).status).toBe(401); // id is part of the signed content
      expect(queued()).toHaveLength(0);
      expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM email_provider_events').first<{ n: number }>()).toEqual({ n: 0 });
      expect((await getSend(env, 'hiring', sent.id)).deliveredAt).toBeNull();
    });
    it('accepts a signature among several, as the provider rotates secrets', async () => {
      const body = JSON.stringify(delivered());
      const good = await sign(body, 'evt_c');
      expect((await post(delivered(), { headers: { ...good, 'svix-signature': `v1,AAAA ${good['svix-signature']}` } })).status).toBe(200);
    });
  });

  it('delivered: sets delivered_at once, appends an event, and hands the app a hook event', async () => {
    expect((await post(delivered())).status).toBe(200);
    const record = await getSend(env, 'hiring', sent.id);
    expect(record).toMatchObject({ status: 'accepted', deliveredAt: Date.parse('2026-11-18T12:01:00.000Z'), bouncedAt: null });
    expect(record.events).toEqual([{ type: 'email.delivered', at: Date.parse('2026-11-18T12:01:00.000Z'), detail: null }]);
    expect(queued()).toHaveLength(1);
    expect(queued()[0]).toMatchObject({ type: 'hook', name: 'pas.email.delivered', app_id: 'hiring', ref: { table: 'app_hook_deliveries' } });
    expect(queuedEvent(0)).toEqual({
      type: 'pas.email.delivered', id: 'evt_1', sendId: sent.id, providerId: sent.providerId, from: 'careers@betabuilders.org',
      to: ['candidate@example.com'], occurredAt: Date.parse('2026-11-18T12:01:00.000Z'), suppressed: false,
    });
  });

  it('a repeated event applies once: the same provider event id changes nothing and delivers nothing', async () => {
    expect(await (await post(delivered())).json()).toEqual({ ok: true });
    expect(await (await post(delivered())).json()).toEqual({ ok: true, duplicate: true });
    expect(queued()).toHaveLength(1);
    expect((await getSend(env, 'hiring', sent.id)).events).toHaveLength(1);
    // a later, different delivered event does not rewrite the first timestamp
    await post({ ...delivered(), created_at: '2026-11-18T13:00:00.000Z' }, { id: 'evt_2' });
    expect((await getSend(env, 'hiring', sent.id)).deliveredAt).toBe(Date.parse('2026-11-18T12:01:00.000Z'));
  });

  it('a permanent bounce suppresses the recipient and the next send is refused; a transient one does not', async () => {
    const bounced = (type: string) => ({ type: 'email.bounced', created_at: '2026-11-18T12:02:00.000Z', data: { email_id: sent.providerId, to: ['candidate@example.com'], bounce: { type, subType: 'General', message: 'mailbox full' } } });
    await post(bounced('Transient'), { id: 'evt_t' });
    expect(queuedEvent(0)).toMatchObject({ type: 'pas.email.bounced', permanent: false, suppressed: false, bounce: { type: 'Transient', message: 'mailbox full' } });
    expect(await code(sendAppEmail(env, msg({ idempotencyKey: 'again' }), NOW))).toBe('no error');

    await post(bounced('Permanent'), { id: 'evt_p' });
    expect(queuedEvent(1)).toMatchObject({ permanent: true, suppressed: true, to: ['candidate@example.com'] });
    expect(await env.DB.prepare('SELECT address, reason, send_id FROM email_suppressions WHERE app_id = ?').bind('hiring').all()).toMatchObject({ results: [{ address: 'candidate@example.com', reason: 'bounced', send_id: sent.id }] });
    const posts = emailPosts(fake).length;
    expect(await code(sendAppEmail(env, msg({ idempotencyKey: 'after-bounce' }), NOW))).toBe('recipient_suppressed');
    expect(emailPosts(fake)).toHaveLength(posts);
    expect((await getSend(env, 'hiring', sent.id)).bouncedAt).toBe(Date.parse('2026-11-18T12:02:00.000Z'));
  });

  it('a complaint suppresses, and cannot suppress an address the send never went to', async () => {
    await post({ type: 'email.complained', created_at: '2026-11-18T12:03:00.000Z', data: { email_id: sent.providerId, to: ['candidate@example.com', 'victim@example.com'] } }, { id: 'evt_c1' });
    const rows = (await env.DB.prepare('SELECT address, reason FROM email_suppressions').all<{ address: string; reason: string }>()).results;
    expect(rows).toEqual([{ address: 'candidate@example.com', reason: 'complained' }]);
    expect(queuedEvent(0)).toMatchObject({ type: 'pas.email.complained', suppressed: true });
  });

  it('an event is delivered to the app that owns the send and to no other', async () => {
    await liveIdentity('other', 'jobs@other.example', { external: true });
    const theirs = await sendAppEmail(env, msg({ appId: 'other', identity: 'jobs@other.example', idempotencyKey: 'o1' }), NOW);
    await post({ type: 'email.delivered', data: { email_id: theirs.providerId, to: ['candidate@example.com'] } }, { id: 'evt_o' });
    expect(queued().map((q) => q.app_id)).toEqual(['other']);
    expect((await getSend(env, 'hiring', sent.id)).events).toHaveLength(0);
  });

  it('ignores events for mail it did not send, and event types it does not map', async () => {
    expect((await post({ type: 'email.delivered', data: { email_id: 'legacy-message', to: ['x@example.com'] } }, { id: 'evt_x' })).status).toBe(200);
    expect((await post({ type: 'email.sent', data: { email_id: sent.providerId } }, { id: 'evt_y' })).status).toBe(200);
    expect((await post({ type: 'domain.updated', data: {} }, { id: 'evt_z' })).status).toBe(200);
    expect(queued()).toHaveLength(0);
  });

  it('keeps the event and fails the delivery row when the app has no worker, and redelivers it on the provider retry once it has', async () => {
    await env.DB.prepare('UPDATE app_workers SET enabled = 0 WHERE app_id = ?').bind('hiring').run();
    await post(delivered());
    expect(queued()).toHaveLength(0);
    expect(await env.DB.prepare("SELECT status, error FROM app_hook_deliveries WHERE app_id = 'hiring'").first()).toEqual({ status: 'failed', error: 'app worker not deployed' });
    expect((await getSend(env, 'hiring', sent.id)).deliveredAt).not.toBeNull();
  });

  it('a queue failure answers 500 so the provider retries, and the retry delivers exactly once', async () => {
    queue.send.mockRejectedValueOnce(new Error('queue down'));
    expect((await post(delivered())).status).toBe(500);
    expect(queued()).toHaveLength(1); // the failed attempt
    expect((await post(delivered())).status).toBe(200); // same svix id: processing had not completed
    expect(queued()).toHaveLength(2);
    expect(queued()[1]!.id).toBe(queued()[0]!.id); // same envelope id: the app de-duplicates on it
    expect((await post(delivered())).status).toBe(200);
    expect(queued()).toHaveLength(2);
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM email_send_events').first()).toEqual({ n: 1 });
  });
});

describe('slice 3: inbound', () => {
  const received = (over: Record<string, unknown> = {}) => ({
    object: 'email', id: 'in_1', from: 'Dana Candidate <dana@example.com>', to: ['careers@betabuilders.org'], subject: 'Re: Interview', text: 'Thursday works', html: '<p>Thursday works</p>',
    headers: { 'In-Reply-To': '<m1@x>', References: '<m1@x>', 'X-Other': 'dropped' }, message_id: '<r1@example.com>',
    authentication: { spf: 'pass', dkim: 'pass', dmarc: 'fail' },
    attachments: [{ id: 'att_1', filename: 'cv.pdf', content_type: 'application/pdf', size: 1234, content_disposition: 'attachment', content_id: null }], ...over,
  });
  const inbound = (over: Record<string, unknown> = {}) => ({
    type: 'email.received', created_at: '2026-11-18T12:05:00.000Z',
    data: { email_id: 'in_1', created_at: '2026-11-18T12:04:59.000Z', from: 'Dana Candidate <dana@example.com>', to: ['Careers <careers@betabuilders.org>'], cc: [], bcc: [], received_for: [], subject: 'Re: Interview', message_id: '<r1@example.com>', attachments: [], ...over },
  });
  beforeEach(async () => {
    await liveIdentity('hiring', 'careers@betabuilders.org');
    fake.received.in_1 = received();
  });

  it('routes mail for a verified identity to its app as a hook event with the provider\'s authentication results', async () => {
    expect((await post(inbound())).status).toBe(200);
    expect(queued()).toHaveLength(1);
    expect(queued()[0]).toMatchObject({ type: 'hook', name: 'pas.email.inbound', app_id: 'hiring' });
    const id = (await env.DB.prepare("SELECT id FROM email_identities WHERE address = 'careers@betabuilders.org'").first<{ id: string }>())!.id;
    expect(queuedEvent(0)).toEqual({
      type: 'pas.email.inbound', id: `evt_1:${id}`, receivedAt: Date.parse('2026-11-18T12:04:59.000Z'), identity: { id, address: 'careers@betabuilders.org' },
      providerId: 'in_1', messageId: '<r1@example.com>', from: 'Dana Candidate <dana@example.com>', to: ['careers@betabuilders.org'], subject: 'Re: Interview',
      text: 'Thursday works', html: '<p>Thursday works</p>', truncated: false, headers: { 'in-reply-to': '<m1@x>', references: '<m1@x>' },
      authentication: { spf: 'pass', dkim: 'pass', dmarc: 'fail' },
      attachments: [{ id: 'att_1', filename: 'cv.pdf', contentType: 'application/pdf', size: 1234, quarantined: true }],
    });
    expect(await env.DB.prepare('SELECT app_id, from_address, subject FROM email_inbound').first()).toEqual({ app_id: 'hiring', from_address: 'dana@example.com', subject: 'Re: Interview' });
  });

  it('a duplicate delivery from the provider routes once', async () => {
    await post(inbound());
    await post(inbound());
    expect(queued()).toHaveLength(1);
  });

  it('mail for no live identity is acknowledged and goes nowhere; nothing is fetched', async () => {
    await post(inbound({ to: ['nobody@betabuilders.org'] }), { id: 'evt_n' });
    const id = (await env.DB.prepare("SELECT id FROM email_identities WHERE address = 'careers@betabuilders.org'").first<{ id: string }>())!.id;
    await revokeIdentity(env, 'hiring', id, 'gh:1', NOW);
    await post(inbound(), { id: 'evt_r' });
    await approveIdentity(env, 'hiring', id, { allowExternal: false }, 'gh:1', NOW);
    await suspendIdentity(env, 'hiring', id, true, 'x');
    await post(inbound(), { id: 'evt_s' });
    await suspendIdentity(env, 'hiring', id, false, null);
    await setAppEmailControls(env, 'hiring', { suspended: true }, 'a', NOW);
    await post(inbound(), { id: 'evt_a' });
    expect(queued()).toHaveLength(0);
    expect(fake.calls.filter((c) => c.path.startsWith('/emails/receiving'))).toHaveLength(0);
  });

  it('mail for app A\'s address never reaches app B', async () => {
    await liveIdentity('other', 'jobs@other.example');
    await post(inbound({ to: ['jobs@other.example'] }), { id: 'evt_o' });
    expect(queued().map((q) => q.app_id)).toEqual(['other']);
  });

  it('a failed content fetch answers 500 and loses nothing: the provider retry delivers once', async () => {
    fake.failReceived = true;
    expect((await post(inbound())).status).toBe(500);
    expect(queued()).toHaveLength(0);
    fake.failReceived = false;
    expect((await post(inbound())).status).toBe(200);
    expect(queued()).toHaveLength(1);
  });

  it('cuts an oversize body and says so', async () => {
    // Over the queue's message size the body spills to R2 (lib/app-event-queue.ts); the consumer reads it back.
    const r2 = new Map<string, Uint8Array>();
    const environment = { ...env, STORAGE: { put: async (k: string, v: Uint8Array) => { r2.set(k, v); }, delete: async (k: string) => { r2.delete(k); } } } as unknown as Env;
    fake.received.in_1 = received({ text: 'x'.repeat(250_000), html: null });
    expect((await post(inbound(), { environment })).status).toBe(200);
    const key = (queued()[0] as unknown as { body_key: string }).body_key;
    const event = JSON.parse(new TextDecoder().decode(r2.get(key))) as Record<string, unknown>;
    expect(event).toMatchObject({ truncated: true, html: null });
    expect((event.text as string).length).toBe(200_000);
  });

  it('reply threading data survives: in-reply-to and references are delivered, other headers are not', async () => {
    await post(inbound());
    expect(queuedEvent(0).headers).toEqual({ 'in-reply-to': '<m1@x>', references: '<m1@x>' });
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

  it('runs the whole path over HTTP: claim, verify, declare, approve, send, read', async () => {
    expect((await call('/apps/hiring/email', null)).status).toBe(401);
    expect((await call('/apps/hiring/email', stranger)).status).toBe(403);
    const claimed = await call('/apps/hiring/email/domains', owner, 'POST', { domain: 'betabuilders.org' });
    expect(claimed.status).toBe(201);
    expect((await claimed.json() as { records: unknown[] }).records).toHaveLength(3);
    fake.dnsOk = true;
    expect(await (await call('/apps/hiring/email/domains/betabuilders.org/verify', owner, 'POST')).json()).toMatchObject({ status: 'verified' });
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
    expect(result.providerId).toBe('msg_1');
    expect((await call('/apps/hiring/email/send', owner, 'POST', send)).status).toBe(200); // replay
    expect(emailPosts(fake)).toHaveLength(1);
    expect(await (await call(`/apps/hiring/email/sends/${result.id}`, owner)).json()).toMatchObject({ providerId: 'msg_1', events: [] });
    expect((await call(`/apps/hiring/email/sends/${result.id}`, stranger)).status).toBe(403);
    expect(((await (await call('/apps/hiring/email/sends', owner)).json()) as { sends: unknown[] }).sends).toHaveLength(1);
    expect(await (await call('/apps/hiring/email/suppressions', owner)).json()).toEqual({ suppressions: [] });
    expect(await (await call('/apps/hiring/email', owner)).json()).toMatchObject({ identities: [{ address: 'careers@betabuilders.org', usable: true }] });
  });

  it('refuses a From, provider id or timestamp in the request body', async () => {
    await liveIdentity('hiring', 'careers@betabuilders.org', { external: true });
    const res = await call('/apps/hiring/email/send', owner, 'POST', { identity: 'careers@betabuilders.org', to: 'c@example.com', subject: 'Hi', text: 'x', idempotencyKey: 'f1', from: 'ceo@betabuilders.org' });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: 'invalid_request' });
    expect(emailPosts(fake)).toHaveLength(0);
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

  it('answers 503 with a clear message until RESEND_API_KEY exists', async () => {
    env = { ...env, RESEND_API_KEY: undefined } as Env;
    const res = await call('/apps/hiring/email/domains', owner, 'POST', { domain: 'betabuilders.org' });
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ code: 'email_not_configured' });
    expect((await call('/apps/hiring/email', owner)).status).toBe(200);
    expect(await (await call('/apps/hiring/email', owner)).json()).toMatchObject({ configured: false });
    expect(fake.calls).toHaveLength(0);
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
    expect(emailPosts(fake)).toHaveLength(0);
  });
});

describe('applyProviderEvent', () => {
  it('returns false for an event it already applied', async () => {
    expect(await applyProviderEvent(env, 'evt', { type: 'email.sent', data: {} }, NOW)).toBe(true);
    expect(await applyProviderEvent(env, 'evt', { type: 'email.sent', data: {} }, NOW)).toBe(false);
  });
});
