import { describe, expect, it, vi } from 'vitest';
import { app } from '../index.js';
import { TEST_SK, testToken } from '../test-helpers.js';
import type { Env } from '../types.js';

const TOK = await testToken('gh:room-user');

function makeEnv(fetchRoom: (request: Request) => Response | Promise<Response>): Env {
  const stub = {
    fetch: vi.fn((input: RequestInfo | URL, init?: RequestInit) =>
      fetchRoom(input instanceof Request ? input : new Request(input, init)),
    ),
  };
  return {
    DB: {} as D1Database,
    SELF: {} as Fetcher,
    STORAGE: {} as R2Bucket,
    ROOM: {
      idFromName: vi.fn((name: string) => ({ name })),
      get: vi.fn(() => stub),
    } as unknown as DurableObjectNamespace,
    STRIPE_SECRET_KEY: 'sk_test',
    STRIPE_WEBHOOK_SECRET: 'whsec_test',
    SESSION_SIGNING_KEY: TEST_SK,
    CF_API_TOKEN: 'cf_tok',
    CF_ACCOUNT_ID: 'cf_acct',
    VAPID_PUBLIC_KEY: 'p',
    VAPID_PRIVATE_KEY: 'q',
    AI: { run: vi.fn() },
  } as unknown as Env;
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

  it('rejects websocket upgrades with no session token', async () => {
    const roomFetch = vi.fn(() => new Response('upgraded'));

    const res = await app.request(
      'https://api.proappstore.online/v1/apps/meetup/rooms/lobby',
      { headers: { Upgrade: 'websocket' } },
      makeEnv(roomFetch),
    );

    expect(res.status).toBe(401);
    expect(await res.text()).toContain('missing token');
    expect(roomFetch).not.toHaveBeenCalled();
  });
});
