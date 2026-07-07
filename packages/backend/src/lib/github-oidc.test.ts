import { describe, expect, it, beforeEach } from 'vitest';
import { verifyGithubOidc, _resetJwksCache, type OidcClaims } from './github-oidc.js';

const ISSUER = 'https://token.actions.githubusercontent.com';
const AUD = 'https://api.proappstore.online';
const KID = 'test-key-1';

function b64url(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function b64urlJson(obj: unknown): string {
  return b64url(new TextEncoder().encode(JSON.stringify(obj)));
}

async function makeKey() {
  const pair = await crypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true,
    ['sign', 'verify'],
  );
  const jwk = (await crypto.subtle.exportKey('jwk', pair.publicKey)) as JsonWebKey;
  return { priv: pair.privateKey, jwk: { ...jwk, kid: KID, alg: 'RS256', use: 'sig' } };
}

async function signToken(priv: CryptoKey, claims: Partial<OidcClaims>, kid = KID): Promise<string> {
  const header = b64urlJson({ alg: 'RS256', typ: 'JWT', kid });
  const now = Math.floor(Date.now() / 1000);
  const payload = b64urlJson({
    iss: ISSUER, aud: AUD, sub: 'repo:proappstore-online/aiuniversity:ref:refs/heads/main',
    repository: 'proappstore-online/aiuniversity', repository_owner: 'proappstore-online',
    ref: 'refs/heads/main', sha: 'abc123', iat: now, nbf: now, exp: now + 300, ...claims,
  });
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', priv, new TextEncoder().encode(`${header}.${payload}`));
  return `${header}.${payload}.${b64url(new Uint8Array(sig))}`;
}

describe('verifyGithubOidc', () => {
  let priv: CryptoKey;
  let jwk: JsonWebKey;
  let fetchImpl: typeof fetch;

  beforeEach(async () => {
    _resetJwksCache();
    const k = await makeKey();
    priv = k.priv; jwk = k.jwk;
    fetchImpl = (async () => new Response(JSON.stringify({ keys: [jwk] }), { status: 200 })) as unknown as typeof fetch;
  });

  it('verifies a valid token and returns claims', async () => {
    const token = await signToken(priv, {});
    const claims = await verifyGithubOidc(token, { audience: AUD, fetchImpl });
    expect(claims.repository).toBe('proappstore-online/aiuniversity');
    expect(claims.repository_owner).toBe('proappstore-online');
  });

  it('rejects a wrong audience', async () => {
    const token = await signToken(priv, { aud: 'https://evil.example' });
    await expect(verifyGithubOidc(token, { audience: AUD, fetchImpl })).rejects.toThrow(/audience/);
  });

  it('rejects an expired token', async () => {
    const now = Math.floor(Date.now() / 1000);
    const token = await signToken(priv, { exp: now - 10, iat: now - 400, nbf: now - 400 });
    await expect(verifyGithubOidc(token, { audience: AUD, fetchImpl })).rejects.toThrow(/expired/);
  });

  it('rejects a bad issuer', async () => {
    const token = await signToken(priv, { iss: 'https://evil.example' });
    await expect(verifyGithubOidc(token, { audience: AUD, fetchImpl })).rejects.toThrow(/issuer/);
  });

  it('rejects a tampered signature', async () => {
    const token = await signToken(priv, {});
    const parts = token.split('.');
    const forged = `${parts[0]}.${b64urlJson({ iss: ISSUER, aud: AUD, repository: 'evil/repo', repository_owner: 'evil', exp: Math.floor(Date.now() / 1000) + 300 })}.${parts[2]}`;
    await expect(verifyGithubOidc(forged, { audience: AUD, fetchImpl })).rejects.toThrow(/signature/);
  });

  it('rejects when the signing key is not in JWKS', async () => {
    const token = await signToken(priv, {}, 'unknown-kid');
    await expect(verifyGithubOidc(token, { audience: AUD, fetchImpl })).rejects.toThrow(/signing key/);
  });

  it('refetches JWKS once when the kid is missing (key rotation)', async () => {
    // First fetch returns a stale JWKS without our key; the forced refetch has it.
    let calls = 0;
    const staleKey = { ...jwk, kid: 'old-rotated-key' };
    const rotating = (async () => {
      calls += 1;
      const keys = calls === 1 ? [staleKey] : [jwk]; // stale JWKS lacks our kid
      return new Response(JSON.stringify({ keys }), { status: 200 });
    }) as unknown as typeof fetch;
    const token = await signToken(priv, {});
    const claims = await verifyGithubOidc(token, { audience: AUD, fetchImpl: rotating });
    expect(claims.repository).toBe('proappstore-online/aiuniversity');
    expect(calls).toBe(2); // proves the refetch-on-miss happened
  });

  it('rejects a non-RS256 alg', async () => {
    const header = b64urlJson({ alg: 'none', typ: 'JWT', kid: KID });
    const payload = b64urlJson({ iss: ISSUER, aud: AUD, repository: 'x/y', repository_owner: 'x', exp: 9999999999 });
    await expect(verifyGithubOidc(`${header}.${payload}.`, { audience: AUD, fetchImpl })).rejects.toThrow(/alg/);
  });
});
