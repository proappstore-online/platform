import { describe, expect, it } from 'vitest';
import { enqueueHookDelivery, hookBodyOf, MAX_MESSAGE_BYTES, type AppEventMessage } from './app-event-queue.js';
import type { HookDelivery } from '../routes/hooks.js';
import type { Env } from '../types.js';

// #257: the hook message and its R2 spill. The consumer's end-to-end behaviour
// (retry, dead-letter, finishing rows) is runtime-tests/test/backend/app-events.test.ts.

function fakeEnv(opts: { failSend?: boolean } = {}) {
  const objects = new Map<string, Uint8Array>();
  const sent: AppEventMessage[] = [];
  const env = {
    STORAGE: {
      put: async (k: string, v: Uint8Array) => { objects.set(k, v); },
      get: async (k: string) => (objects.has(k) ? { arrayBuffer: async () => objects.get(k)!.buffer } : null),
      delete: async (k: string) => { objects.delete(k); },
    },
    APP_EVENTS: { send: async (m: AppEventMessage) => { if (opts.failSend) throw new Error('queue down'); sent.push(m); } },
  } as unknown as Env;
  return { env, objects, sent };
}

const delivery = (body: Uint8Array, over: Partial<HookDelivery> = {}): HookDelivery => ({
  appId: 't', hook: 'ping', target: 'worker', rowId: 'row-1', attempt: 2, body,
  headers: new Headers({ 'content-type': 'application/json', 'x-github-event': 'push', cookie: 'nope' }), ...over,
});

describe('enqueueHookDelivery (#257)', () => {
  it('sends the envelope minus the signature: row id, attempt, allowlisted headers, the body inline', async () => {
    const { env, sent, objects } = fakeEnv();
    await enqueueHookDelivery(env, delivery(new TextEncoder().encode('{"a":1}')));
    expect(sent).toEqual([{
      v: 1, id: 'row-1', app_id: 't', type: 'hook', name: 'ping', attempt: 2, issued_at: expect.any(Number),
      payload: { headers: { 'content-type': 'application/json', 'x-github-event': 'push' }, body: '{"a":1}', body_encoding: 'utf8' },
      ref: { table: 'app_hook_deliveries', id: 'row-1' },
    }]);
    expect(objects.size).toBe(0);
  });

  it('spills a body that does not fit a message to R2, which the message points at, and reads it back intact', async () => {
    const { env, sent, objects } = fakeEnv();
    const body = new Uint8Array(300 * 1024).map((_, i) => i % 251);
    await enqueueHookDelivery(env, delivery(body));
    const [m] = sent;
    expect(m!.body_key).toBe('_hook-bodies/t/row-1');
    expect(new TextEncoder().encode(JSON.stringify(m)).byteLength).toBeLessThan(MAX_MESSAGE_BYTES);
    expect(m!.payload).toEqual({ headers: { 'content-type': 'application/json', 'x-github-event': 'push' } });
    expect(objects.has(m!.body_key!)).toBe(true);
    expect(await hookBodyOf(env, m!)).toEqual(body);
  });

  it('removes the spilled object when the send fails, and rethrows', async () => {
    const { env, objects } = fakeEnv({ failSend: true });
    await expect(enqueueHookDelivery(env, delivery(new Uint8Array(300 * 1024)))).rejects.toThrow('queue down');
    expect(objects.size).toBe(0);
  });

  it('a missing binding is an error, not a silent drop', async () => {
    await expect(enqueueHookDelivery({} as Env, delivery(new Uint8Array(1)))).rejects.toThrow('APP_EVENTS');
  });
});
