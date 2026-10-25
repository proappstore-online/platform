import { SELF, env as providedEnv, fetchMock } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import type { Env } from '../../../backend/src/types';
import { _resetJwksCache } from '../../../backend/src/lib/github-oidc';
import { ensureOidcTestGrant } from '../../../admin/src/e2e-grant';
import type { Env as AdminEnv } from '../../../admin/src/env';
import { BASE, mockNetwork, resetTables } from './helpers';

const env = providedEnv as unknown as Env;

// #462 on real D1 and the real exchange route: the grant provisioning creates for a new
// app is exactly what POST /v1/auth/exchange/oidc accepts — for the deploy workflow on
// main, as the e2e-tester principal, never as an admin — and nothing wider.

const ISSUER = 'https://token.actions.githubusercontent.com';
let priv: CryptoKey;
let jwk: JsonWebKey;
let jtiCounter = 0;

const b64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const b64urlJson = (o: unknown) => b64url(new TextEncoder().encode(JSON.stringify(o)));

async function oidc(repository: string, opts: { workflow?: string; ref?: string } = {}): Promise<string> {
  const ref = opts.ref ?? 'refs/heads/main';
  const workflow = opts.workflow ?? '.github/workflows/deploy.yml';
  const now = Math.floor(Date.now() / 1000);
  const header = b64urlJson({ alg: 'RS256', typ: 'JWT', kid: 'k1' });
  const payload = b64urlJson({
    iss: ISSUER, aud: 'https://api.proappstore.online', sub: `repo:${repository}:ref:${ref}`, repository, repository_owner: 'proappstore-online',
    ref, sha: 'cafe', run_id: '1', jti: `jti-${++jtiCounter}-${crypto.randomUUID()}`,
    workflow_ref: `${repository}/${workflow}@${ref}`, iat: now, nbf: now, exp: now + 300,
  });
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', priv, new TextEncoder().encode(`${header}.${payload}`));
  return `${header}.${payload}.${b64url(new Uint8Array(sig))}`;
}
const exchange = async (token: string) => SELF.fetch(`${BASE}/v1/auth/exchange/oidc`, { method: 'POST', headers: { Authorization: `Bearer ${token}` } });
const adminEnv = () => ({ DB: env.DB, PUBLISHERS_ORG: 'proappstore-online' }) as unknown as AdminEnv;

async function addPrincipal(slug: string) {
  await env.DB.batch([
    env.DB.prepare("INSERT OR IGNORE INTO users (id, provider, provider_id, login, email, avatar_url, created_at, last_login_at) VALUES (?, 'test', ?, ?, NULL, NULL, 1, 1)").bind(`test:${slug}`, slug, `test-${slug}`),
    env.DB.prepare("INSERT INTO test_principals (id, slug, user_id, description, status, created_by, created_at) VALUES (?, ?, ?, NULL, 'active', 'gh:admin', 1)").bind(`tp_${slug}`, slug, `test:${slug}`),
  ]);
}

beforeEach(async () => {
  mockNetwork();
  _resetJwksCache();
  const pair = await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']) as CryptoKeyPair;
  priv = pair.privateKey;
  jwk = { ...(await crypto.subtle.exportKey('jwk', pair.publicKey) as JsonWebKey), kid: 'k1', alg: 'RS256', use: 'sig' } as JsonWebKey;
  fetchMock.get(ISSUER).intercept({ path: '/.well-known/jwks' }).reply(200, () => ({ keys: [jwk] })).persist();
  await resetTables();
  for (const t of ['oidc_session_replays', 'oidc_session_mints', 'oidc_session_grants', 'test_principal_events', 'test_principals']) await env.DB.prepare(`DELETE FROM ${t}`).run().catch(() => {});
  await env.DB.prepare("DELETE FROM users WHERE id LIKE 'test:%'").run();
});

describe('the grant created at provisioning is what the exchange accepts (#462)', () => {
  it('mints an e2e-tester session for the new app\'s deploy workflow on main — user rights only, never admin', async () => {
    await addPrincipal('e2e-tester');
    expect((await ensureOidcTestGrant(adminEnv(), 'brand-new-app')).status).toBe('ok');

    const res = await exchange(await oidc('proappstore-online/brand-new-app'));
    expect(res.status).toBe(200);
    const body = await res.json() as { sessionToken: string; via: string; user: { id: string }; grant: { repository: string; workflow: string; principalId: string } };
    expect(body.via).toBe('oidc-test-principal');
    expect(body.user.id).toBe('test:e2e-tester');
    expect(body.grant).toMatchObject({ repository: 'proappstore-online/brand-new-app', workflow: '.github/workflows/deploy.yml', principalId: 'tp_e2e-tester' });

    // The session works and carries no admin role.
    const me = await SELF.fetch(`${BASE}/v1/auth/me`, { headers: { Authorization: `Bearer ${body.sessionToken}` } });
    expect(me.status).toBe(200);
    const profile = await me.json() as { roles?: string[]; user?: { roles?: string[] } };
    const roles = profile.roles ?? profile.user?.roles ?? [];
    expect(roles).not.toContain('admin');
  });

  it('is refused for any other workflow or ref of the same repo, and for a repo with no grant', async () => {
    await addPrincipal('e2e-tester');
    await ensureOidcTestGrant(adminEnv(), 'brand-new-app');
    expect((await exchange(await oidc('proappstore-online/brand-new-app', { workflow: '.github/workflows/other.yml' }))).status).toBe(403);
    expect((await exchange(await oidc('proappstore-online/brand-new-app', { ref: 'refs/heads/feature' }))).status).toBe(403);
    const none = await exchange(await oidc('proappstore-online/ungranted-app'));
    expect(none.status).toBe(403);
    expect(((await none.json()) as { error: string }).error).toContain('no e2e session grant');
  });

  it('stops working when the test account is disabled', async () => {
    await addPrincipal('e2e-tester');
    await ensureOidcTestGrant(adminEnv(), 'brand-new-app');
    expect((await exchange(await oidc('proappstore-online/brand-new-app'))).status).toBe(200);
    await env.DB.prepare("UPDATE test_principals SET status = 'disabled' WHERE slug = 'e2e-tester'").run();
    const disabled = await exchange(await oidc('proappstore-online/brand-new-app'));
    expect(disabled.status).toBe(403);
    expect(((await disabled.json()) as { error: string }).error).toContain('disabled');
  });

  it('a token cannot be exchanged twice', async () => {
    await addPrincipal('e2e-tester');
    await ensureOidcTestGrant(adminEnv(), 'brand-new-app');
    const token = await oidc('proappstore-online/brand-new-app');
    expect((await exchange(token)).status).toBe(200);
    expect((await exchange(token)).status).toBe(403);
  });

  it('with no e2e-tester account, provisioning makes no grant and the exchange stays refused (no fallback)', async () => {
    const step = await ensureOidcTestGrant(adminEnv(), 'brand-new-app');
    expect(step.status).toBe('fail');
    expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM oidc_session_grants').first<{ n: number }>())!.n).toBe(0);
    expect((await exchange(await oidc('proappstore-online/brand-new-app'))).status).toBe(403);
  });
});
