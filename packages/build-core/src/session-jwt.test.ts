import { describe, it, expect } from 'vitest';
import { mintSession, verifySession } from './session-jwt.js';

const KEY = 'test-signing-key-please-change';
const base = { uid: 'gh:1234', login: 'octocat', avatarUrl: 'https://x/y.png', roles: ['user', 'creator'] };

/** Independent re-implementation of FAS's verifySession (2-part body.sig) to
 *  prove PAS tokens verify on the shared free-tier services. */
async function fasVerify(token: string, key: string): Promise<{ uid: string } | null> {
  const dot = token.lastIndexOf('.');
  if (dot < 0) return null;
  const body = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const k = await crypto.subtle.importKey('raw', new TextEncoder().encode(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const raw = await crypto.subtle.sign('HMAC', k, new TextEncoder().encode(body));
  let bin = ''; for (const b of new Uint8Array(raw)) bin += String.fromCharCode(b);
  const expected = btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  if (sig !== expected) return null;
  const padded = body.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((body.length + 3) % 4);
  return JSON.parse(atob(padded));
}

describe('session-jwt (FAS-compatible)', () => {
  it('mints a 2-part body.sig token and verifies it round-trip', async () => {
    const token = await mintSession(base, KEY);
    expect(token.split('.')).toHaveLength(2);
    const claims = await verifySession(token, KEY);
    expect(claims!.uid).toBe('gh:1234');
    expect(claims!.login).toBe('octocat');
    expect(claims!.roles).toEqual(['user', 'creator']);
    expect(claims!.exp).toBeGreaterThan(claims!.iat);
  });

  it('produces tokens a FAS-format verifier accepts (cross-compat with kv/rooms)', async () => {
    const token = await mintSession(base, KEY);
    const fas = await fasVerify(token, KEY);
    expect(fas).not.toBeNull();
    expect(fas!.uid).toBe('gh:1234'); // FAS reads uid; ignores login/avatarUrl
  });

  it('handles UTF-8 in claims', async () => {
    const token = await mintSession({ ...base, login: 'José🚀' }, KEY);
    expect((await verifySession(token, KEY))!.login).toBe('José🚀');
  });

  it('rejects a token signed with a different key', async () => {
    expect(await verifySession(await mintSession(base, KEY), 'other')).toBeNull();
  });

  it('rejects a tampered payload', async () => {
    const token = await mintSession(base, KEY);
    const sig = token.slice(token.lastIndexOf('.') + 1);
    const forged = btoa(JSON.stringify({ uid: 'gh:1', roles: ['admin'], iat: 1, exp: 9999999999 }))
      .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    expect(await verifySession(`${forged}.${sig}`, KEY)).toBeNull();
  });

  it('rejects an expired token', async () => {
    expect(await verifySession(await mintSession(base, KEY, -10), KEY)).toBeNull();
  });

  it('rejects malformed tokens', async () => {
    expect(await verifySession('not-a-token', KEY)).toBeNull();
    expect(await verifySession('', KEY)).toBeNull();
  });

  it('defaults roles/appRoles', async () => {
    const claims = await verifySession(await mintSession({ uid: 'x', roles: [] }, KEY), KEY);
    expect(claims!.roles).toEqual([]);
    expect(claims!.appRoles).toEqual({});
  });
});
