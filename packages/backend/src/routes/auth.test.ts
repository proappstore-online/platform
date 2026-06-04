import { describe, expect, it, vi, afterEach } from 'vitest';
import { app } from '../index.js';
import { mintSession } from '@proappstore/build-core';

const b64url = (s: string) => btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

const KEY = 'test-signing-key';
const env = () => ({ DB: {} as D1Database, STORAGE: {} as R2Bucket, SESSION_SIGNING_KEY: KEY } as never);

describe('GET /v1/auth/me (PAS-owned session verification)', () => {
  it('401s without a bearer token', async () => {
    const res = await app.request('/v1/auth/me', {}, env());
    expect(res.status).toBe(401);
  });

  it('401s on a token signed with a different key', async () => {
    const token = await mintSession({ sub: 'gh:1', login: 'x', roles: ['user'] }, 'wrong-key');
    const res = await app.request('/v1/auth/me', { headers: { Authorization: `Bearer ${token}` } }, env());
    expect(res.status).toBe(401);
  });

  it('returns the user for a valid PAS token', async () => {
    const token = await mintSession({ sub: 'gh:1', login: 'octocat', avatarUrl: 'a.png', roles: ['user', 'creator'] }, KEY);
    const res = await app.request('/v1/auth/me', { headers: { Authorization: `Bearer ${token}` } }, env());
    expect(res.status).toBe(200);
    const body = await res.json() as { id: string; login: string; roles: string[]; appRoles: Record<string, unknown> };
    expect(body.id).toBe('gh:1');
    expect(body.login).toBe('octocat');
    expect(body.roles).toEqual(['user', 'creator']);
    expect(body.appRoles).toEqual({});
  });
});

describe('auth provider start', () => {
  it('503s when the provider is not configured', async () => {
    const res = await app.request('/v1/auth/github/start?return_to=https://console.proappstore.online', {}, env());
    expect(res.status).toBe(503);
  });

  it('404s for an unknown provider', async () => {
    const res = await app.request('/v1/auth/twitter/start', {}, env());
    expect(res.status).toBe(404);
  });

  it('redirects to GitHub when configured, with our callback + state', async () => {
    const res = await app.request(
      '/v1/auth/github/start?return_to=https://console.proappstore.online/',
      {},
      { ...env(), GITHUB_CLIENT_ID: 'cid', APP_BASE: 'https://api.proappstore.online' } as never,
    );
    expect(res.status).toBe(302);
    const loc = new URL(res.headers.get('location')!);
    expect(loc.host).toBe('github.com');
    expect(loc.searchParams.get('client_id')).toBe('cid');
    expect(loc.searchParams.get('redirect_uri')).toBe('https://api.proappstore.online/v1/auth/github/callback');
    expect(loc.searchParams.get('state')).toBeTruthy();
  });

  it('rejects a return_to that is not a proappstore origin (open-redirect guard)', async () => {
    const res = await app.request(
      '/v1/auth/github/start?return_to=https://evil.com',
      {},
      { ...env(), GITHUB_CLIENT_ID: 'cid' } as never,
    );
    expect(res.status).toBe(400);
  });

  it('email sign-in returns 501 (not enabled)', async () => {
    const res = await app.request('/v1/auth/email/start', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }, env());
    expect(res.status).toBe(501);
  });
});

describe('auth callback — state decoding (base64url padding regression)', () => {
  const realFetch = globalThis.fetch;
  afterEach(() => { globalThis.fetch = realFetch; });

  it('decodes state of every length (no padding bug) → reaches profile, then bounces back with auth_error', async () => {
    // Token exchange fails → profile null → graceful 302 back to return_to with
    // #auth_error, NOT 400. A broken padding decode would drop return_to → 400.
    globalThis.fetch = vi.fn().mockResolvedValue(new Response('', { status: 400 }));
    // return_to lengths chosen so the state's base64url length hits each n%4 case.
    for (const path of ['/', '/a', '/ab', '/abc']) {
      const ret = `https://console.proappstore.online${path}`;
      const state = b64url(JSON.stringify({ r: ret, n: 'fixed-nonce' }));
      const res = await app.request(
        `/v1/auth/github/callback?code=x&state=${state}`,
        { headers: { Cookie: `pas_oauth_state=${state}` } }, // CSRF cookie matches
        env(),
      );
      expect(res.status, `path ${path} (state len ${state.length})`).toBe(302);
      const loc = res.headers.get('location')!;
      expect(loc.startsWith(ret)).toBe(true);
      expect(loc).toContain('auth_error=profile_fetch_failed');
    }
  });

  it('bounces back with auth_error when the provider denies consent', async () => {
    const ret = 'https://console.proappstore.online/';
    const state = b64url(JSON.stringify({ r: ret, n: 'x' }));
    const res = await app.request(
      `/v1/auth/github/callback?error=access_denied&state=${state}`,
      { headers: { Cookie: `pas_oauth_state=${state}` } },
      env(),
    );
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toContain('auth_error=access_denied');
  });

  it('400s on a state/cookie mismatch (login CSRF guard)', async () => {
    const state = b64url(JSON.stringify({ r: 'https://console.proappstore.online/', n: 'a' }));
    const res = await app.request(
      `/v1/auth/github/callback?code=x&state=${state}`,
      { headers: { Cookie: `pas_oauth_state=DIFFERENT` } },
      env(),
    );
    expect(res.status).toBe(400);
  });

  it('400s when no state cookie is present', async () => {
    const state = b64url(JSON.stringify({ r: 'https://console.proappstore.online/', n: 'a' }));
    const res = await app.request(`/v1/auth/github/callback?code=x&state=${state}`, {}, env());
    expect(res.status).toBe(400);
  });

  it('400s when state carries a disallowed return_to (even with a matching cookie)', async () => {
    const state = b64url(JSON.stringify({ r: 'https://evil.com', n: 'x' }));
    const res = await app.request(
      `/v1/auth/github/callback?code=x&state=${state}`,
      { headers: { Cookie: `pas_oauth_state=${state}` } },
      env(),
    );
    expect(res.status).toBe(400);
  });
});
