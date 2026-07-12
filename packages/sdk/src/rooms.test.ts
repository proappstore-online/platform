import { afterEach, describe, expect, it, vi } from 'vitest';
import { Rooms } from './rooms.js';

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
