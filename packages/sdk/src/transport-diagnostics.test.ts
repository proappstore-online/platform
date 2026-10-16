import { afterEach, describe, expect, it, vi } from 'vitest';
import { Auth } from './auth.js';
import { initPro } from './index.js';
import { platformOperation, type TransportFailure } from './trace.js';

// #392: a platform call that never got a response is seen by no server, so the
// SDK reports it — for every platform call, not only actions — without changing
// the caller's outcome, without double-counting actions, and without flooding.

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

function signedInLegacy(): Auth {
  const storage = new Map([['pas:session', JSON.stringify({ token: 'tok', user: { id: 'gh:1', login: 'u' } })]]);
  vi.stubGlobal('window', {
    location: { hash: '', href: 'https://demo.example/', origin: 'https://demo.example', pathname: '/', search: '' },
    localStorage: { getItem: (k: string) => storage.get(k) ?? null, setItem: () => {}, removeItem: () => {} },
  });
  return new Auth('demo', 'https://api.proappstore.online', 'legacy-bearer');
}

describe('platform-call transport diagnostics (#392)', () => {
  it('labels the operation by family or data plane, never with the path, ids or query', () => {
    expect(platformOperation('https://api.proappstore.online/v1/apps/demo/kv/secret-key?x=1')).toBe('platform.kv');
    expect(platformOperation('/.pas/data/query')).toBe('platform.db');
    expect(platformOperation('https://data-demo.proappstore.online/query')).toBe('platform.db');
    expect(platformOperation('https://api.proappstore.online/v1/me')).toBe('platform');
    expect(platformOperation('/.pas/api/v1/apps/demo/roles/me')).toBe('platform.roles');
  });

  it('reports a network failure and a timeout once, and rethrows the original error unchanged', async () => {
    const auth = signedInLegacy();
    const seen: TransportFailure[] = [];
    auth.observeTransportFailures((f) => seen.push(f));
    const offline = new TypeError('Failed to fetch');
    vi.stubGlobal('fetch', vi.fn(async () => { throw offline; }));
    await expect(auth.authenticatedFetch('https://api.proappstore.online/v1/apps/demo/kv/x')).rejects.toBe(offline);
    const timeout = Object.assign(new Error('timed out'), { name: 'TimeoutError' });
    vi.stubGlobal('fetch', vi.fn(async () => { throw timeout; }));
    await expect(auth.authenticatedFetch('https://data-demo.proappstore.online/query', { method: 'POST' })).rejects.toBe(timeout);
    expect(seen.map((f) => [f.kind, f.operation])).toEqual([['network', 'platform.kv'], ['timeout', 'platform.db']]);
    expect(seen.every((f) => f.durationMs >= 0)).toBe(true);
  });

  it('a cancellation the caller asked for is reported as cancelled, not as a failure', async () => {
    const auth = signedInLegacy();
    const seen: TransportFailure[] = [];
    auth.observeTransportFailures((f) => seen.push(f));
    const controller = new AbortController();
    controller.abort();
    vi.stubGlobal('fetch', vi.fn(async () => { throw Object.assign(new Error('aborted'), { name: 'AbortError' }); }));
    await expect(auth.authenticatedFetch('https://api.proappstore.online/v1/apps/demo/kv/x', { signal: controller.signal })).rejects.toThrow('aborted');
    expect(seen.map((f) => f.kind)).toEqual(['cancelled']);
  });

  it('a caller with its own context (actions) reports its own failure: Auth stays silent; an HTTP error is not a transport failure', async () => {
    const auth = signedInLegacy();
    const observer = vi.fn();
    auth.observeTransportFailures(observer);
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch'); }));
    const ctx = { traceId: 'ab'.repeat(16), spanId: 'cd'.repeat(8), operation: 'action.x', startedAt: Date.now() };
    await expect(auth.authenticatedFetch('https://api.proappstore.online/v1/apps/demo/actions/x', {}, ctx)).rejects.toThrow();
    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 500 })));
    expect((await auth.authenticatedFetch('https://api.proappstore.online/v1/apps/demo/kv/x')).status).toBe(500);
    expect(observer).not.toHaveBeenCalled();
  });

  it('an observer that throws never changes the call outcome', async () => {
    const auth = signedInLegacy();
    auth.observeTransportFailures(() => { throw new Error('observer broke'); });
    const offline = new TypeError('Failed to fetch');
    vi.stubGlobal('fetch', vi.fn(async () => { throw offline; }));
    await expect(auth.authenticatedFetch('https://api.proappstore.online/v1/apps/demo/kv/x')).rejects.toBe(offline);
  });

  it('wired by initPro: one queued error entry per fault, repeats folded, cancellations as breadcrumbs only', async () => {
    const app = initPro({ appId: 'demo', authMode: 'legacy-bearer' });
    const observer = (app.auth as unknown as { transportObserver: (f: TransportFailure) => void }).transportObserver;
    const before = app.logs.health();
    const offline = new TypeError('Failed to fetch');
    observer({ kind: 'network', operation: 'platform.kv', durationMs: 3, error: offline });
    observer({ kind: 'network', operation: 'platform.kv', durationMs: 4, error: new TypeError('Failed to fetch') });
    observer({ kind: 'cancelled', operation: 'platform.db', durationMs: 1, error: new Error('aborted') });
    const after = app.logs.health();
    expect(after.queued - before.queued).toBe(1);
    expect(after.duplicates - before.duplicates).toBe(1);
    expect(after.breadcrumbs - before.breadcrumbs).toBe(1);
  });
});
