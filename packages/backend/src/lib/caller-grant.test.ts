import { describe, expect, it } from 'vitest';
import { CALLER_GRANT_TTL_SECONDS, mintCallerGrant, verifyCallerGrant } from './caller-grant.js';

// #260 (ADR-009 §3): a caller grant names one user for one app for 30 s; its
// signature covers the app, so it cannot be replayed into another app's envelope.

const env = { SESSION_SIGNING_KEY: 'test-signing-key' };
const user = { id: 'gh:42', roles: ['user'] };
const NOW = 1_800_000_000;

describe('caller grants (#260)', () => {
  it('mints a grant that verifies for its app, to its user, until it expires', async () => {
    const g = await mintCallerGrant(env, 't', user, NOW);
    expect(g).toMatchObject({ user_id: 'gh:42', roles: ['user'], exp: NOW + CALLER_GRANT_TTL_SECONDS });
    expect(g.sig).toMatch(/^[0-9a-f]{64}$/);
    expect(await verifyCallerGrant(env, 't', g, NOW + 29)).toEqual(user);
  });

  it('refuses it 31 s later, for another app, under another key, or tampered with', async () => {
    const g = await mintCallerGrant(env, 't', user, NOW);
    expect(await verifyCallerGrant(env, 't', g, NOW + 31)).toBeNull();
    expect(await verifyCallerGrant(env, 't', g, NOW + CALLER_GRANT_TTL_SECONDS)).toBeNull();
    expect(await verifyCallerGrant(env, 'u', g, NOW)).toBeNull();
    expect(await verifyCallerGrant({ SESSION_SIGNING_KEY: 'other' }, 't', g, NOW)).toBeNull();
    for (const tampered of [{ ...g, user_id: 'gh:1' }, { ...g, roles: ['user', 'admin'] }, { ...g, exp: g.exp + 600 }, { ...g, grant_id: 'x' }, { ...g, sig: g.sig.replace(/.$/, (c) => (c === '0' ? '1' : '0')) }]) {
      expect(await verifyCallerGrant(env, 't', tampered, NOW), JSON.stringify(tampered)).toBeNull();
    }
  });

  it('refuses malformed grants without throwing', async () => {
    for (const raw of [null, 'grant', {}, { grant_id: 'g', user_id: '', roles: [], exp: NOW + 10, sig: 'x' }, { grant_id: 'g', user_id: 'u', roles: [1], exp: NOW + 10, sig: 'x' }, { grant_id: 'g', user_id: 'u', roles: [], exp: '9', sig: 'x' }]) {
      expect(await verifyCallerGrant(env, 't', raw, NOW), JSON.stringify(raw)).toBeNull();
    }
  });

  it('is signed with a derived key, not the session key itself', async () => {
    const g = await mintCallerGrant(env, 't', user, NOW);
    const raw = await crypto.subtle.importKey('raw', new TextEncoder().encode(env.SESSION_SIGNING_KEY), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const direct = [...new Uint8Array(await crypto.subtle.sign('HMAC', raw, new TextEncoder().encode(JSON.stringify(['t', g.grant_id, g.user_id, g.roles, g.exp]))))]
      .map((b) => b.toString(16).padStart(2, '0')).join('');
    expect(g.sig).not.toBe(direct);
  });

  it('cannot be minted without a session signing key', async () => {
    await expect(mintCallerGrant({ SESSION_SIGNING_KEY: '' }, 't', user, NOW)).rejects.toThrow(/SESSION_SIGNING_KEY/);
  });
});
