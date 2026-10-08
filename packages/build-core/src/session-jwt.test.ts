import { afterEach, describe, it, expect, vi } from 'vitest';
import { mintSession, verifySession } from './session-jwt.js';

const KEY = 'test-signing-key-please-change';
const base = { uid: 'gh:1234', login: 'octocat', avatarUrl: 'https://x/y.png', roles: ['user', 'creator'] };

/** Independent HMAC verifier to prove the token format is correct. */
async function independentVerify(token: string, key: string): Promise<{ uid: string } | null> {
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

describe('session-jwt', () => {
  it('mints a 2-part body.sig token and verifies it round-trip', async () => {
    const token = await mintSession(base, KEY);
    expect(token.split('.')).toHaveLength(2);
    const claims = await verifySession(token, KEY);
    expect(claims!.uid).toBe('gh:1234');
    expect(claims!.login).toBe('octocat');
    expect(claims!.roles).toEqual(['user', 'creator']);
    expect(claims!.exp).toBeGreaterThan(claims!.iat);
  });

  it('produces tokens an independent HMAC verifier accepts', async () => {
    const token = await mintSession(base, KEY);
    const result = await independentVerify(token, KEY);
    expect(result).not.toBeNull();
    expect(result!.uid).toBe('gh:1234');
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

  it('defaults roles', async () => {
    const claims = await verifySession(await mintSession({ uid: 'x', roles: [] }, KEY), KEY);
    expect(claims!.roles).toEqual([]);
  });
});

// #230/#331: auth_time / auth_method record the last active authentication, and a
// privileged session can be minted with a short life.
describe('session auth_time, auth_method and short TTL (#230)', () => {
  afterEach(() => vi.useRealTimers());

  it('carries auth_time, auth_method and a passkey relying-party audience through mint and verify', async () => {
    const claims = await verifySession(await mintSession({ ...base, auth_time: 1_700_000_000, auth_method: 'passkey', step_up_rp_id: 'app.proappstore.online' }, KEY), KEY);
    expect(claims).toMatchObject({ auth_time: 1_700_000_000, auth_method: 'passkey', step_up_rp_id: 'app.proappstore.online' });
  });

  it('leaves them absent on sessions minted without them (pre-#230 tokens stay valid)', async () => {
    const claims = await verifySession(await mintSession(base, KEY), KEY);
    expect(claims).not.toBeNull();
    expect(claims!.auth_time).toBeUndefined();
    expect(claims!.auth_method).toBeUndefined();
  });

  it('a short-TTL session is valid until its exp and rejected one second after', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-27T12:00:00Z'));
    const token = await mintSession({ ...base, auth_time: Math.floor(Date.now() / 1000), auth_method: 'passkey' }, KEY, 3600);
    const claims = await verifySession(token, KEY);
    expect(claims!.exp - claims!.iat).toBe(3600);

    vi.setSystemTime(new Date('2026-09-27T13:00:00Z'));
    expect(await verifySession(token, KEY)).not.toBeNull();
    vi.setSystemTime(new Date('2026-09-27T13:00:01Z'));
    expect(await verifySession(token, KEY)).toBeNull();
  });

  it('the default TTL is unchanged at 30 days', async () => {
    const claims = await verifySession(await mintSession(base, KEY), KEY);
    expect(claims!.exp - claims!.iat).toBe(30 * 24 * 60 * 60);
  });
});
