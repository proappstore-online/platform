import { describe, expect, it } from 'vitest';
import { appJwt, mintInstallationToken } from './github-app.ts';

// Generate a real RSA keypair so the JWT is signed + verified end-to-end —
// proving the RS256 path actually works, not just that it produces a string.
async function makeKeyPair(): Promise<{ pem: string; publicKey: CryptoKey }> {
  const pair = (await crypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true,
    ['sign', 'verify'],
  )) as CryptoKeyPair;
  const pkcs8 = new Uint8Array((await crypto.subtle.exportKey('pkcs8', pair.privateKey)) as ArrayBuffer);
  let bin = '';
  for (const b of pkcs8) bin += String.fromCharCode(b);
  const pem = `-----BEGIN PRIVATE KEY-----\n${btoa(bin).replace(/(.{64})/g, '$1\n')}\n-----END PRIVATE KEY-----\n`;
  return { pem, publicKey: pair.publicKey };
}

function b64urlToBytes(s: string): Uint8Array {
  let b64 = s.replace(/-/g, '+').replace(/_/g, '/');
  while (b64.length % 4) b64 += '=';
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

describe('appJwt', () => {
  it('produces a valid RS256 JWT with the right claims, verifiable by the public key', async () => {
    const { pem, publicKey } = await makeKeyPair();
    const now = 1_700_000_000;
    const jwt = await appJwt('123456', pem, now);

    const [header, payload, sig] = jwt.split('.') as [string, string, string];
    expect(JSON.parse(new TextDecoder().decode(b64urlToBytes(header)))).toEqual({ alg: 'RS256', typ: 'JWT' });

    const claims = JSON.parse(new TextDecoder().decode(b64urlToBytes(payload)));
    expect(claims.iss).toBe('123456');
    expect(claims.iat).toBe(now - 60); // backdated for skew
    expect(claims.exp).toBe(now + 540); // < 10 min, GitHub's max

    const valid = await crypto.subtle.verify(
      'RSASSA-PKCS1-v1_5',
      publicKey,
      b64urlToBytes(sig),
      new TextEncoder().encode(`${header}.${payload}`),
    );
    expect(valid).toBe(true);
  });
});

describe('mintInstallationToken', () => {
  it('exchanges the JWT for a repo-scoped, contents:read token', async () => {
    const { pem } = await makeKeyPair();
    let captured: { url: string; body: unknown; auth: string | null } | undefined;
    const fakeFetch = (async (url: string | URL | Request, init?: RequestInit) => {
      captured = {
        url: String(url),
        body: JSON.parse(String(init?.body)),
        auth: new Headers(init?.headers).get('Authorization'),
      };
      return new Response(JSON.stringify({ token: 'ghs_installation' }), { status: 201 });
    }) as typeof fetch;

    const token = await mintInstallationToken({ appId: '123456', privateKeyPem: pem }, 42, 'clean-up', 1_700_000_000, fakeFetch);

    expect(token).toBe('ghs_installation');
    expect(captured?.url).toBe('https://api.github.com/app/installations/42/access_tokens');
    expect(captured?.body).toEqual({ repositories: ['clean-up'], permissions: { contents: 'read' } });
    expect(captured?.auth?.startsWith('Bearer ')).toBe(true);
  });

  it('throws on a non-ok exchange', async () => {
    const { pem } = await makeKeyPair();
    const fakeFetch = (async () => new Response('bad', { status: 403 })) as typeof fetch;
    await expect(
      mintInstallationToken({ appId: '1', privateKeyPem: pem }, 1, 'r', 1_700_000_000, fakeFetch),
    ).rejects.toThrow(/403/);
  });
});
