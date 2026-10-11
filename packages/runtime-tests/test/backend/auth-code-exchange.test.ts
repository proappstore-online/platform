import { env as testEnv } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import type { Env } from '../../../backend/src/types';
import { redeemExchangeCode } from '../../../backend/src/routes/auth';

const env = testEnv as unknown as Env;

// #303 L7 on real D1: a one-time login code is read and consumed by one
// DELETE … RETURNING, so concurrent redemptions cannot both mint a session.

/** The endpoint's own storage form: SHA-256, base64url. */
async function hash(code: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(code)));
  return btoa(String.fromCharCode(...digest)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
async function issue(code: string, expiresAt: number) {
  await env.DB.prepare('INSERT INTO auth_exchange_codes (code_hash, claims, expires_at, created_at) VALUES (?, ?, ?, ?)')
    .bind(await hash(code), JSON.stringify({ uid: 'gh:1', login: 'alice', avatarUrl: null, roles: ['user'] }), expiresAt, Date.now()).run();
}
const remaining = async () => (await env.DB.prepare('SELECT COUNT(*) AS n FROM auth_exchange_codes').first<{ n: number }>())!.n;

beforeEach(async () => { await env.DB.prepare('DELETE FROM auth_exchange_codes').run(); });

describe('one-time login code exchange (#303 L7)', () => {
  it('three concurrent redemptions of one code mint exactly one session', async () => {
    await issue('race-code', Date.now() + 60_000);
    const tokens = await Promise.all([1, 2, 3].map(() => redeemExchangeCode(env, 'race-code')));
    expect(tokens.filter((t) => typeof t === 'string')).toHaveLength(1);
    expect(await remaining()).toBe(0);
  });

  it('an expired code is refused and consumed; an unknown code changes nothing', async () => {
    await issue('old-code', Date.now() - 1);
    await issue('other-code', Date.now() + 60_000);
    expect(await redeemExchangeCode(env, 'old-code')).toBeNull();
    expect(await redeemExchangeCode(env, 'never-issued')).toBeNull();
    expect(await remaining()).toBe(1); // only the untouched other code
  });
});
