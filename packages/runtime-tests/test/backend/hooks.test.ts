import { SELF, env as providedEnv, fetchMock } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../../../backend/src/types';
import { appWorkerHost, disableAppWorker } from '../../../backend/src/lib/app-worker-host';
import { sealSecret } from '../../../backend/src/lib/encryption';
import { HOOK_TIMEOUT_MS, SYSTEM_HOOK_USER } from '../../../backend/src/routes/hooks';
import { BASE, captureAppEvents, drainAppEvents, json, mockNetwork, resetTables, seedApp, seedUser, session } from './helpers';

const env = providedEnv as unknown as Env;

// #256 on real D1, R2 and the Worker Loader: inbound webhooks verified on the raw
// bytes, de-duplicated by delivery id, put on the app-events queue (#257) and delivered
// to the app worker through the shim by the real consumer — retried with backoff,
// dead-lettered, spilled to R2 when too big for a message — or run as a hook action as
// system:hook, and never carrying a signature header or a retained body. The queue is
// recorded and drained by hand (helpers.captureAppEvents / drainAppEvents).

const GH_SECRET = 'gh-hook-secret';
const BIN_SECRET = 'bin-hook-secret';
const STRIPE_SECRET = 'whsec_stripe';
const enc = new TextEncoder();

// "flaky" fails its first two attempts; "dead" its first six (all of one delivery's tries); "echo" reports what
// arrived (via a 500, whose first 1 KB is recorded); "big:<length>:<sum>" fails unless the body arrived intact.
const APP = `export default { async fetch(req) {
  const e = await req.json();
  const p = e.payload;
  const event = p.headers['x-github-event'] || '';
  if (event === 'flaky' && e.attempt < 3) return new Response('flaky', { status: 500 });
  if (event === 'dead' && e.attempt < 7) return new Response('dead', { status: 500 });
  if (event.startsWith('big:')) {
    const bytes = Uint8Array.from(atob(p.body), (c) => c.charCodeAt(0));
    const [, len, sum] = event.split(':');
    const actual = bytes.reduce((a, b) => (a + b) % 65521, 0);
    return bytes.length === Number(len) && actual === Number(sum) ? Response.json({ ok: true }) : new Response('mangled', { status: 500 });
  }
  if (p.headers['x-github-event'] === 'echo' || p.headers['content-type'] === 'application/octet-stream') {
    return new Response(JSON.stringify({ headers: Object.keys(p.headers).sort(), body: p.body, enc: p.body_encoding }), { status: 500 });
  }
  return Response.json({ ok: true });
} };`;

const tool = {
  name: 'record_ping', description: 'Record a ping', operation: 'execute', requires_auth: true,
  sql: 'INSERT INTO pings (source, by) VALUES (:source, :__user_id)', params: { source: { type: 'string' } },
  auth: { caller_unscoped: { reason: 'any verified sender' } }, callers: ['hook'],
};
const hooks = [
  { name: 'github', verify: { kind: 'github-hmac-sha256', secret: 'GITHUB_WEBHOOK_SECRET' }, to: 'worker' },
  { name: 'bin', verify: { kind: 'hmac-sha256', secret: 'BIN_SECRET', id_header: 'X-Delivery' }, to: 'worker' },
  { name: 'stripe', verify: { kind: 'stripe', secret: 'STRIPE_SECRET' }, to: 'worker' },
  { name: 'app', verify: { kind: 'github-app' }, to: 'worker' },
  { name: 'ping', verify: { kind: 'secret-token', secret: 'PING_TOKEN' }, to: { action: 'record_ping', params: { source: '$.source' } } },
];

async function hmacHex(secret: string, data: Uint8Array | string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return [...new Uint8Array(await crypto.subtle.sign('HMAC', key, typeof data === 'string' ? enc.encode(data) : data))].map((b) => b.toString(16).padStart(2, '0')).join('');
}
async function github(event: string, delivery: string, body = '{"zen":"ok"}', secret = GH_SECRET) {
  return SELF.fetch(`${BASE}/v1/apps/t/hooks/github`, {
    method: 'POST', body,
    headers: { 'content-type': 'application/json', 'x-github-event': event, 'x-github-delivery': delivery, 'x-hub-signature-256': `sha256=${await hmacHex(secret, body)}`, 'user-agent': 'GitHub-Hookshot/1' },
  });
}
// By the sender's delivery id (#317: the row's delivery_id is now its replay key, the sender's id sits beside it).
const delivery = (deliveryId: string) => env.DB.prepare('SELECT id, status, attempts, error, event FROM app_hook_deliveries WHERE COALESCE(sender_delivery_id, delivery_id) = ?').bind(deliveryId).first<{ id: string; status: string; attempts: number; error: string | null; event: string | null }>();
let sent: ReturnType<typeof captureAppEvents>;
/** Run what the 202 queued through the consumer, then read the row. */
async function settled(deliveryId: string) {
  await drainAppEvents(sent);
  const row = await delivery(deliveryId);
  if (!row || row.status === 'received') throw new Error(`delivery ${deliveryId} never finished`);
  return row;
}
const invocations = (rowId: string) => env.DB.prepare('SELECT id, status, body_excerpt FROM app_worker_invocations WHERE event_id = ? ORDER BY id').bind(rowId).all<{ id: string; status: string; body_excerpt: string | null }>().then((r) => r.results ?? []);

beforeEach(async () => {
  sent = captureAppEvents();
  mockNetwork();
  for (const r of (await env.DB.prepare('SELECT app_id FROM app_workers').all<{ app_id: string }>()).results ?? []) await disableAppWorker(env, r.app_id);
  await resetTables();
  for (const t of ['app_hooks', 'app_hook_deliveries', 'app_secrets', 'app_worker_invocations', 'app_log_usage']) await env.DB.prepare(`DELETE FROM ${t}`).run();
  await seedUser('gh:admin', 'admin');
  await seedUser('gh:7', 'other');
  await seedApp('t', 'gh:admin');
  for (const [name, value] of [['GITHUB_WEBHOOK_SECRET', GH_SECRET], ['BIN_SECRET', BIN_SECRET], ['STRIPE_SECRET', STRIPE_SECRET], ['PING_TOKEN', 'ping-token']]) {
    const s = await sealSecret(value!, env.APP_SECRET_KEK!);
    await env.DB.prepare('INSERT INTO app_secrets (app_id, name, key_ciphertext, dek_wrapped, iv, created_at) VALUES (?, ?, ?, ?, ?, ?)').bind('t', name, s.keyCiphertext, s.dekWrapped, s.iv, Date.now()).run();
  }
  const enabled = await SELF.fetch(`${BASE}/v1/admin/apps/t/worker-enabled`, json('PUT', { enabled: true }, await session('gh:admin', { roles: ['user', 'admin'] })));
  expect(enabled.status).toBe(200);
  await appWorkerHost(env).deploy('t', { modules: { 'app.js': APP } });
  fetchMock.get(`https://pas-data-t.${env.DATA_WORKER_HOST}`).intercept({ path: '/validate', method: 'POST' })
    .reply(200, (req) => ({ results: (JSON.parse(String(req.body)) as { statements: { id: string }[] }).statements.map((s) => ({ id: s.id, ok: true })) }));
  const put = await SELF.fetch(`${BASE}/v1/apps/t/tools`, json('PUT', { tools: [tool], hooks }, await session('gh:admin')));
  expect(put.status, await put.clone().text()).toBe(200);
});
afterEach(() => {
  vi.restoreAllMocks();
  fetchMock.assertNoPendingInterceptors();
});

describe('inbound webhooks to the app worker (#256)', () => {
  it('a signed GitHub delivery is 202 and delivered; the same delivery again is 200 duplicate and runs once', async () => {
    const res = await github('ping', 'd1');
    expect(res.status).toBe(202);
    const row = await settled('d1');
    expect(row).toMatchObject({ status: 'delivered', attempts: 1, event: 'ping' });
    const again = await github('ping', 'd1');
    expect(again.status).toBe(200);
    expect(await again.json()).toEqual({ duplicate: true });
    expect(await invocations(row.id)).toEqual([expect.objectContaining({ id: `${row.id}:1`, status: 'succeeded' })]);
  });

  it('a worker that fails twice then answers: one 202, delivered on the third try, attempts 3, one invocation record per try', async () => {
    expect((await github('flaky', 'd2')).status).toBe(202);
    expect(await delivery('d2')).toMatchObject({ status: 'received', attempts: 1 });
    const [done] = await drainAppEvents(sent);
    expect(done).toMatchObject({ tries: 3, deadLettered: false });
    const row = (await delivery('d2'))!;
    expect(row).toMatchObject({ status: 'delivered', attempts: 3, error: null });
    expect((await invocations(row.id)).map((i) => [i.id, i.status])).toEqual([[`${row.id}:1`, 'failed'], [`${row.id}:2`, 'failed'], [`${row.id}:3`, 'succeeded']]);
  });

  it('a worker that always fails is dead-lettered after 5 retries; the sender\'s redelivery runs again as attempt 7', async () => {
    expect((await github('dead', 'd4')).status).toBe(202);
    const [done] = await drainAppEvents(sent);
    expect(done).toMatchObject({ tries: 6, deadLettered: true });
    const failed = (await delivery('d4'))!;
    expect(failed).toMatchObject({ status: 'failed', attempts: 6 });
    expect(failed.error).toBe('dead-lettered after 6 attempts: worker answered 500');
    expect((await github('dead', 'd4')).status).toBe(202);
    const retried = await settled('d4');
    expect(retried).toMatchObject({ id: failed.id, status: 'delivered', attempts: 7 });
    expect((await invocations(failed.id)).map((i) => i.id)).toEqual([1, 2, 3, 4, 5, 6, 7].map((n) => `${failed.id}:${n}`));
  });

  it('a 300 KB body is spilled to R2 for delivery only: it arrives intact and the object is gone after the ack', async () => {
    const bytes = new Uint8Array(300 * 1024).map((_, i) => (i * 7) % 256);
    const sum = bytes.reduce((a, b) => (a + b) % 65521, 0);
    const res = await SELF.fetch(`${BASE}/v1/apps/t/hooks/bin`, {
      method: 'POST', body: bytes,
      headers: { 'content-type': 'application/octet-stream', 'x-signature': await hmacHex(BIN_SECRET, bytes), 'x-delivery': 'big-1', 'x-github-event': `big:${bytes.length}:${sum}` },
    });
    expect(res.status).toBe(202);
    const key = `_hook-bodies/t/${(await delivery('big-1'))!.id}`;
    expect(sent[0]!.body_key).toBe(key);
    expect(await env.STORAGE.head(key)).not.toBeNull();
    expect(await settled('big-1')).toMatchObject({ status: 'delivered' });
    expect(await env.STORAGE.head(key)).toBeNull();
  });

  it('a spilled body is also deleted when its delivery is dead-lettered', async () => {
    const bytes = new Uint8Array(300 * 1024);
    const res = await SELF.fetch(`${BASE}/v1/apps/t/hooks/bin`, {
      method: 'POST', body: bytes,
      headers: { 'content-type': 'application/octet-stream', 'x-signature': await hmacHex(BIN_SECRET, bytes), 'x-delivery': 'big-2', 'x-github-event': 'big:1:1' },
    });
    expect(res.status).toBe(202);
    const key = sent[0]!.body_key!;
    expect(await settled('big-2')).toMatchObject({ status: 'failed' });
    expect(await env.STORAGE.head(key)).toBeNull();
  });

  it('a hook handler that takes 40 s is no longer cut at the old 25 s waitUntil budget', () => {
    expect(HOOK_TIMEOUT_MS).toBeGreaterThanOrEqual(60_000);
  });

  it('the worker never sees a signature header; a binary body arrives byte-identical as base64', async () => {
    expect((await github('echo', 'd3')).status).toBe(202);
    const echoed = await settled('d3');
    const seen = JSON.parse((await invocations(echoed.id))[0]!.body_excerpt!) as { headers: string[]; enc: string };
    expect(seen.headers).toEqual(['content-type', 'user-agent', 'x-github-delivery', 'x-github-event']);
    expect(seen.enc).toBe('utf8');

    const bytes = new Uint8Array([0xff, 0x00, 0x7f, 0x80, 0xfe]);
    const res = await SELF.fetch(`${BASE}/v1/apps/t/hooks/bin`, {
      method: 'POST', body: bytes, headers: { 'content-type': 'application/octet-stream', 'x-signature': await hmacHex(BIN_SECRET, bytes), 'x-delivery': 'b1' },
    });
    expect(res.status).toBe(202);
    const bin = await settled('b1');
    const got = JSON.parse((await invocations(bin.id))[0]!.body_excerpt!) as { headers: string[]; body: string; enc: string };
    expect(got.enc).toBe('base64');
    expect([...Uint8Array.from(atob(got.body), (c) => c.charCodeAt(0))]).toEqual([...bytes]);
    expect(got.headers).toEqual(['content-type']);
  });
});

describe('refusals, before any row or app code (#256)', () => {
  it('wrong signature 401, unknown hook 404, github-app hook 404, 6 MB 413, stale Stripe signature 401', async () => {
    expect((await github('ping', 'bad', '{"zen":"ok"}', 'not-the-secret')).status).toBe(401);
    expect((await SELF.fetch(`${BASE}/v1/apps/t/hooks/nope`, { method: 'POST', body: '{}' })).status).toBe(404);
    expect((await SELF.fetch(`${BASE}/v1/apps/missing-app/hooks/github`, { method: 'POST', body: '{}' })).status).toBe(404);
    expect((await SELF.fetch(`${BASE}/v1/apps/t/hooks/app`, { method: 'POST', body: '{}' })).status).toBe(404);
    expect((await SELF.fetch(`${BASE}/v1/apps/t/hooks/github`, { method: 'POST', body: new Uint8Array(6 * 1024 * 1024) })).status).toBe(413);
    const body = '{"id":"evt_old","type":"charge.succeeded"}';
    const t = Math.floor(Date.now() / 1000) - 301;
    const stale = await SELF.fetch(`${BASE}/v1/apps/t/hooks/stripe`, { method: 'POST', body, headers: { 'stripe-signature': `t=${t},v1=${await hmacHex(STRIPE_SECRET, `${t}.${body}`)}` } });
    expect(stale.status).toBe(401);
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM app_hook_deliveries').first<{ n: number }>()).toEqual({ n: 0 });
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM app_worker_invocations').first<{ n: number }>()).toEqual({ n: 0 });
  });
});

describe('a hook mapped to an action (#256)', () => {
  it('runs the write as system:hook with params from the body', async () => {
    const seen: unknown[] = [];
    fetchMock.get(`https://pas-data-t.${env.DATA_WORKER_HOST}`).intercept({ path: '/execute', method: 'POST' })
      .reply(200, (req) => { seen.push(JSON.parse(String(req.body))); return { meta: { changes: 1 } }; });
    const res = await SELF.fetch(`${BASE}/v1/apps/t/hooks/ping`, { method: 'POST', body: '{"source":"uptime-robot"}', headers: { 'content-type': 'application/json', 'x-pas-hook-token': 'ping-token' } });
    expect(res.status).toBe(202);
    const id = (await env.DB.prepare("SELECT delivery_id FROM app_hook_deliveries WHERE hook = 'ping'").first<{ delivery_id: string }>())!.delivery_id;
    expect(await settled(id)).toMatchObject({ status: 'delivered' });
    expect(seen).toEqual([{ sql: 'INSERT INTO pings (source, by) VALUES (?, ?)', params: ['uptime-robot', SYSTEM_HOOK_USER] }]);
  });

  it('a hook-only action is refused over HTTP to a signed-in user', async () => {
    const res = await SELF.fetch(`${BASE}/v1/apps/t/actions/record_ping`, json('POST', { params: { source: 'x' } }, await session('gh:admin')));
    expect(res.status).toBe(403);
  });
});

describe('owner hook list (#261)', () => {
  it('lists each hook with its public URL, verifier and whether its secret is set — never a value', async () => {
    await env.DB.prepare("DELETE FROM app_secrets WHERE name = 'PING_TOKEN'").run();
    const res = await SELF.fetch(`${BASE}/v1/apps/t/hooks`, json('GET', undefined, await session('gh:admin')));
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('private, no-store');
    const text = await res.text();
    for (const value of [GH_SECRET, BIN_SECRET, STRIPE_SECRET]) expect(text).not.toContain(value);
    const { hooks: listed } = JSON.parse(text) as { hooks: Record<string, unknown>[] };
    expect(listed.map((h) => h.name)).toEqual(['app', 'bin', 'github', 'ping', 'stripe']);
    expect(listed.find((h) => h.name === 'github')).toEqual({
      name: 'github', url: `${BASE}/v1/apps/t/hooks/github`, verify_kind: 'github-hmac-sha256', secret_name: 'GITHUB_WEBHOOK_SECRET', secret_set: true, to: 'worker',
    });
    expect(listed.find((h) => h.name === 'ping')).toMatchObject({ secret_set: false, to: { action: 'record_ping', params: { source: '$.source' } } });
    expect(listed.find((h) => h.name === 'app')).toMatchObject({ url: null, secret_name: null, secret_set: null });
    expect((await SELF.fetch(`${BASE}/v1/apps/t/hooks`, json('GET', undefined, await session('gh:7')))).status).toBe(403);
  });
});

describe('owner delivery log (#256)', () => {
  it('lists deliveries to the owner without bodies; refuses anyone else', async () => {
    await github('ping', 'log-1');
    await settled('log-1');
    const res = await SELF.fetch(`${BASE}/v1/apps/t/hook-deliveries?hook=github`, json('GET', undefined, await session('gh:admin')));
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('private, no-store');
    const { deliveries } = await res.json() as { deliveries: Record<string, unknown>[] };
    expect(deliveries).toEqual([expect.objectContaining({ hook: 'github', delivery_id: 'log-1', status: 'delivered' })]);
    expect(Object.keys(deliveries[0]!)).not.toContain('body');
    expect((await SELF.fetch(`${BASE}/v1/apps/t/hook-deliveries`, json('GET', undefined, await session('gh:7')))).status).toBe(403);
  });
});

describe('replay protection keys on signed bytes, not delivery-id headers (#317)', () => {
  const rows = () => env.DB.prepare("SELECT delivery_id, sender_delivery_id, status FROM app_hook_deliveries WHERE app_id = 't' ORDER BY received_at, id").all<{ delivery_id: string; sender_delivery_id: string | null; status: string }>().then((r) => r.results ?? []);
  const workerRuns = () => env.DB.prepare("SELECT COUNT(*) AS n FROM app_worker_invocations WHERE app_id = 't'").first<{ n: number }>().then((r) => r!.n);

  it('a captured GitHub delivery replayed under a new X-GitHub-Delivery is a duplicate and runs once', async () => {
    const body = '{"action":"opened","issue":{"number":7}}';
    expect((await github('issues', 'gh-1', body)).status).toBe(202);
    expect(await settled('gh-1')).toMatchObject({ status: 'delivered', attempts: 1 });
    for (const forged of ['gh-2', 'gh-3', crypto.randomUUID()]) {
      const replay = await github('issues', forged, body);
      expect(replay.status).toBe(200);
      expect(await replay.json()).toEqual({ duplicate: true });
    }
    await drainAppEvents(sent);
    expect(await workerRuns()).toBe(1);
    expect(await rows()).toEqual([{ delivery_id: expect.stringMatching(/^[0-9a-f]{64}$/), sender_delivery_id: 'gh-1', status: 'delivered' }]);
    // A changed X-GitHub-Event is no way round it either: same signed body, same row.
    expect(await (await github('push', 'gh-4', body)).json()).toEqual({ duplicate: true });
  });

  it('distinct signed bodies run separately, even under the same delivery id', async () => {
    expect((await github('issues', 'same-id', '{"n":1}')).status).toBe(202);
    expect((await github('issues', 'same-id', '{"n":2}')).status).toBe(202);
    await drainAppEvents(sent);
    expect(await workerRuns()).toBe(2);
    expect((await rows()).map((r) => [r.sender_delivery_id, r.status])).toEqual([['same-id', 'delivered'], ['same-id', 'delivered']]);
  });

  it('hmac-sha256 with id_header: a replay under a fresh X-Delivery is a duplicate', async () => {
    const bytes = enc.encode('{"order":42}');
    const send = (id: string) => SELF.fetch(`${BASE}/v1/apps/t/hooks/bin`, {
      method: 'POST', body: bytes, headers: { 'content-type': 'application/json', 'x-signature': '', 'x-delivery': id },
    });
    const sig = await hmacHex(BIN_SECRET, bytes);
    const signed = (id: string) => SELF.fetch(`${BASE}/v1/apps/t/hooks/bin`, {
      method: 'POST', body: bytes, headers: { 'content-type': 'application/json', 'x-signature': sig, 'x-delivery': id },
    });
    expect((await send('unsigned')).status).toBe(401);
    expect((await signed('b-1')).status).toBe(202);
    expect(await (await signed('b-2')).json()).toEqual({ duplicate: true });
    await drainAppEvents(sent);
    expect(await workerRuns()).toBe(1);
  });

  it("Stripe is unchanged: its retry (same event, a new signature timestamp) is a duplicate; another event id is new", async () => {
    const stripe = async (id: string, t = Math.floor(Date.now() / 1000)) => {
      const body = JSON.stringify({ id, type: 'invoice.paid' });
      return SELF.fetch(`${BASE}/v1/apps/t/hooks/stripe`, { method: 'POST', body, headers: { 'stripe-signature': `t=${t},v1=${await hmacHex(STRIPE_SECRET, `${t}.${body}`)}` } });
    };
    expect((await stripe('evt_A')).status).toBe(202);
    expect(await (await stripe('evt_A', Math.floor(Date.now() / 1000) - 30)).json()).toEqual({ duplicate: true });
    expect((await stripe('evt_B')).status).toBe(202);
    await drainAppEvents(sent);
    expect(await workerRuns()).toBe(2);
    expect((await rows()).map((r) => [r.delivery_id, r.sender_delivery_id])).toEqual([['evt_A', 'evt_A'], ['evt_B', 'evt_B']]);
  });

  it("the owner's log shows the sender's delivery id, with the replay key beside it", async () => {
    await github('ping', 'shown-1', '{"zen":"shown"}');
    await settled('shown-1');
    const { deliveries } = await (await SELF.fetch(`${BASE}/v1/apps/t/hook-deliveries?hook=github`, json('GET', undefined, await session('gh:admin')))).json() as { deliveries: Record<string, unknown>[] };
    expect(deliveries).toEqual([expect.objectContaining({ delivery_id: 'shown-1', replay_key: expect.stringMatching(/^[0-9a-f]{64}$/), status: 'delivered' })]);
  });
});
