import { describe, expect, it } from 'vitest';
import { app } from '../index.js';
import { mintSession } from '@proappstore/build-core';

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
