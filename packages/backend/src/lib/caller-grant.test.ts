import { describe, expect, it } from 'vitest';
import { CALLER_GRANT_TTL_SECONDS, grantInvocation, mintCallerGrant, verifyCallerGrant } from './caller-grant.js';

// #260 (ADR-009 §3): a caller grant names one user for one app for 30 s; its
// signature covers the app, so it cannot be replayed into another app's envelope.
// #318: it also covers the envelope it was minted for, and verifies only for that
// invocation (`<event_id>:<attempt>`).

const env = { SESSION_SIGNING_KEY: 'test-signing-key' };
const user = { id: 'gh:42', roles: ['user'] };
const NOW = 1_800_000_000;
const EVENT = { id: 'evt-http-1', attempt: 1 };
const INV = 'evt-http-1:1';

describe('caller grants (#260, #318)', () => {
  it('mints a grant that verifies for its app, its invocation and its user, until it expires', async () => {
    const g = await mintCallerGrant(env, 't', user, EVENT, NOW);
    expect(g).toMatchObject({ event_id: 'evt-http-1', attempt: 1, user_id: 'gh:42', roles: ['user'], exp: NOW + CALLER_GRANT_TTL_SECONDS });
    expect(grantInvocation(g)).toBe(INV);
    expect(g.sig).toMatch(/^[0-9a-f]{64}$/);
    expect(await verifyCallerGrant(env, 't', g, INV, NOW + 29)).toEqual(user);
  });

  it('#318: refuses it from any other invocation — another event, another attempt, a malformed id', async () => {
    const g = await mintCallerGrant(env, 't', user, EVENT, NOW);
    for (const inv of ['evt-schedule-9:1', 'evt-hook-3:1', 'evt-other-request:1', 'evt-http-1:2', 'evt-http-1:0', 'evt-http-1', '', 'evt-http-1:1 ']) {
      expect(await verifyCallerGrant(env, 't', g, inv, NOW), inv).toBeNull();
    }
  });

  it('refuses it 31 s later, for another app, under another key, or tampered with — the binding included', async () => {
    const g = await mintCallerGrant(env, 't', user, EVENT, NOW);
    expect(await verifyCallerGrant(env, 't', g, INV, NOW + 31)).toBeNull();
    expect(await verifyCallerGrant(env, 't', g, INV, NOW + CALLER_GRANT_TTL_SECONDS)).toBeNull();
    expect(await verifyCallerGrant(env, 'u', g, INV, NOW)).toBeNull();
    expect(await verifyCallerGrant({ SESSION_SIGNING_KEY: 'other' }, 't', g, INV, NOW)).toBeNull();
    const tampers = [
      { ...g, user_id: 'gh:1' }, { ...g, roles: ['user', 'admin'] }, { ...g, exp: g.exp + 600 }, { ...g, grant_id: 'x' },
      { ...g, sig: g.sig.replace(/.$/, (c) => (c === '0' ? '1' : '0')) },
      // Re-pointing a grant at another running invocation needs a new signature, which the worker cannot make.
      { ...g, event_id: 'evt-schedule-9' }, { ...g, attempt: 2 },
    ];
    for (const tampered of tampers) {
      expect(await verifyCallerGrant(env, 't', tampered, grantInvocation(tampered), NOW), JSON.stringify(tampered)).toBeNull();
    }
  });

  it('refuses malformed grants, and pre-#318 grants without a binding, without throwing', async () => {
    const legacy = { grant_id: 'g', user_id: 'u', roles: [], exp: NOW + 10, sig: 'x' };
    for (const raw of [null, 'grant', {}, legacy, { ...legacy, user_id: '' }, { ...legacy, roles: [1] }, { ...legacy, exp: '9' },
      { ...legacy, event_id: '', attempt: 1 }, { ...legacy, event_id: 'e', attempt: 0 }, { ...legacy, event_id: 'e', attempt: 1.5 }, { ...legacy, event_id: 'e', attempt: '1' }]) {
      expect(await verifyCallerGrant(env, 't', raw, INV, NOW), JSON.stringify(raw)).toBeNull();
    }
  });

  it('is signed with a derived key, not the session key itself', async () => {
    const g = await mintCallerGrant(env, 't', user, EVENT, NOW);
    const raw = await crypto.subtle.importKey('raw', new TextEncoder().encode(env.SESSION_SIGNING_KEY), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const text = JSON.stringify(['v2', 't', g.grant_id, g.event_id, g.attempt, g.user_id, g.roles, g.exp]);
    const direct = [...new Uint8Array(await crypto.subtle.sign('HMAC', raw, new TextEncoder().encode(text)))].map((b) => b.toString(16).padStart(2, '0')).join('');
    expect(g.sig).not.toBe(direct);
  });

  it('cannot be minted without a session signing key', async () => {
    await expect(mintCallerGrant({ SESSION_SIGNING_KEY: '' }, 't', user, EVENT, NOW)).rejects.toThrow(/SESSION_SIGNING_KEY/);
  });
});
