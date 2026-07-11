import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Usage } from './usage.js';

// vitest runs in pure Node — no jsdom in this workspace. We manually set
// `document` / `window` / `navigator.sendBeacon` on globalThis so the
// browser-only code paths in Usage exercise. Cleanup restores the originals.

interface MockAuth {
  token: string | null;
  isSignedIn?: boolean;
  usesPlatformCookie?: boolean;
}

interface MockDoc {
  visibilityState: 'visible' | 'hidden';
  addEventListener: ReturnType<typeof vi.fn>;
  removeEventListener: ReturnType<typeof vi.fn>;
}

interface MockWin {
  addEventListener: ReturnType<typeof vi.fn>;
  removeEventListener: ReturnType<typeof vi.fn>;
}

let mockDoc: MockDoc;
let mockWin: MockWin;
let fetchMock: ReturnType<typeof vi.fn>;
let beaconMock: ReturnType<typeof vi.fn>;

const originalFetch = globalThis.fetch;
const originalDocument = (globalThis as Record<string, unknown>).document;
const originalWindow = (globalThis as Record<string, unknown>).window;

function makeUsage(auth: MockAuth = { token: 'tok' }): Usage {
  return new Usage('meetup', 'https://api.proappstore.online', auth);
}

beforeEach(() => {
  // Fake timers with shouldAdvanceTime so performance.now() tracks the fake clock.
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout', 'Date', 'performance'] });

  mockDoc = {
    visibilityState: 'visible',
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  };
  mockWin = {
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  };

  (globalThis as Record<string, unknown>).document = mockDoc;
  (globalThis as Record<string, unknown>).window = mockWin;

  beaconMock = vi.fn().mockReturnValue(true);
  Object.defineProperty(globalThis.navigator, 'sendBeacon', {
    configurable: true,
    value: beaconMock,
  });

  fetchMock = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }));
  globalThis.fetch = fetchMock as unknown as typeof fetch;
});

afterEach(() => {
  vi.useRealTimers();
  globalThis.fetch = originalFetch;
  if (originalDocument === undefined) delete (globalThis as Record<string, unknown>).document;
  else (globalThis as Record<string, unknown>).document = originalDocument;
  if (originalWindow === undefined) delete (globalThis as Record<string, unknown>).window;
  else (globalThis as Record<string, unknown>).window = originalWindow;
  // navigator.sendBeacon was added via defineProperty; delete it.
  // @ts-expect-error sendBeacon is optional / not in Node's Navigator type
  delete globalThis.navigator.sendBeacon;
});

describe('Usage', () => {
  it('start() then advance 60s while visible → POST /v1/usage/ping with deltaSeconds ~60', async () => {
    const u = makeUsage();
    u.start();
    await vi.advanceTimersByTimeAsync(60_000);
    u.stop(); // freeze the timer so we don't race against the next interval tick
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://api.proappstore.online/v1/usage/ping');
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.appId).toBe('meetup');
    expect(body.deltaSeconds).toBeGreaterThanOrEqual(59);
    expect(body.deltaSeconds).toBeLessThanOrEqual(60);
    expect(body.deltaApiCalls).toBe(0);
    u.stop();
  });

  it('start() is idempotent — one heartbeat per tick even if started repeatedly', async () => {
    const u = makeUsage();
    u.start();
    u.start();
    u.start();
    await vi.advanceTimersByTimeAsync(60_000);
    u.stop(); // freeze the timer so we don't race against the next interval tick
    expect(fetchMock).toHaveBeenCalledTimes(1);
    u.stop();
  });

  it('hidden tab does not accrue session time', async () => {
    mockDoc.visibilityState = 'hidden';
    const u = makeUsage();
    u.start();
    await vi.advanceTimersByTimeAsync(60_000);
    u.stop(); // freeze the timer so we don't race against the next interval tick
    expect(fetchMock).not.toHaveBeenCalled();
    u.stop();
  });

  it('recordApiCall accumulates and piggybacks on next heartbeat; ignores invalid n', async () => {
    const u = makeUsage();
    u.start();
    u.recordApiCall(3);
    u.recordApiCall();
    u.recordApiCall(0);
    u.recordApiCall(-5);
    u.recordApiCall(Number.NaN);
    await vi.advanceTimersByTimeAsync(60_000);
    u.stop(); // freeze the timer so we don't race against the next interval tick
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = JSON.parse((fetchMock.mock.calls[0]![1] as RequestInit).body as string);
    expect(body.deltaApiCalls).toBe(4);
    u.stop();
  });

  it('no token → no fetch; accrual preserved for after a later signin', async () => {
    const auth: MockAuth = { token: null };
    const u = makeUsage(auth);
    u.start();
    // Don't stop between ticks — stop() resets accrued state and we need it
    // to carry across the signin transition.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetchMock).not.toHaveBeenCalled();

    auth.token = 'tok-now';
    await vi.advanceTimersByTimeAsync(60_000);
    u.stop();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = JSON.parse((fetchMock.mock.calls[0]![1] as RequestInit).body as string);
    // The backend clamps at 90; SDK sends min(banked, 90).
    expect(body.deltaSeconds).toBeGreaterThanOrEqual(60);
    expect(body.deltaSeconds).toBeLessThanOrEqual(90);
  });

  it('platform-cookie signed-in sessions post through same-origin mediation without Authorization', async () => {
    const u = makeUsage({ token: null, isSignedIn: true, usesPlatformCookie: true });
    u.start();
    await vi.advanceTimersByTimeAsync(60_000);
    u.stop();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('/.pas/api/v1/usage/ping');
    expect((init as RequestInit).credentials).toBe('same-origin');
    const headers = new Headers((init as RequestInit).headers);
    expect(headers.get('Authorization')).toBeNull();
    expect(headers.get('Content-Type')).toBe('application/json');
  });

  it('platform-cookie signed-out sessions repocket accrual until /me hydrates', async () => {
    const auth: MockAuth = { token: null, isSignedIn: false, usesPlatformCookie: true };
    const u = makeUsage(auth);
    u.start();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetchMock).not.toHaveBeenCalled();

    auth.isSignedIn = true;
    await vi.advanceTimersByTimeAsync(60_000);
    u.stop();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('/.pas/api/v1/usage/ping');
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.deltaSeconds).toBeGreaterThanOrEqual(60);
    expect(body.deltaSeconds).toBeLessThanOrEqual(90);
  });

  it('stop() unregisters the timer and listeners — no further ticks', async () => {
    const u = makeUsage();
    u.start();
    u.stop();
    vi.advanceTimersByTime(120_000);
    await vi.runOnlyPendingTimersAsync();
    expect(fetchMock).not.toHaveBeenCalled();
    // Listener removals match the registrations.
    expect(mockDoc.removeEventListener).toHaveBeenCalledWith('visibilitychange', expect.any(Function));
    expect(mockWin.removeEventListener).toHaveBeenCalledWith('pagehide', expect.any(Function));
  });

  it('flush() prefers sendBeacon for keepalive paths', () => {
    const u = makeUsage();
    u.start();
    vi.advanceTimersByTime(45_000);
    u.flush();
    expect(beaconMock).toHaveBeenCalledTimes(1);
    const [url, blob] = beaconMock.mock.calls[0]!;
    expect(url).toBe('https://api.proappstore.online/v1/usage/ping');
    expect(blob).toBeInstanceOf(Blob);
    u.stop();
  });

  it('flush() in platform-cookie mode beacons to same-origin mediation', () => {
    const u = makeUsage({ token: null, isSignedIn: true, usesPlatformCookie: true });
    u.start();
    vi.advanceTimersByTime(45_000);
    u.flush();
    expect(beaconMock).toHaveBeenCalledTimes(1);
    const [url, blob] = beaconMock.mock.calls[0]!;
    expect(url).toBe('/.pas/api/v1/usage/ping');
    expect(blob).toBeInstanceOf(Blob);
    expect(fetchMock).not.toHaveBeenCalled();
    u.stop();
  });

  it('flush() with zero accrual is a no-op', () => {
    const u = makeUsage();
    u.start();
    u.flush();
    expect(beaconMock).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
    u.stop();
  });

  it('fetch failure is swallowed — telemetry never throws into app code', async () => {
    fetchMock.mockRejectedValueOnce(new Error('network down'));
    const u = makeUsage();
    u.start();
    // advanceTimersByTimeAsync awaits microtasks; if the catch in tick() ever
    // breaks, this would reject. We just want it not to throw.
    await expect(vi.advanceTimersByTimeAsync(60_000)).resolves.not.toThrow();
    u.stop();
  });
});

describe('Usage — SSR safety', () => {
  it('start() in a non-browser env is a no-op (no listeners, no timer fires)', async () => {
    delete (globalThis as Record<string, unknown>).document;
    delete (globalThis as Record<string, unknown>).window;
    const u = makeUsage();
    expect(() => u.start()).not.toThrow();
    vi.advanceTimersByTime(120_000);
    await vi.runOnlyPendingTimersAsync();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(beaconMock).not.toHaveBeenCalled();
  });
});
