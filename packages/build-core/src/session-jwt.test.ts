import { describe, it, expect } from 'vitest';
import { mintSession, verifySession } from './session-jwt.js';

const KEY = 'test-signing-key-please-change';
const base = { sub: 'gh:1234', login: 'octocat', avatarUrl: 'https://x/y.png', roles: ['user', 'creator'] };

describe('session-jwt', () => {
  it('mints + verifies a token round-trip', async () => {
    const token = await mintSession(base, KEY);
    expect(token.split('.')).toHaveLength(3);
    const claims = await verifySession(token, KEY);
    expect(claims).not.toBeNull();
    expect(claims!.sub).toBe('gh:1234');
    expect(claims!.login).toBe('octocat');
    expect(claims!.roles).toEqual(['user', 'creator']);
    expect(claims!.iss).toBe('proappstore');
    expect(claims!.exp).toBeGreaterThan(claims!.iat);
  });

  it('handles UTF-8 in claims', async () => {
    const token = await mintSession({ ...base, login: 'José🚀' }, KEY);
    const claims = await verifySession(token, KEY);
    expect(claims!.login).toBe('José🚀');
  });

  it('rejects a token signed with a different key', async () => {
    const token = await mintSession(base, KEY);
    expect(await verifySession(token, 'other-key')).toBeNull();
  });

  it('rejects a tampered payload', async () => {
    const token = await mintSession(base, KEY);
    const [h, , s] = token.split('.');
    const forged = btoa(JSON.stringify({ ...base, roles: ['admin'], iat: 1, exp: 9999999999, iss: 'proappstore' }))
      .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    expect(await verifySession(`${h}.${forged}.${s}`, KEY)).toBeNull();
  });

  it('rejects an expired token', async () => {
    const token = await mintSession(base, KEY, -10); // already expired
    expect(await verifySession(token, KEY)).toBeNull();
  });

  it('rejects malformed tokens', async () => {
    expect(await verifySession('not-a-jwt', KEY)).toBeNull();
    expect(await verifySession('a.b', KEY)).toBeNull();
    expect(await verifySession('', KEY)).toBeNull();
  });

  it('defaults roles/appRoles when minted without them', async () => {
    const token = await mintSession({ sub: 'x', login: 'x', roles: [] }, KEY);
    const claims = await verifySession(token, KEY);
    expect(claims!.roles).toEqual([]);
    expect(claims!.appRoles).toEqual({});
  });
});
