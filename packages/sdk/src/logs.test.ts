import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Logs, describeError, readOrCreateClientId, redactClient, type BreadcrumbCategory } from './logs.js';

interface Captured {
  url: string;
  body: { entries: Array<Record<string, unknown>>; clientId?: string };
  init: RequestInit;
}

let sent: Captured[] = [];
let status = 200;

function fakeAuth(over: Partial<{ token: string | null; usesPlatformCookie: boolean }> = {}) {
  // `'token' in over`, not `??`: an explicit null means signed out, which is a
  // case that must reach the transport rather than fall back to a default token.
  return {
    token: 'token' in over ? over.token ?? null : 'tok',
    usesPlatformCookie: over.usesPlatformCookie ?? false,
  };
}

function makeLogs(over: Parameters<typeof fakeAuth>[0] = {}, opts = {}) {
  return new Logs('chess-academy', 'https://api.proappstore.online', fakeAuth(over), opts);
}

beforeEach(() => {
  sent = [];
  status = 200;
  const store = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  });
  vi.stubGlobal('window', {
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    localStorage: {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
    },
  });
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
    sent.push({ url, body: JSON.parse(String(init.body)), init });
    return new Response(null, { status });
  }));
  vi.stubGlobal('navigator', {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('redactClient', () => {
  it('strips secrets before they leave the browser', () => {
    expect(redactClient('login failed password=hunter2')).toContain('password=[redacted]');
    expect(redactClient('sent Bearer abc.def-ghi')).toBe('sent Bearer [redacted]');
    expect(redactClient('parent@example.com failed')).toBe('[email] failed');
  });

  it('leaves ordinary text alone', () => {
    expect(redactClient('could not load board')).toBe('could not load board');
  });
});

describe('describeError', () => {
  it('names the error type and keeps the stack', () => {
    const out = describeError(new TypeError('x is not a function'));
    expect(out.message).toBe('TypeError: x is not a function');
    expect(out.stack).toBeTruthy();
  });

  it('handles strings and non-error rejections', () => {
    expect(describeError('plain string').message).toBe('plain string');
    expect(describeError({ code: 42 }).message).toBe('{"code":42}');
    expect(describeError(undefined).message).toBeTruthy();
  });

  it('survives an unserializable rejection value', () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => describeError(cyclic)).not.toThrow();
  });
});

describe('readOrCreateClientId', () => {
  it('creates once and reuses', () => {
    const first = readOrCreateClientId();
    expect(first).toMatch(/^[A-Za-z0-9_-]{8,64}$/);
    expect(readOrCreateClientId()).toBe(first);
  });

  it('returns null rather than throwing when storage is blocked', () => {
    vi.stubGlobal('window', {
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      get localStorage(): Storage {
        throw new Error('blocked');
      },
    });
    expect(readOrCreateClientId()).toBeNull();
  });
});

describe('queueing and flushing', () => {
  it('batches entries and posts them on flush', async () => {
    const logs = makeLogs();
    logs.error('board failed to load');
    logs.warn('slow move');
    expect(logs.pending).toBe(2);

    await logs.flushAsync();
    expect(sent).toHaveLength(1);
    expect(sent[0].body.entries).toHaveLength(2);
    expect(sent[0].url).toBe('https://api.proappstore.online/v1/apps/chess-academy/logs');
    expect(logs.pending).toBe(0);
  });

  it('drops debug below the default level but honours an explicit one', async () => {
    const quiet = makeLogs();
    quiet.debug('noisy');
    expect(quiet.pending).toBe(0);

    const verbose = makeLogs({}, { level: 'debug' as const });
    verbose.debug('noisy');
    expect(verbose.pending).toBe(1);
  });

  it('sends nothing when the queue is empty', async () => {
    await makeLogs().flushAsync();
    expect(sent).toHaveLength(0);
  });

  it('attaches the client id and build metadata', async () => {
    const logs = makeLogs({}, { build: { sha: 'abc123' } });
    logs.start();
    logs.error('boom');
    await logs.flushAsync();
    expect(sent[0].body.clientId).toMatch(/^[A-Za-z0-9_-]{8,64}$/);
    expect(sent[0].body.entries[0].build).toEqual({ sha: 'abc123' });
  });

  it('redacts messages and payloads before sending', async () => {
    const logs = makeLogs();
    logs.error('failed password=hunter2', { authorization: 'Bearer abc123' });
    await logs.flushAsync();
    const wire = JSON.stringify(sent[0].body);
    expect(wire).not.toContain('hunter2');
    expect(wire).not.toContain('abc123');
  });

  it('keeps the entry when its data payload cannot be serialized', async () => {
    const logs = makeLogs();
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    logs.error('cyclic payload', cyclic);
    await logs.flushAsync();
    expect(sent[0].body.entries[0].message).toBe('cyclic payload');
    expect(sent[0].body.entries[0].data).toBeUndefined();
  });

  it('caps a batch at 100 and keeps the remainder queued', async () => {
    const logs = makeLogs();
    for (let i = 0; i < 150; i++) logs.error(`e${i}`);
    // Reaching 100 triggers an immediate send; drain the rest explicitly.
    await logs.flushAsync();
    expect(sent[0].body.entries).toHaveLength(100);
  });

  it('bounds the queue, dropping oldest first', async () => {
    const logs = makeLogs();
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 500 })));
    for (let i = 0; i < 400; i++) logs.error(`e${i}`);
    expect(logs.pending).toBeLessThanOrEqual(200);
  });
});

describe('auth session diagnostics (#353)', () => {
  const correlationId = 'a'.repeat(32);

  // #429: entries with a correlation id (traceId) but no span were folded like an
  // error loop, so a second session loss's id never reached the server.
  it('keeps two session losses with different correlation ids as two entries', async () => {
    const logs = makeLogs();
    const event = (id: string) => ({
      category: 'auth.session_lost', reason: 'api_401', phase: 'api_request', route: 'platform.api',
      correlationId: id, priorAuthenticated: true, status: 401, elapsedMs: 1, online: true, visibility: 'visible',
    } as unknown as Parameters<Logs['captureAuthEvent']>[0]);
    logs.captureAuthEvent(event('b'.repeat(32)));
    logs.captureAuthEvent(event('c'.repeat(32)));
    await logs.flushAsync();
    expect(sent[0].body.entries.map((e: { traceId?: string }) => e.traceId)).toEqual(['b'.repeat(32), 'c'.repeat(32)]);
  });

  it('writes only the reviewed auth fields and uses the correlation id as trace id', async () => {
    const logs = makeLogs();
    logs.captureAuthEvent({
      category: 'auth.session_lost', reason: 'api_401', phase: 'api_request', route: 'platform.api',
      correlationId, priorAuthenticated: true, status: 401, elapsedMs: 42, online: true, visibility: 'visible',
      // Deliberately hostile extra values must never cross the telemetry boundary.
      token: 'secret-token', cookie: 'session=secret', authorization: 'Bearer secret',
      query: '?email=parent@example.com', child: { name: 'student' },
    } as unknown as Parameters<Logs['captureAuthEvent']>[0]);
    await logs.flushAsync();

    const entry = sent[0].body.entries[0]!;
    expect(entry.category).toBe('auth.session_lost');
    expect(entry.traceId).toBe(correlationId);
    expect(entry.data).toEqual({
      reason: 'api_401', phase: 'api_request', route: 'platform.api', correlationId: '[hex]',
      priorAuthenticated: true, status: 401, elapsedMs: 42, online: true, visibility: 'visible',
    });
    const wire = JSON.stringify(entry);
    for (const secret of ['secret-token', 'session=secret', 'Bearer secret', '?email', 'parent@example.com', 'student']) expect(wire).not.toContain(secret);
  });

  it('rejects values outside the auth telemetry allowlist', async () => {
    const logs = makeLogs();
    logs.captureAuthEvent({
      category: 'auth.session_lost', reason: 'api_401', phase: 'api_request', route: 'platform.api?token=leak',
      correlationId, priorAuthenticated: true, status: 401, elapsedMs: 0, online: null, visibility: 'unknown',
    } as unknown as Parameters<Logs['captureAuthEvent']>[0]);
    expect(logs.pending).toBe(0);
    await logs.flushAsync();
    expect(sent).toHaveLength(0);
  });

  it('does not recurse or retry immediately when telemetry itself fails', async () => {
    const fetchMock = vi.fn(async () => { throw new Error('telemetry offline'); });
    vi.stubGlobal('fetch', fetchMock);
    const logs = makeLogs();
    logs.captureAuthEvent({
      category: 'auth.hydration_failure', reason: 'network_error', phase: 'cookie_hydration', route: 'auth.me',
      correlationId, priorAuthenticated: true, elapsedMs: 1, online: false, visibility: 'hidden',
    });
    await logs.flushAsync();
    await logs.flushAsync();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // Kept for a bounded, backed-off retry (#392) — and the failure logged nothing about itself.
    expect(logs.pending).toBe(1);
  });
});

describe('auth modes', () => {
  it('sends a bearer token in legacy mode', async () => {
    const logs = makeLogs({ token: 'session-tok' });
    logs.error('boom');
    await logs.flushAsync();
    const headers = sent[0].init.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer session-tok');
  });

  it('posts anonymously with no token rather than dropping the report', async () => {
    const logs = makeLogs({ token: null });
    logs.error('boom before sign-in');
    await logs.flushAsync();
    expect(sent).toHaveLength(1);
    expect((sent[0].init.headers as Record<string, string>).Authorization).toBeUndefined();
  });

  it('uses the same-origin mediated URL in platform-cookie mode', async () => {
    const logs = makeLogs({ usesPlatformCookie: true, token: null });
    logs.error('boom');
    await logs.flushAsync();
    expect(sent[0].url).toBe('/.pas/api/v1/apps/chess-academy/logs');
    expect(sent[0].init.credentials).toBe('same-origin');
  });
});

describe('server backpressure', () => {
  it('goes quiet after a 202 instead of retrying into a flood', async () => {
    status = 202;
    const logs = makeLogs();
    logs.error('loop');
    await logs.flushAsync();
    expect(sent).toHaveLength(1);

    logs.error('loop again');
    await logs.flushAsync();
    expect(sent).toHaveLength(1); // still quiet
  });

  it('stops permanently on 404, since a bad appId can never succeed', async () => {
    status = 404;
    const logs = makeLogs();
    logs.error('boom');
    await logs.flushAsync();
    expect(sent).toHaveLength(1);

    logs.error('boom again');
    expect(logs.pending).toBe(0); // capture is a no-op once disabled
    await logs.flushAsync();
    expect(sent).toHaveLength(1);
  });

  it('never throws when the network fails', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new Error('offline');
    }));
    const logs = makeLogs();
    logs.error('boom');
    await expect(logs.flushAsync()).resolves.toBeUndefined();
  });
});

describe('auto-capture', () => {
  it('registers window handlers on start and removes them on stop', () => {
    const logs = makeLogs();
    logs.start();
    const added = (window.addEventListener as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]);
    expect(added).toEqual(expect.arrayContaining(['error', 'unhandledrejection', 'pagehide']));

    logs.stop();
    const removed = (window.removeEventListener as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]);
    expect(removed).toEqual(expect.arrayContaining(['error', 'unhandledrejection', 'pagehide']));
  });

  it('captures a thrown error with its stack', async () => {
    const logs = makeLogs();
    logs.start();
    const handler = (window.addEventListener as ReturnType<typeof vi.fn>).mock.calls.find(
      (c) => c[0] === 'error',
    )![1] as (e: unknown) => void;

    handler({ error: new TypeError('x is not a function'), message: '', filename: 'app.js', lineno: 12 });
    await logs.flushAsync();

    const entry = sent[0].body.entries[0] as Record<string, unknown>;
    expect(entry.level).toBe('error');
    expect(entry.category).toBe('window.error');
    expect(entry.message).toContain('TypeError');
    expect((entry.data as Record<string, unknown>).stack).toBeTruthy();
  });

  it('captures an unhandled rejection', async () => {
    const logs = makeLogs();
    logs.start();
    const handler = (window.addEventListener as ReturnType<typeof vi.fn>).mock.calls.find(
      (c) => c[0] === 'unhandledrejection',
    )![1] as (e: unknown) => void;

    handler({ reason: new Error('fetch failed') });
    await logs.flushAsync();
    expect(sent[0].body.entries[0].category).toBe('unhandledrejection');
  });

  it('falls back to the event message when no error object is present', async () => {
    const logs = makeLogs();
    logs.start();
    const handler = (window.addEventListener as ReturnType<typeof vi.fn>).mock.calls.find(
      (c) => c[0] === 'error',
    )![1] as (e: unknown) => void;

    handler({ message: 'Script error.', filename: '', lineno: 0 });
    await logs.flushAsync();
    expect(sent[0].body.entries[0].message).toBe('Script error.');
  });

  it('is a no-op without a browser', () => {
    vi.unstubAllGlobals();
    const logs = makeLogs();
    expect(() => logs.start()).not.toThrow();
    expect(() => logs.stop()).not.toThrow();
  });
});

describe('diagnostic envelope (#390)', () => {
  const TRACE = 'ab'.repeat(16);
  const SPAN = 'cd'.repeat(8);

  it('every entry carries the envelope version, the SDK version and the build stamp', async () => {
    const logs = makeLogs({}, { build: { sha: 'abc1234' } });
    logs.capture('info', 'app', 'hello');
    await logs.flushAsync();
    expect(sent[0]!.body.entries[0]).toMatchObject({ v: 1, sdkVersion: expect.any(String), build: { sha: 'abc1234' }, traceId: expect.stringMatching(/^[0-9a-f]{32}$/) });
  });

  it('a capture context joins the entry to its request; only allowlisted, well-formed fields are kept', async () => {
    const logs = makeLogs();
    logs.capture('error', 'action', 'action x failed', { status: 500 }, {
      traceId: TRACE.toUpperCase(), spanId: SPAN, operation: 'action.save_lead', result: 'error', errorCode: 'internal_error', durationMs: 42,
      // Not part of the contract: dropped.
      ...({ url: 'https://x.example/?token=secret', body: '{"password":"p"}' } as object),
    });
    logs.capture('error', 'action', 'bad context', undefined, {
      traceId: 'not-a-trace', spanId: '0000000000000000', operation: 'https://x.example/a?b=c', result: 'maybe' as 'ok', errorCode: 'has spaces in it', durationMs: -1,
    });
    await logs.flushAsync();
    const [good, bad] = sent[0]!.body.entries;
    expect(good).toMatchObject({ traceId: TRACE, spanId: SPAN, operation: 'action.save_lead', result: 'error', errorCode: 'internal_error', durationMs: 42 });
    expect(good).not.toHaveProperty('url');
    expect(good).not.toHaveProperty('body');
    expect(JSON.stringify(good)).not.toMatch(/secret|password|x\.example/);
    expect(bad!.traceId).toMatch(/^[0-9a-f]{32}$/);
    expect(bad!.traceId).not.toBe('not-a-trace');
    for (const k of ['spanId', 'operation', 'result', 'errorCode', 'durationMs']) expect(bad, k).not.toHaveProperty(k);
  });

  it('captureException records the error with its stack and the request context', async () => {
    const logs = makeLogs();
    logs.captureException(new TypeError('boom'), { traceId: TRACE, spanId: SPAN, operation: 'checkout' });
    logs.captureException('plain string', { category: 'billing' });
    await logs.flushAsync();
    const [first, second] = sent[0]!.body.entries;
    expect(first).toMatchObject({ level: 'error', category: 'exception', message: 'TypeError: boom', traceId: TRACE, spanId: SPAN, operation: 'checkout', result: 'error' });
    expect((first!.data as { stack: string }).stack).toContain('boom');
    expect(second).toMatchObject({ level: 'error', category: 'billing', message: 'plain string', result: 'error' });
  });

  it('auth diagnostics keep their correlation id as the trace id (#353)', async () => {
    const logs = makeLogs();
    logs.captureAuthEvent({
      category: 'auth.session_lost', reason: 'api_401', phase: 'api_request', route: 'platform.api', correlationId: TRACE,
      priorAuthenticated: true, status: 401, elapsedMs: 5, online: true, visibility: 'visible',
    });
    await logs.flushAsync();
    expect(sent[0]!.body.entries[0]).toMatchObject({ category: 'auth.session_lost', traceId: TRACE, v: 1 });
  });
});

describe('exceptions, breadcrumbs and delivery health (#392)', () => {
  function handler(type: string): (e?: unknown) => void {
    const calls = (window.addEventListener as ReturnType<typeof vi.fn>).mock.calls.filter((c) => c[0] === type);
    return calls[calls.length - 1]![1] as (e?: unknown) => void;
  }

  it('describeError keeps the cause chain, bounded and cycle-safe', () => {
    const root = new TypeError('socket reset');
    const out = describeError(new Error('save failed', { cause: new Error('fetch failed', { cause: root }) }));
    expect(out.message).toBe('Error: save failed');
    expect(out.stack).toContain('Caused by: Error: fetch failed');
    expect(out.stack).toContain('Caused by: TypeError: socket reset');

    const a = new Error('a');
    const b = new Error('b', { cause: a });
    (a as { cause?: unknown }).cause = b;
    expect(() => describeError(a)).not.toThrow();
    expect(describeError(a).stack!.match(/Caused by/g)).toHaveLength(1);
    expect(describeError(new Error('x', { cause: 'plain reason' })).stack).toContain('Caused by: plain reason');
  });

  it('captureReactError records the boundary entry with causes and the component stack', async () => {
    const logs = makeLogs();
    logs.captureReactError(new Error('render broke', { cause: new Error('bad prop') }), '\n    at Board\n    at GamePlay');
    await logs.flushAsync();
    const entry = sent[0]!.body.entries[0]!;
    expect(entry).toMatchObject({ level: 'error', category: 'react.error-boundary', message: 'Error: render broke', result: 'error' });
    const data = entry.data as { stack: string; componentStack: string };
    expect(data.stack).toContain('Caused by: Error: bad prop');
    expect(data.componentStack).toContain('GamePlay');
  });

  it('one event per failure: an error captured, then rethrown to window, is recorded once', async () => {
    const logs = makeLogs();
    logs.start();
    const err = new Error('move rejected');
    logs.captureException(err);
    handler('error')({ error: err, message: err.message, filename: '', lineno: 0 });
    handler('unhandledrejection')({ reason: err });
    logs.captureReactError(err, null);
    expect(logs.pending).toBe(1);
    logs.stop();
  });

  it('folds an identical repeat into the queued entry instead of queueing it again', async () => {
    const logs = makeLogs();
    logs.error('board failed to load', { board: 1 });
    logs.error('board failed to load', { board: 1 });
    logs.error('board failed to load');
    // Request-correlated entries are separate failures, each with its trace.
    logs.capture('error', 'action', 'action x failed', undefined, { spanId: 'cd'.repeat(8) });
    logs.capture('error', 'action', 'action x failed', undefined, { spanId: 'ef'.repeat(8) });
    expect(logs.pending).toBe(3);
    expect(logs.health().duplicates).toBe(2);
    await logs.flushAsync();
    expect(sent[0]!.body.entries[0]!.data).toMatchObject({ board: 1, repeats: 3 });
  });

  it('breadcrumbs are bounded, allowlisted, redacted, primitive-only and ride on error entries only', async () => {
    const logs = makeLogs();
    for (let i = 0; i < 60; i++) logs.addBreadcrumb('ui', `tap ${i}`);
    expect(logs.health().breadcrumbs).toBe(50);
    logs.addBreadcrumb('dom' as BreadcrumbCategory, 'ignored');
    logs.addBreadcrumb('navigation', 'opened parent@example.com', {
      route: '/game?token=abc123', ok: true, n: 2,
      node: { outerHTML: '<input value="secret">' } as unknown as string, list: ['form text'] as unknown as string,
    });
    expect(logs.health().breadcrumbs).toBe(50);

    logs.info('not an error');
    logs.error('boom');
    await logs.flushAsync();
    const [info, error] = sent[0]!.body.entries;
    expect(info!.data).toBeUndefined();
    const crumbs = (error!.data as { breadcrumbs: Array<{ category: string; message: string; data?: Record<string, unknown> }> }).breadcrumbs;
    expect(crumbs.length).toBeLessThanOrEqual(20);
    const last = crumbs[crumbs.length - 1]!;
    expect(last).toMatchObject({ category: 'navigation', message: 'opened [email]', data: { route: '/game?token=[redacted]', ok: true, n: 2 } });
    expect(JSON.stringify(sent[0]!.body)).not.toMatch(/dom|secret|form text|outerHTML|abc123/);
    expect(JSON.stringify(error!.data).length).toBeLessThanOrEqual(3500);
  });

  it('breadcrumbs are never persisted and clear on request', () => {
    const logs = makeLogs();
    logs.start();
    logs.addBreadcrumb('action', 'saved');
    expect(localStorage.getItem('pas:client-id')).toBeTruthy();
    const setItem = vi.spyOn(localStorage, 'setItem');
    logs.addBreadcrumb('action', 'saved again');
    expect(setItem).not.toHaveBeenCalled();
    logs.clearBreadcrumbs();
    expect(logs.health().breadcrumbs).toBe(0);
    logs.stop();
  });

  it('offline holds the queue; online flushes it', async () => {
    vi.stubGlobal('navigator', { onLine: false });
    const logs = makeLogs();
    logs.start();
    logs.error('lost connection mid-game');
    await logs.flushAsync();
    expect(sent).toHaveLength(0);
    expect(logs.health()).toMatchObject({ queued: 1, dropped: 0 });

    vi.stubGlobal('navigator', { onLine: true });
    handler('online')();
    await vi.waitFor(() => expect(logs.health()).toMatchObject({ queued: 0, sent: 1, dropped: 0 }));
    expect(sent).toHaveLength(1);
    logs.stop();
  });

  it('pagehide sends best-effort and does not discard what it could not send', async () => {
    const beacon = vi.fn(() => true);
    vi.stubGlobal('navigator', { sendBeacon: beacon });
    const cookie = makeLogs({ usesPlatformCookie: true, token: null });
    cookie.start();
    cookie.error('tab closing');
    handler('pagehide')();
    await vi.waitFor(() => expect(beacon).toHaveBeenCalledTimes(1));
    expect(cookie.health()).toMatchObject({ queued: 0, sent: 1 });
    cookie.stop();

    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch'); }));
    const bearer = makeLogs();
    bearer.start();
    bearer.error('tab closing');
    handler('pagehide')();
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    await Promise.resolve();
    expect(bearer.health()).toMatchObject({ queued: 1, dropped: 0 });
    bearer.stop();
  });

  it('queue overflow drops the oldest and counts them', () => {
    vi.stubGlobal('navigator', { onLine: false });
    const logs = makeLogs();
    for (let i = 0; i < 250; i++) logs.error(`e${i}`);
    expect(logs.health()).toMatchObject({ queued: 200, dropped: 50 });
  });

  it('a second init for the same app hands over capture instead of doubling the handlers', () => {
    const add = window.addEventListener as ReturnType<typeof vi.fn>;
    const remove = window.removeEventListener as ReturnType<typeof vi.fn>;
    const first = makeLogs();
    first.start();
    const second = makeLogs();
    second.start();
    second.start();
    const count = (fn: ReturnType<typeof vi.fn>, type: string) => fn.mock.calls.filter((c) => c[0] === type).length;
    for (const type of ['error', 'unhandledrejection', 'pagehide', 'online']) {
      expect(count(add, type), type).toBe(2);
      expect(count(remove, type), type).toBe(1); // the first logger's
    }
    first.stop(); // already stopped: removes nothing of the second's
    expect(count(remove, 'error')).toBe(1);
    second.stop();
  });

  it('202 and 429 go quiet and count the batch as dropped; 404 disables permanently', async () => {
    for (const code of [202, 429]) {
      sent = [];
      status = code;
      const logs = makeLogs();
      logs.error('loop');
      await logs.flushAsync();
      logs.error('loop again');
      await logs.flushAsync();
      expect(sent, String(code)).toHaveLength(1);
      expect(logs.health()).toMatchObject({ dropped: 1, queued: 1, disabled: false, quietUntil: expect.any(Number) });
    }

    sent = [];
    status = 404;
    const gone = makeLogs();
    gone.error('a');
    gone.error('b');
    await gone.flushAsync();
    expect(gone.health()).toMatchObject({ disabled: true, dropped: 2, queued: 0 });
  });

  it('retries a transient failure with bounded backoff, then drops it — no retry storm', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(async () => new Response(null, { status: 503 }));
    vi.stubGlobal('fetch', fetchMock);
    const logs = makeLogs();
    logs.start();
    logs.error('boom');
    await logs.flushAsync();
    await logs.flushAsync(); // inside the backoff: no extra request
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(4_000);
    expect(fetchMock).toHaveBeenCalledTimes(4);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(fetchMock).toHaveBeenCalledTimes(4);
    // The failing transport recorded nothing about itself.
    expect(logs.health()).toMatchObject({ queued: 0, sent: 0, dropped: 1 });
    logs.stop();
  });

  it('a retried batch is delivered once the endpoint recovers', async () => {
    vi.useFakeTimers();
    let fail = true;
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
      if (fail) { fail = false; throw new TypeError('Failed to fetch'); }
      sent.push({ url, body: JSON.parse(String(init.body)), init });
      return new Response(null, { status: 200 });
    }));
    const logs = makeLogs();
    logs.start();
    logs.error('flaky');
    await logs.flushAsync();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(sent).toHaveLength(1);
    expect(logs.health()).toMatchObject({ queued: 0, sent: 1, dropped: 0 });
    logs.stop();
  });
});
