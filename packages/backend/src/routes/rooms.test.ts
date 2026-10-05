import { afterEach, describe, expect, it, vi } from 'vitest';
import { app } from '../index.js';
import { forgetAppVisibility } from '../lib/visibility.js';
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

// The route caches each app's visibility per isolate (#259); tests swap the D1 under it.
afterEach(() => forgetAppVisibility());

/** A D1 whose every lookup answers `row` — enough for the visibility gate (#259). */
function visibilityDb(row: Record<string, unknown> | null): D1Database {
  return { prepare: () => ({ bind: () => ({ first: async () => row }) }) } as unknown as D1Database;
}

function makeEnv(fetchRoom: (request: Request) => Response | Promise<Response>, db: D1Database = visibilityDb(null)): Env {
  const stub = {
    fetch: vi.fn((input: RequestInfo | URL, init?: RequestInit) =>
      fetchRoom(input instanceof Request ? input : new Request(input, init)),
    ),
  };
  return sharedMakeEnv({
    // #259: the route reads app_visibility; no row → public.
    DB: db,
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
      // #276: the room re-runs the private-app gate on open sockets with these.
      expect(url.searchParams.get('app')).toBe('meetup');
      expect(url.searchParams.get('roles')).toBe('user');
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

  it('refuses a caller a private app does not admit with 4401 app_private, before the room (#259)', async () => {
    const roomFetch = vi.fn(() => new Response('upgraded'));
    // Every lookup answers the private row: not the creator, no team row, no role.
    const db = { prepare: (sql: string) => ({ bind: () => ({ first: async () => (sql.includes('app_visibility') ? { mode: 'private', roles: '["viewer"]' } : null) }) }) } as unknown as D1Database;
    const res = await app.request(
      'https://api.proappstore.online/v1/apps/meetup/rooms/lobby',
      { headers: { Upgrade: 'websocket', Authorization: `Bearer ${TOK}` } },
      makeEnv(roomFetch, db),
    );
    expect(res.headers.get('x-close-code')).toBe('4401');
    expect(await res.text()).toBe('app_private');
    expect(roomFetch).not.toHaveBeenCalled();
  });
});
