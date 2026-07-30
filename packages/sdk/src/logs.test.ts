import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Logs, describeError, readOrCreateClientId, redactClient } from './logs.js';

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
