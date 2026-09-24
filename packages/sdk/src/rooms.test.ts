import { afterEach, describe, expect, it, vi } from 'vitest';
import { ROOM_CLOSE_CODES, Rooms, classifyClose } from './rooms.js';

interface MockAuth {
  token: string | null;
  isSignedIn: boolean;
  usesPlatformCookie: boolean;
}

const originalWindow = (globalThis as Record<string, unknown>).window;

class MockWebSocket {
  static OPEN = 1;
  readonly url: string;
  readyState = 0;
  send = vi.fn();
  close = vi.fn();
  addEventListener = vi.fn();

  constructor(url: string) {
    this.url = url;
    sockets.push(this);
  }
}

let sockets: MockWebSocket[] = [];

function makeRooms(auth: MockAuth): Rooms {
  return new Rooms('meetup', 'https://api.proappstore.online', auth as never);
}

afterEach(() => {
  vi.unstubAllGlobals();
  if (originalWindow === undefined) delete (globalThis as Record<string, unknown>).window;
  else (globalThis as Record<string, unknown>).window = originalWindow;
  sockets = [];
});

describe('Rooms', () => {
  it('uses the legacy API WebSocket URL with token query in bearer mode', () => {
    vi.stubGlobal('WebSocket', MockWebSocket);

    const room = makeRooms({ token: 'tok_abc', isSignedIn: true, usesPlatformCookie: false }).join('lobby');

    expect(room.state).toBe('connecting');
    expect(sockets).toHaveLength(1);
    const url = new URL(sockets[0]!.url);
    expect(url.toString()).toBe('wss://api.proappstore.online/v1/apps/meetup/rooms/lobby?token=tok_abc');
  });

  it('uses same-origin host mediation without a token query in platform-cookie mode', () => {
    vi.stubGlobal('WebSocket', MockWebSocket);
    vi.stubGlobal('window', { location: { origin: 'https://meetup.proappstore.online' } });

    const room = makeRooms({ token: null, isSignedIn: true, usesPlatformCookie: true }).join('lobby');

    expect(room.state).toBe('connecting');
    expect(sockets).toHaveLength(1);
    const url = new URL(sockets[0]!.url);
    expect(url.toString()).toBe('wss://meetup.proappstore.online/.pas/api/v1/apps/meetup/rooms/lobby');
    expect(url.searchParams.get('token')).toBeNull();
  });

  it('does not connect in platform-cookie mode until auth has hydrated a signed-in user', () => {
    vi.stubGlobal('WebSocket', MockWebSocket);
    vi.stubGlobal('window', { location: { origin: 'https://meetup.proappstore.online' } });

    const room = makeRooms({ token: null, isSignedIn: false, usesPlatformCookie: true }).join('lobby');

    expect(room.state).toBe('closed');
    expect(sockets).toHaveLength(0);
  });
});

describe('Room close reasons (#119)', () => {
  const auth = { token: 'tok', isSignedIn: true, usesPlatformCookie: false };
  function fire(sock: MockWebSocket, type: string, ev: unknown) {
    for (const call of sock.addEventListener.mock.calls) if (call[0] === type) (call[1] as (e: unknown) => void)(ev);
  }

  it('classifies the platform codes and the browser drop codes', () => {
    expect(classifyClose(ROOM_CLOSE_CODES.ROOM_FULL)).toBe('capacity');
    expect(classifyClose(ROOM_CLOSE_CODES.UNAUTHORIZED)).toBe('auth');
    expect(classifyClose(1006)).toBe('network');
    expect(classifyClose(1000)).toBe('normal');
    expect(classifyClose(1011)).toBe('server');
  });

  it('a full room surfaces capacity with the server reason and does NOT reconnect', () => {
    vi.useFakeTimers();
    vi.stubGlobal('WebSocket', MockWebSocket);
    try {
      const room = makeRooms(auth).join('game-1');
      const closes: unknown[] = [];
      const states: string[] = [];
      room.onClose((info) => closes.push(info));
      room.onConnectionState((st) => states.push(st));
      fire(sockets[0]!, 'close', { code: 4429, reason: 'room_full' });
      expect(closes).toEqual([expect.objectContaining({ code: 4429, reason: 'room_full', kind: 'capacity', willReconnect: false })]);
      expect(room.lastClose?.kind).toBe('capacity');
      expect(room.state).toBe('closed');
      vi.advanceTimersByTime(60_000);
      expect(sockets).toHaveLength(1); // no reconnect attempt
    } finally {
      vi.useRealTimers();
    }
  });

  it('a network drop (1006) is reported as such and reconnects with backoff; a bad session (4401) stops', () => {
    vi.useFakeTimers();
    vi.stubGlobal('WebSocket', MockWebSocket);
    try {
      const room = makeRooms(auth).join('game-2');
      const closes: { kind: string; willReconnect: boolean }[] = [];
      room.onClose((info) => closes.push(info));
      fire(sockets[0]!, 'close', { code: 1006, reason: '' });
      expect(closes[0]).toMatchObject({ kind: 'network', willReconnect: true });
      vi.advanceTimersByTime(3_000);
      expect(sockets).toHaveLength(2); // reconnected
      fire(sockets[1]!, 'close', { code: 4401, reason: 'invalid_session' });
      expect(closes[1]).toMatchObject({ kind: 'auth', willReconnect: false, reason: 'invalid_session' });
      vi.advanceTimersByTime(60_000);
      expect(sockets).toHaveLength(2); // and stayed there
      room.close();
    } finally {
      vi.useRealTimers();
    }
  });
});

