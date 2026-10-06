import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { requireAppDeployOidc } from './app-deploy-oidc.js';
import { HttpError } from './auth.js';
import { _resetJwksCache } from './github-oidc.js';

// #253: the keyless app-deploy check — the token must be a genuine GitHub
// Actions OIDC token from proappstore-online/<appId> on refs/heads/main.

const ISSUER = 'https://token.actions.githubusercontent.com';
let priv: CryptoKey;
let jwk: JsonWebKey;
const b64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const b64urlJson = (o: unknown) => b64url(new TextEncoder().encode(JSON.stringify(o)));

async function token(repository: string, ref = 'refs/heads/main', aud = 'https://api.proappstore.online'): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const header = b64urlJson({ alg: 'RS256', typ: 'JWT', kid: 'k1' });
  const payload = b64urlJson({ iss: ISSUER, aud, sub: 'x', repository, repository_owner: 'proappstore-online', ref, sha: 'cafe', iat: now, nbf: now, exp: now + 300 });
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', priv, new TextEncoder().encode(`${header}.${payload}`));
  return `${header}.${payload}.${b64url(new Uint8Array(sig))}`;
}

const app = new Hono();
app.get('/:appId', async (c) => {
  try {
    const claims = await requireAppDeployOidc(c as never, c.req.param('appId'));
    return c.json({ repository: claims.repository });
  } catch (e) {
    return c.json({ error: (e as Error).message }, (e as HttpError).status as 400);
  }
});
const call = (appId: string, bearer?: string) => app.request(`/${appId}`, bearer ? { headers: { Authorization: `Bearer ${bearer}` } } : {});

beforeEach(async () => {
  _resetJwksCache();
  const pair = await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']);
  priv = pair.privateKey;
  jwk = { ...(await crypto.subtle.exportKey('jwk', pair.publicKey)), kid: 'k1', alg: 'RS256', use: 'sig' };
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ keys: [jwk] }), { status: 200 })));
});
afterEach(() => vi.unstubAllGlobals());

describe('requireAppDeployOidc (#253)', () => {
  it("accepts the app's own repo on main", async () => {
    const res = await call('demo', await token('proappstore-online/demo'));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ repository: 'proappstore-online/demo' });
  });

  it('refuses a bad app id, no token, a forged token, another repo, another ref and another audience', async () => {
    expect((await call('Demo!', await token('proappstore-online/demo'))).status).toBe(400);
    expect((await call('demo')).status).toBe(401);
    expect((await call('demo', 'not.a.jwt')).status).toBe(401);
    expect((await call('demo', await token('proappstore-online/other'))).status).toBe(403);
    expect((await call('demo', await token('proappstore-online/demo', 'refs/heads/feature'))).status).toBe(403);
    expect((await call('demo', await token('proappstore-online/demo', 'refs/heads/main', 'https://evil.example'))).status).toBe(401);
  });
});
