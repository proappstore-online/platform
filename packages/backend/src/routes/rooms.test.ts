import { describe, expect, it, vi } from 'vitest';
import { app } from '../index.js';
import { TEST_SK, testToken, makeEnv as sharedMakeEnv } from '../test-helpers.js';
import type { Env } from '../types.js';

// Node has no WebSocketPair and its Response refuses status 101; the runtime suite
// (packages/runtime-tests) exercises the real close frame. Here we only pin the code + reason.
vi.mock('../do/room.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../do/room.js')>();
  return {
    ...real,
    refuseWebSocket: vi.fn((code: number, reason: string) => new Response(reason, { status: 418, headers: { 'x-close-code': String(code) } })),
  };
});

const TOK = await testToken('gh:room-user');

function makeEnv(fetchRoom: (request: Request) => Response | Promise<Response>): Env {
  const stub = {
    fetch: vi.fn((input: RequestInfo | URL, init?: RequestInit) =>
      fetchRoom(input instanceof Request ? input : new Request(input, init)),
    ),
  };
  return sharedMakeEnv({
    DB: {} as D1Database,
    SELF: {} as Fetcher,
    ROOM: {
      idFromName: vi.fn((name: string) => ({ name })),
      get: vi.fn(() => stub),
    } as unknown as DurableObjectNamespace,
    VAPID_PUBLIC_KEY: 'p',
    VAPID_PRIVATE_KEY: 'q',
    AI: { run: vi.fn() },
  }) as unknown as Env;
}

describe('GET /v1/apps/:appId/rooms/:roomId', () => {
  it('accepts bearer auth for host-mediated WebSocket upgrades', async () => {
    const roomFetch = vi.fn((request: Request) => {
      const url = new URL(request.url);
      expect(url.pathname).toBe('/v1/apps/meetup/rooms/lobby');
      expect(url.searchParams.get('uid')).toBe('gh:room-user');
      expect(url.searchParams.get('login')).toBe('testuser');
      return new Response('upgraded');
    });

    const res = await app.request(
      'https://api.proappstore.online/v1/apps/meetup/rooms/lobby',
      { headers: { Upgrade: 'websocket', Authorization: `Bearer ${TOK}` } },
      makeEnv(roomFetch),
    );

    expect(res.status).toBe(200);
    expect(await res.text()).toBe('upgraded');
    expect(roomFetch).toHaveBeenCalledOnce();
  });

  it('keeps accepting the legacy token query for existing SDK clients', async () => {
    const roomFetch = vi.fn(() => new Response('upgraded'));

    const res = await app.request(
      `https://api.proappstore.online/v1/apps/meetup/rooms/lobby?token=${encodeURIComponent(TOK)}`,
      { headers: { Upgrade: 'websocket' } },
      makeEnv(roomFetch),
    );

    expect(res.status).toBe(200);
    expect(roomFetch).toHaveBeenCalledOnce();
  });

  it('completes the upgrade and closes 4401 when the session is missing or invalid (#119)', async () => {
    const roomFetch = vi.fn(() => new Response('upgraded'));

    const res = await app.request(
      'https://api.proappstore.online/v1/apps/meetup/rooms/lobby',
      { headers: { Upgrade: 'websocket' } },
      makeEnv(roomFetch),
    );

    expect(res.headers.get('x-close-code')).toBe('4401');
    expect(await res.text()).toBe('missing_token');
    expect(roomFetch).not.toHaveBeenCalled();

    const bad = await app.request(
      'https://api.proappstore.online/v1/apps/meetup/rooms/lobby?token=not-a-session',
      { headers: { Upgrade: 'websocket' } },
      makeEnv(roomFetch),
    );
    expect(bad.headers.get('x-close-code')).toBe('4401');
    expect(await bad.text()).toBe('invalid_session');
    expect(roomFetch).not.toHaveBeenCalled();
  });
});
