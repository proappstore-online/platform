import { describe, expect, it, vi } from 'vitest';
import { defineAppWorker, hookBody, pasClient, type AppWorkerEnv } from './worker.js';

// #254: defineAppWorker dispatches the platform's envelope and binds every PAS
// call to the worker token and the invocation id `<event id>:<attempt>`.

function envWithPas() {
  const pas = {
    actions: { call: vi.fn(async () => ({ meta: { changes: 1 } })), batch: vi.fn(async () => []) },
    secrets: { get: vi.fn(async () => 'v') },
    storage: { put: vi.fn(async () => ({ key: 'k', size: 1 })), get: vi.fn(async () => null) },
    log: vi.fn(async () => true),
  };
  return { pas, env: { PAS: pas, PAS_WORKER_TOKEN: 'tok', APP_ID: 'demo' } as unknown as AppWorkerEnv };
}
const envelope = (type: string, extra: Record<string, unknown> = {}) =>
  new Request('https://w/', { method: 'POST', body: JSON.stringify({ v: 1, id: 'e9', app_id: 'demo', type, name: 'sync', attempt: 2, issued_at: 5, payload: { a: 1 }, ...extra }) });

describe('defineAppWorker (#254)', () => {
  it('runs scheduled for a schedule event with the event and a bound client', async () => {
    const { env, pas } = envWithPas();
    const scheduled = vi.fn(async (_e, p) => { await p.actions.call('upsert', { id: 1 }); });
    const res = await defineAppWorker({ scheduled }).fetch(envelope('schedule'), env, {});
    expect(res.status).toBe(200);
    expect(scheduled.mock.calls[0]![0]).toEqual({ id: 'e9', type: 'schedule', name: 'sync', attempt: 2, issuedAt: 5, payload: { a: 1 } });
    expect(pas.actions.call).toHaveBeenCalledWith('upsert', { id: 1 }, { token: 'tok', invocation: 'e9:2' });
  });

  it('runs webhook for a hook event; answers 501 without a handler and 400 for a bad body', async () => {
    const { env } = envWithPas();
    const webhook = vi.fn();
    expect((await defineAppWorker({ webhook }).fetch(envelope('hook'), env, {})).status).toBe(200);
    expect(webhook).toHaveBeenCalledTimes(1);
    expect((await defineAppWorker({ webhook }).fetch(envelope('schedule'), env, {})).status).toBe(501);
    // http events (#260) without a fetch handler are a missing route.
    expect((await defineAppWorker({}).fetch(envelope('http'), env, {})).status).toBe(404);
    expect((await defineAppWorker({ webhook }).fetch(new Request('https://w/', { method: 'POST', body: '{' }), env, {})).status).toBe(400);
  });

  it('a throwing handler is a 500 carrying its message', async () => {
    const { env } = envWithPas();
    const res = await defineAppWorker({ scheduled: () => { throw new Error('upstream 502'); } }).fetch(envelope('schedule'), env, {});
    expect(res.status).toBe(500);
    expect(await res.text()).toBe('upstream 502');
  });
});

describe('pasClient', () => {
  it('passes the token and invocation on every namespace', async () => {
    const { env, pas } = envWithPas();
    const p = pasClient(env, { id: 'e1', attempt: 1 });
    const ctx = { token: 'tok', invocation: 'e1:1' };
    await p.actions.batch([{ name: 'a' }]);
    await p.secrets.get('S');
    await p.storage.put('k', 'v');
    await p.storage.get('k');
    await p.log('info', 'hi', { n: 1 });
    expect(pas.actions.batch).toHaveBeenCalledWith([{ name: 'a' }], ctx);
    expect(pas.secrets.get).toHaveBeenCalledWith('S', ctx);
    expect(pas.storage.put).toHaveBeenCalledWith('k', 'v', {}, ctx);
    expect(pas.storage.get).toHaveBeenCalledWith('k', ctx);
    expect(pas.log).toHaveBeenCalledWith('info', 'hi', { n: 1 }, ctx);
  });

  it('refuses to run without a PAS binding', () => {
    expect(() => pasClient({}, { id: 'e', attempt: 1 })).toThrow(/no PAS binding/);
  });
});

describe('hook events (#256)', () => {
  it('hand the handler the exact body bytes and the allowlisted headers', async () => {
    const { env } = envWithPas();
    const webhook = vi.fn();
    const req = new Request('https://w/', { method: 'POST', body: JSON.stringify({
      v: 1, id: 'h1', type: 'hook', name: 'github', attempt: 1, issued_at: 1,
      payload: { headers: { 'x-github-event': 'push' }, body: '/wAQ', body_encoding: 'base64' },
    }) });
    expect((await defineAppWorker({ webhook }).fetch(req, env, {})).status).toBe(200);
    const event = webhook.mock.calls[0]![0];
    expect(event.hook.headers).toEqual({ 'x-github-event': 'push' });
    expect([...event.hook.body]).toEqual([0xff, 0x00, 0x10]);
  });

  it('hookBody decodes utf8 and base64', () => {
    expect(new TextDecoder().decode(hookBody({ body: '{"a":1}', body_encoding: 'utf8' }))).toBe('{"a":1}');
    expect([...hookBody({ body: '/wAQ', body_encoding: 'base64' })]).toEqual([0xff, 0x00, 0x10]);
    expect(hookBody({})).toEqual(new Uint8Array());
  });
});

describe('http events (#260)', () => {
  const httpEnvelope = (payload: Record<string, unknown>, caller: unknown = { grant_id: 'g', user_id: 'gh:42', roles: ['user'], exp: 9, sig: 's' }) =>
    new Request('https://w/', { method: 'POST', body: JSON.stringify({ v: 1, id: 'r1', type: 'http', attempt: 1, issued_at: 1, caller, payload }) });

  it('rebuild a standard Request (method, path, query, headers, exact body) and run actions as the caller', async () => {
    const { env, pas } = envWithPas();
    let seen: { method: string; url: string; type: string | null; bytes: number[] } | null = null;
    const res = await defineAppWorker({
      async fetch(request, p) {
        seen = { method: request.method, url: request.url, type: request.headers.get('content-type'), bytes: [...new Uint8Array(await request.arrayBuffer())] };
        await p.actions.call('my_rows');
        await p.log('info', 'hi');
        return Response.json({ ok: true }, { status: 201 });
      },
    }).fetch(httpEnvelope({ method: 'POST', path: '/v1/rows', query: 'a=1', headers: { 'content-type': 'application/octet-stream' }, body: '/wAQ', body_encoding: 'base64' }), env, {});
    expect(res.status).toBe(201);
    expect(seen).toEqual({ method: 'POST', url: 'https://demo.proappstore.online/v1/rows?a=1', type: 'application/octet-stream', bytes: [0xff, 0x00, 0x10] });
    const caller = { grant_id: 'g', user_id: 'gh:42', roles: ['user'], exp: 9, sig: 's' };
    expect(pas.actions.call).toHaveBeenCalledWith('my_rows', {}, { token: 'tok', invocation: 'r1:1', as: caller });
    // Only actions carry the grant.
    expect(pas.log).toHaveBeenCalledWith('info', 'hi', undefined, { token: 'tok', invocation: 'r1:1' });
  });

  it('answers 404 when the worker has no fetch handler; a GET carries no body', async () => {
    const { env } = envWithPas();
    expect((await defineAppWorker({}).fetch(httpEnvelope({ method: 'GET', path: '/' }), env, {})).status).toBe(404);
    const res = await defineAppWorker({ fetch: (r) => new Response(r.method) }).fetch(httpEnvelope({ method: 'GET', path: '/x', body: 'ignored', body_encoding: 'utf8' }), env, {});
    expect(await res.text()).toBe('GET');
  });
});
