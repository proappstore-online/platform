import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { Monitoring } from './monitoring.js';

const API = 'https://api.proappstore.online';
type Auth = { token: string | null; isSignedIn?: boolean; usesPlatformCookie?: boolean };

let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  fetchMock = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }));
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

const lastBody = () => JSON.parse((fetchMock.mock.calls.at(-1)![1] as RequestInit).body as string);

describe('Monitoring.flush', () => {
  it('legacy-bearer: POSTs entries to the app logs endpoint with a bearer header', () => {
    const m = new Monitoring('myapp', API, { token: 'tok_1' });
    m.log('error', 'runtime', 'boom', { x: 1 });
    m.flush();
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${API}/v1/apps/myapp/logs`);
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer tok_1');
    const body = lastBody();
    expect(body.entries).toHaveLength(1);
    expect(body.entries[0]).toMatchObject({ level: 'error', category: 'runtime', message: 'boom' });
    expect(body.entries[0].data).toMatchObject({ mode: 'legacy-bearer', x: 1 });
  });

  it('platform-cookie: same-origin mediated URL, credentials, no auth header', () => {
    const m = new Monitoring('myapp', API, { token: null, isSignedIn: true, usesPlatformCookie: true });
    m.log('warn', 'action', 'slow');
    m.flush();
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/.pas/api/v1/apps/myapp/logs');
    expect(init.credentials).toBe('same-origin');
    expect((init.headers as Record<string, string>).Authorization).toBeUndefined();
  });

  it('does not flush when not authenticated (nothing sent, queue retained)', () => {
    const m = new Monitoring('myapp', API, { token: null });
    m.log('error', 'runtime', 'x');
    m.flush();
    expect(fetchMock).not.toHaveBeenCalled();
    // Signs in later → the queued entry flushes.
    (m as unknown as { auth: Auth }).auth.token = 'tok_late';
    m.flush();
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(lastBody().entries).toHaveLength(1);
  });

  it('caps the queue so a burst cannot grow unbounded', () => {
    const m = new Monitoring('myapp', API, { token: 't' });
    for (let i = 0; i < 250; i++) m.log('info', 'x', `m${i}`);
    m.flush();
    expect(lastBody().entries.length).toBeLessThanOrEqual(100);
  });

  it('never throws when fetch rejects (monitoring must not break the app)', () => {
    fetchMock.mockRejectedValue(new Error('network'));
    const m = new Monitoring('myapp', API, { token: 't' });
    m.log('error', 'runtime', 'x');
    expect(() => m.flush()).not.toThrow();
  });
});

describe('Monitoring auto-capture', () => {
  it('captures uncaught error + unhandledrejection events after start()', () => {
    const handlers: Record<string, (e: unknown) => void> = {};
    vi.stubGlobal('window', {
      location: { pathname: '/p' },
      addEventListener: (type: string, fn: (e: unknown) => void) => { handlers[type] = fn; },
      removeEventListener: () => {},
    });
    const m = new Monitoring('myapp', API, { token: 't' });
    m.start();
    handlers.error!({ message: 'kaboom', error: { stack: 'at x' }, filename: 'a.js', lineno: 3, colno: 4 });
    handlers.unhandledrejection!({ reason: { message: 'nope', stack: 'at y' } });
    m.flush();
    const entries = lastBody().entries;
    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({ category: 'runtime', message: 'kaboom' });
    expect(entries[0].data).toMatchObject({ route: '/p', source: 'a.js' });
    expect(entries[1]).toMatchObject({ category: 'unhandledrejection', message: 'nope' });
    m.stop();
  });
});
