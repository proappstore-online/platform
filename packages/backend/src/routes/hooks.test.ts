import { afterEach, describe, expect, it, vi } from 'vitest';
import { deliverHook, HOOK_TIMEOUT_MS, mapHookParams, resolveHookPath, SYSTEM_HOOK_USER, type HookDelivery } from './hooks.js';
import * as host from '../lib/app-worker-host.js';
import type { Env } from '../types.js';

// #256: param mapping by path and the two delivery targets. The full route —
// verification, de-dupe, redelivery, 202 + waitUntil — runs on real D1 and the
// Worker Loader in runtime-tests/test/backend/hooks.test.ts.

const body = { source: 'ci', repo: { name: 'pas', topics: ['a', 'b'] }, n: 0 };

describe('hook param paths', () => {
  it('resolves $, keys and indexes; undefined where the path does not lead', () => {
    expect(resolveHookPath(body, '$')).toBe(body);
    expect(resolveHookPath(body, '$.repo.name')).toBe('pas');
    expect(resolveHookPath(body, '$.repo.topics[1]')).toBe('b');
    expect(resolveHookPath(body, '$.n')).toBe(0);
    expect(resolveHookPath(body, '$.repo.missing.deep')).toBeUndefined();
    expect(resolveHookPath(body, '$.source.length')).toBeUndefined();
  });
  it('maps paths and keeps literals; an unresolvable path is left out', () => {
    expect(mapHookParams({ source: '$.source', topic: '$.repo.topics[0]', kind: 'push', count: 3, gone: '$.nope' }, body))
      .toEqual({ source: 'ci', topic: 'a', kind: 'push', count: 3 });
  });
});

const delivery = (over: Partial<HookDelivery> = {}): HookDelivery => ({
  appId: 't', hook: 'ping', target: { action: 'record_ping', params: { source: '$.source' } }, rowId: 'row-1', attempt: 1,
  body: new TextEncoder().encode(JSON.stringify(body)), headers: new Headers({ 'content-type': 'application/json', 'x-pas-hook-token': 'secret' }), ...over,
});
function envWithManifest(manifest: Record<string, unknown> | null): Env {
  return {
    DB: { prepare: () => ({ bind: () => ({ first: async () => (manifest ? { manifest: JSON.stringify(manifest) } : null) }) }) },
    DATA_WORKER_HOST: 'test.workers.dev', INTERNAL_TOKEN: 'internal',
  } as unknown as Env;
}
const hookAction = { name: 'record_ping', operation: 'execute', requires_auth: true, sql: 'INSERT INTO pings (source, by) VALUES (:source, :__user_id)', params: { source: { type: 'string' } }, auth: { caller_unscoped: { reason: 'x' } }, callers: ['hook'] };

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('deliverHook → action (#256)', () => {
  it('runs the mapped write as system:hook on the data worker', async () => {
    const sent: unknown[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => { sent.push([url, JSON.parse(String(init.body))]); return Response.json({ meta: { changes: 1 } }); }));
    expect(await deliverHook(envWithManifest(hookAction), delivery())).toBeNull();
    expect(sent).toEqual([['https://pas-data-t.test.workers.dev/execute', { sql: 'INSERT INTO pings (source, by) VALUES (?, ?)', params: ['ci', SYSTEM_HOOK_USER] }]]);
  });
  it('fails a non-JSON body, an action that is no longer a hook action, and a data-worker error', async () => {
    expect(await deliverHook(envWithManifest(hookAction), delivery({ body: new Uint8Array([0xff]) }))).toMatch(/not JSON/);
    expect(await deliverHook(envWithManifest({ ...hookAction, callers: ['worker'] }), delivery())).toMatch(/not a hook action/);
    vi.stubGlobal('fetch', vi.fn(async () => new Response('no such table', { status: 400 })));
    expect(await deliverHook(envWithManifest({ ...hookAction, operation: 'batch', sql: undefined, statements: ['INSERT INTO pings (source) VALUES (:source)'] }), delivery()))
      .toMatch(/failed \(400\): no such table/);
  });
});

describe('deliverHook → worker (#256)', () => {
  const workerTarget = delivery({ target: 'worker', attempt: 2, headers: new Headers({ 'content-type': 'application/octet-stream', 'x-hub-signature-256': 'sha256=x', 'x-github-event': 'push' }), body: new Uint8Array([0xff, 0x00]) });
  const stubHost = (active: boolean, result: Partial<host.InvokeResult>) => {
    vi.spyOn(host, 'activeAppWorker').mockResolvedValue(active ? ({ app_id: 't' } as host.AppWorkerRow) : null);
    const invoke = vi.fn(async () => ({ invocationId: 'x', httpStatus: 200, body: '', status: 'succeeded', ...result }) as host.InvokeResult);
    vi.spyOn(host, 'appWorkerHost').mockReturnValue({ backend: 'loader', invoke, deploy: vi.fn(), remove: vi.fn() } as unknown as host.AppWorkerHost);
    return invoke;
  };

  it('invokes a hook envelope: row id, the delivery attempt, allowlisted headers, base64 body, 60 s', async () => {
    const invoke = stubHost(true, {});
    expect(await deliverHook({} as Env, workerTarget)).toBeNull();
    expect(invoke).toHaveBeenCalledWith('t', {
      id: 'row-1', type: 'hook', name: 'ping', attempt: 2,
      payload: { headers: { 'content-type': 'application/octet-stream', 'x-github-event': 'push' }, body: '/wA=', body_encoding: 'base64' },
    }, { timeoutMs: HOOK_TIMEOUT_MS });
  });
  it('records "app worker not deployed", a timeout and a non-2xx as failures', async () => {
    stubHost(false, {});
    expect(await deliverHook({} as Env, workerTarget)).toBe('app worker not deployed');
    stubHost(true, { status: 'timeout', httpStatus: null });
    expect(await deliverHook({} as Env, workerTarget)).toBe(`worker timed out after ${HOOK_TIMEOUT_MS} ms`);
    stubHost(true, { status: 'failed', httpStatus: 500 });
    expect(await deliverHook({} as Env, workerTarget)).toBe('worker answered 500');
  });
});
