import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { deployRoutes } from './deploy.js';
import { _resetJwksCache } from '../lib/github-oidc.js';

const ISSUER = 'https://token.actions.githubusercontent.com';
const AUD = 'https://api.proappstore.online';
const KID = 'test-key-1';
const ACCOUNT = 'c1089bfcc43c1c6c2aa89e584e86f0bc';

function b64url(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
const b64urlJson = (o: unknown) => b64url(new TextEncoder().encode(JSON.stringify(o)));

let priv: CryptoKey;
let jwk: JsonWebKey;

async function makeKey() {
  const pair = await crypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true, ['sign', 'verify'],
  );
  jwk = { ...(await crypto.subtle.exportKey('jwk', pair.publicKey)), kid: KID, alg: 'RS256', use: 'sig' };
  priv = pair.privateKey;
}

async function signToken(repository = 'proappstore-online/aiuniversity', ref = 'refs/heads/main'): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const header = b64urlJson({ alg: 'RS256', typ: 'JWT', kid: KID });
  const payload = b64urlJson({
    iss: ISSUER, aud: AUD, repository, repository_owner: repository.split('/')[0],
    ref, sha: 'deadbeef', iat: now, nbf: now, exp: now + 300,
  });
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', priv, new TextEncoder().encode(`${header}.${payload}`));
  return `${header}.${payload}.${b64url(new Uint8Array(sig))}`;
}

let auditRows: unknown[][];
const mockDB = {
  prepare: (sql: string) => ({
    bind: (...args: unknown[]) => ({
      run: async () => {
        if (sql.includes('deploy_audit')) auditRows.push(args);
        return { success: true };
      },
    }),
  }),
};
const ENV = { CF_API_TOKEN: 'cf-token', CF_ACCOUNT_ID: ACCOUNT, R2_PARENT_ACCESS_KEY_ID: 'parent-key-id', DB: mockDB } as never;

describe('POST /apps/:appId/deploy-credentials', () => {
  beforeEach(async () => {
    _resetJwksCache();
    auditRows = [];
    await makeKey();
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/.well-known/jwks')) {
        return new Response(JSON.stringify({ keys: [jwk] }), { status: 200 });
      }
      if (url.includes('/r2/temp-access-credentials')) {
        return new Response(JSON.stringify({
          success: true,
          result: { accessKeyId: 'AKIA_TMP', secretAccessKey: 'secret_tmp', sessionToken: 'session_tmp' },
        }), { status: 200 });
      }
      throw new Error(`unexpected fetch: ${url}`);
    }));
  });
  afterEach(() => vi.unstubAllGlobals());

  const call = (appId: string, headers: Record<string, string> = {}) =>
    deployRoutes.request(`/apps/${appId}/deploy-credentials`, { method: 'POST', headers }, ENV);

  it('mints scoped creds for a valid OIDC token', async () => {
    const res = await call('aiuniversity', { Authorization: `Bearer ${await signToken()}` });
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body.accessKeyId).toBe('AKIA_TMP');
    expect(body.sessionToken).toBe('session_tmp');
    expect(body.prefix).toBe('apps/aiuniversity/');
    expect(body.endpoint).toBe(`https://${ACCOUNT}.r2.cloudflarestorage.com`);
    // the CF request must be scoped to this app's prefix only
    const cfCall = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls
      .find((c) => String(c[0]).includes('temp-access-credentials'));
    expect(JSON.parse((cfCall![1] as RequestInit).body as string).prefixes).toEqual(['apps/aiuniversity/']);
    // the mint is audited: one row bound with (app_id, repository, ref, ...)
    expect(auditRows).toHaveLength(1);
    expect(auditRows[0]!.slice(0, 3)).toEqual(['aiuniversity', 'proappstore-online/aiuniversity', 'refs/heads/main']);
  });

  it('401 when no token', async () => {
    expect((await call('aiuniversity')).status).toBe(401);
  });

  it('401 on an unverifiable token', async () => {
    expect((await call('aiuniversity', { Authorization: 'Bearer not.a.jwt' })).status).toBe(401);
  });

  it('403 when the OIDC repo does not match the app id', async () => {
    const res = await call('aiuniversity', { Authorization: `Bearer ${await signToken('proappstore-online/other-app')}` });
    expect(res.status).toBe(403);
  });

  it('403 when the repo is in a different owner', async () => {
    const res = await call('aiuniversity', { Authorization: `Bearer ${await signToken('attacker/aiuniversity')}` });
    expect(res.status).toBe(403);
  });

  it('403 when the deploy is not from the main branch', async () => {
    const res = await call('aiuniversity', {
      Authorization: `Bearer ${await signToken('proappstore-online/aiuniversity', 'refs/heads/dev')}`,
    });
    expect(res.status).toBe(403);
  });

  it('400 on an invalid app id', async () => {
    const res = await call('Bad_ID', { Authorization: `Bearer ${await signToken()}` });
    expect(res.status).toBe(400);
  });

  it('503 when parent R2 key is not configured', async () => {
    const res = await deployRoutes.request(
      '/apps/aiuniversity/deploy-credentials',
      { method: 'POST', headers: { Authorization: `Bearer ${await signToken()}` } },
      { CF_API_TOKEN: 'x', CF_ACCOUNT_ID: ACCOUNT } as never,
    );
    expect(res.status).toBe(503);
  });
});
