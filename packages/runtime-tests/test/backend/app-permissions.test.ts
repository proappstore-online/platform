import { SELF, env as providedEnv, fetchMock } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import type { Env } from '../../../backend/src/types';
import { _resetJwksCache } from '../../../backend/src/lib/github-oidc';
import { BASE, goLive, json, mockNetwork, resetTables, seedApp, seedUser, session } from './helpers';

// #437 on real D1 and migration 0110: an app's storefront listing shows the browser
// permissions it declares (mcp.json) and the deploy pipeline detected (keyless).

const env = providedEnv as unknown as Env;
const ISSUER = 'https://token.actions.githubusercontent.com';
const APP = 'perm-demo';
let priv: CryptoKey;
let jwk: JsonWebKey;

const b64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const b64urlJson = (o: unknown) => b64url(new TextEncoder().encode(JSON.stringify(o)));
async function oidc(repository = `proappstore-online/${APP}`, ref = 'refs/heads/main'): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const header = b64urlJson({ alg: 'RS256', typ: 'JWT', kid: 'k1' });
  const payload = b64urlJson({ iss: ISSUER, aud: 'https://api.proappstore.online', sub: `repo:${repository}:ref:${ref}`, repository, repository_owner: 'proappstore-online', ref, sha: 'a'.repeat(40), iat: now, nbf: now, exp: now + 300 });
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', priv, new TextEncoder().encode(`${header}.${payload}`));
  return `${header}.${payload}.${b64url(new Uint8Array(sig))}`;
}
const report = async (permissions: unknown, token?: string, appId = APP) => SELF.fetch(`${BASE}/v1/apps/${appId}/permissions/detected`, {
  method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token ?? await oidc()}` }, body: JSON.stringify({ permissions }),
});
const detail = async () => (await (await SELF.fetch(`${BASE}/v1/storefront/apps/${APP}`)).json()) as { permissions: { id: string; name: string; icon: string; reason: string | null; source: string }[] };
const cards = async () => ((await (await SELF.fetch(`${BASE}/v1/storefront/apps`)).json()) as { apps: { appId: string; permissions: string[] }[] }).apps;
function validates(): void {
  fetchMock.get(`https://pas-data-${APP}.${env.DATA_WORKER_HOST}`).intercept({ path: '/validate', method: 'POST' })
    .reply(200, (req) => ({ results: (JSON.parse(String(req.body)) as { statements: { id: string }[] }).statements.map((st) => ({ id: st.id, ok: true })) }));
}
const tool = { name: 'list_mine', description: 'Mine', operation: 'query', requires_auth: true, params: {}, sql: 'SELECT id FROM notes WHERE user_id = :__user_id LIMIT 10' };

beforeEach(async () => {
  mockNetwork();
  _resetJwksCache();
  const pair = await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']) as CryptoKeyPair;
  priv = pair.privateKey;
  jwk = { ...(await crypto.subtle.exportKey('jwk', pair.publicKey) as JsonWebKey), kid: 'k1', alg: 'RS256', use: 'sig' } as JsonWebKey;
  fetchMock.get(ISSUER).intercept({ path: '/.well-known/jwks' }).reply(200, () => ({ keys: [jwk] })).persist();
  await resetTables();
  await env.DB.prepare('DELETE FROM app_permissions').run();
  await seedUser('gh:1'); await seedApp(APP, 'gh:1');
  await seedUser('gh:2'); await seedApp('other-app', 'gh:2');
});

describe('app permissions on the storefront listing (#437)', () => {
  it('an app with no row asks for nothing special: an empty list on the detail and the card', async () => {
    expect((await detail()).permissions).toEqual([]);
    expect((await cards()).find((a) => a.appId === APP)!.permissions).toEqual([]);
  });

  it('shows what the deploy detected and the app declared, merged, in catalogue order', async () => {
    const reported = await report(['location', 'camera', 'microphone']);
    expect(reported.status).toBe(200);
    expect(await reported.json()).toEqual({ ok: true, app: APP, detected: ['microphone', 'camera', 'location'] });

    validates();
    const reg = await SELF.fetch(`${BASE}/v1/apps/${APP}/tools`, json('PUT', { tools: [tool], permissions: [{ id: 'microphone', reason: 'Record voice notes' }, 'notifications'] }, await session('gh:1')));
    expect(reg.status).toBe(200);
    await goLive(APP);

    expect((await detail()).permissions).toEqual([
      { id: 'microphone', name: 'Microphone', icon: '🎤', reason: 'Record voice notes', source: 'both' },
      { id: 'camera', name: 'Camera', icon: '📷', reason: null, source: 'detected' },
      { id: 'location', name: 'Location', icon: '📍', reason: null, source: 'detected' },
      { id: 'notifications', name: 'Notifications', icon: '🔔', reason: null, source: 'declared' },
    ]);
    expect((await cards()).find((a) => a.appId === APP)!.permissions).toEqual(['microphone', 'camera', 'location', 'notifications']);

    // A later deploy replaces the detected list; the declaration stays.
    await report([]);
    expect((await detail()).permissions.map((p) => [p.id, p.source])).toEqual([['microphone', 'declared'], ['notifications', 'declared']]);
  });

  it('the detected report is keyless OIDC for this app only, and validated', async () => {
    expect((await SELF.fetch(`${BASE}/v1/apps/${APP}/permissions/detected`, { method: 'POST', body: '{}' })).status).toBe(401);
    expect((await report(['camera'], await oidc('proappstore-online/other-app'))).status).toBe(403);
    expect((await report(['camera'], await oidc(`proappstore-online/${APP}`, 'refs/heads/dev'))).status).toBe(403);
    expect((await report(['telepathy'])).status).toBe(400);
    expect((await report('camera')).status).toBe(400);
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM app_permissions').first()).toEqual({ n: 0 });
  });
});
