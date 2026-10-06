import { describe, expect, it, vi } from 'vitest';
import { defineAppWorker, pasClient, type AppWorkerEnv } from './worker.js';

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
    expect((await defineAppWorker({}).fetch(envelope('http'), env, {})).status).toBe(501);
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
