import { describe, expect, it, vi } from 'vitest';
import { mockStmt } from '../test-helpers.js';
import {
  LAST_USED_THROTTLE_MS,
  MAX_TTL_APP_ORIGIN_SECONDS,
  MAX_TTL_FIRST_PARTY_SECONDS,
  TOKEN_PREFIX,
  looksLikeAppToken,
  mintTokenId,
  mintTokenString,
  parseScopes,
  rememberTokenUser,
  sha256Hex,
  tokenUserFor,
  touchLastUsed,
  verifyAppToken,
} from './app-tokens.js';

function mockD1(...stmts: ReturnType<typeof mockStmt>[]) {
  const prepare = vi.fn();
  for (const stmt of stmts) prepare.mockReturnValueOnce(stmt);
  prepare.mockReturnValue(mockStmt());
  return { prepare } as unknown as D1Database & { prepare: ReturnType<typeof vi.fn> };
}

const NOW = 1_700_000_000_000;
const row = (o: Record<string, unknown> = {}) => ({ token_id: 'a'.repeat(32), user_id: 'gh:7', app_id: 'leads', scopes: '{"access":"read","actions":null}', expires_at: NOW + 1000, revoked_at: null, ...o });

describe('app tokens (#154)', () => {
  it('mints recognisable, high-entropy tokens and separate random ids', async () => {
    const t = mintTokenString();
    expect(t.startsWith(TOKEN_PREFIX)).toBe(true);
    expect(t).toMatch(/^pas_at_[a-f0-9]{40}$/);
    expect(mintTokenString()).not.toBe(t);
    expect(mintTokenId()).toMatch(/^[a-f0-9]{32}$/);
    expect(looksLikeAppToken(t)).toBe(true);
    expect(looksLikeAppToken('eyJhbGciOi')).toBe(false);
    expect(await sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    expect(MAX_TTL_APP_ORIGIN_SECONDS).toBe(90 * 86_400);
    expect(MAX_TTL_FIRST_PARTY_SECONDS).toBe(365 * 86_400);
  });

  it('verifies a live token: identity from the row, login from users, roles fixed to user', async () => {
    const db = mockD1(mockStmt({ first: row() }), mockStmt({ first: { login: 'octo', avatar_url: null } }));
    const v = await verifyAppToken(db, 'leads', 'pas_at_x', NOW);
    expect(v.user).toEqual({ id: 'gh:7', login: 'octo', avatarUrl: null, roles: ['user'] });
    expect(v.scopes).toEqual({ access: 'read', actions: null });
    expect(v.tokenHash).toBe(await sha256Hex('pas_at_x'));
    expect(v.tokenId).toBe('a'.repeat(32));
  });

  it('falls back to the id as login when the users row is missing', async () => {
    const db = mockD1(mockStmt({ first: row() }), mockStmt({ first: null }));
    expect((await verifyAppToken(db, 'leads', 'pas_at_x', NOW)).user.login).toBe('gh:7');
  });

  it('401 for another app, a revoked token, an expired token, an unknown token', async () => {
    for (const r of [row({ app_id: 'crm' }), row({ revoked_at: NOW - 1 }), row({ expires_at: NOW }), null]) {
      await expect(verifyAppToken(mockD1(mockStmt({ first: r })), 'leads', 'pas_at_x', NOW)).rejects.toMatchObject({ status: 401 });
    }
  });

  it('parses scopes defensively and throttles last_used_at to one write a minute', async () => {
    expect(parseScopes('{"access":"write","actions":["a","b"]}')).toEqual({ access: 'write', actions: ['a', 'b'] });
    expect(parseScopes('{}')).toEqual({ access: 'read', actions: null });
    const stmt = mockStmt();
    const db = mockD1(stmt);
    await touchLastUsed(db, 'h', NOW);
    expect(db.prepare.mock.calls[0]![0]).toContain('last_used_at < ?1 - ?3');
    expect(stmt.bind).toHaveBeenCalledWith(NOW, 'h', LAST_USED_THROTTLE_MS);
    const failing = { prepare: () => { throw new Error('boom'); } } as unknown as D1Database;
    await expect(touchLastUsed(failing, 'h', NOW)).resolves.toBeUndefined();
  });

  it('remembers the token user per request for the failure log', () => {
    const req = new Request('https://api.example/x');
    expect(tokenUserFor(req)).toBeNull();
    rememberTokenUser(req, 'gh:7');
    expect(tokenUserFor(req)).toBe('gh:7');
    expect(tokenUserFor(new Request('https://api.example/y'))).toBeNull();
  });
});
