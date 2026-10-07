import { SELF, env as providedEnv, fetchMock } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../../../backend/src/types';
import { _resetJwksCache } from '../../../backend/src/lib/github-oidc';
import { appWorkerHost, appWorkerShimSha, disableAppWorker, loaderId, rotateAppWorkerCredentials, ROTATION_OVERLAP_MS } from '../../../backend/src/lib/app-worker-host';
import { BASE, json, mockNetwork, resetTables, seedApp, seedUser, session } from './helpers';

const env = providedEnv as unknown as Env;

// #253 (ADR-009) on real D1, R2 and the Worker Loader: the admin flag with its
// first-party rule and cap, the keyless deploy, credential storage, invocation
// through the platform shim, rotation and removal. GitHub's JWKS is the only
// thing intercepted.
//
//   gh:admin  platform admin (ADMIN_GITHUB_IDS) — owns the first-party apps
//   gh:7      ordinary creator — owns `third`

const ISSUER = 'https://token.actions.githubusercontent.com';
let priv: CryptoKey;
let jwk: JsonWebKey;

const b64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const b64urlJson = (o: unknown) => b64url(new TextEncoder().encode(JSON.stringify(o)));

async function oidc(repository: string, ref = 'refs/heads/main'): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const header = b64urlJson({ alg: 'RS256', typ: 'JWT', kid: 'k1' });
  const payload = b64urlJson({ iss: ISSUER, aud: 'https://api.proappstore.online', sub: `repo:${repository}:ref:${ref}`, repository, repository_owner: 'proappstore-online', ref, sha: 'cafe', iat: now, nbf: now, exp: now + 300 });
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', priv, new TextEncoder().encode(`${header}.${payload}`));
  return `${header}.${payload}.${b64url(new Uint8Array(sig))}`;
}

function bundle(modules: Record<string, string>): FormData {
  const f = new FormData();
  for (const [name, src] of Object.entries(modules)) f.append(name, new File([src], name, { type: 'application/javascript' }));
  return f;
}
const APP_OK = `globalThis.__ran = (globalThis.__ran ?? 0) + 1;
export default { async fetch(req, env) {
  const e = await req.json();
  if (e.payload?.fail) return new Response('E'.repeat(3 * 1024), { status: 500 });
  return Response.json({ got: e.name, app: env.APP_ID, hasToken: typeof env.PAS_WORKER_TOKEN === 'string' && env.PAS_WORKER_TOKEN.length === 64, invocation: req.headers.get('x-pas-invocation') });
} };`;

async function deploy(appId: string, modules: Record<string, string> = { 'app.js': APP_OK }, repo = `proappstore-online/${appId}`, ref?: string) {
  return SELF.fetch(`${BASE}/v1/apps/${appId}/worker/oidc`, { method: 'PUT', headers: { Authorization: `Bearer ${await oidc(repo, ref)}` }, body: bundle(modules) });
}
const enable = async (appId: string, enabled = true) =>
  SELF.fetch(`${BASE}/v1/admin/apps/${appId}/worker-enabled`, json('PUT', { enabled }, await session('gh:admin', { roles: ['user', 'admin'] })));
const row = (appId: string) => env.DB.prepare('SELECT * FROM app_workers WHERE app_id = ?').bind(appId).first<Record<string, unknown>>();
const stored = async (appId: string) => (await env.STORAGE.list({ prefix: `_app-workers/${appId}/` })).objects.map((o) => o.key);

beforeEach(async () => {
  mockNetwork();
  _resetJwksCache();
  const pair = await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']) as CryptoKeyPair;
  priv = pair.privateKey;
  jwk = { ...(await crypto.subtle.exportKey('jwk', pair.publicKey) as JsonWebKey), kid: 'k1', alg: 'RS256', use: 'sig' } as JsonWebKey;
  fetchMock.get(ISSUER).intercept({ path: '/.well-known/jwks' }).reply(200, () => ({ keys: [jwk] })).persist();
  // app_workers rows are never deleted (config_version must only grow, or a
  // cached isolate under a reused loader ID keeps a revoked env): reset them the
  // way production does, by disabling and removing.
  for (const r of (await env.DB.prepare('SELECT app_id FROM app_workers').all<{ app_id: string }>()).results ?? []) await disableAppWorker(env, r.app_id);
  await resetTables();
  for (const t of ['app_worker_deploys', 'app_worker_invocations', 'app_log_usage']) await env.DB.prepare(`DELETE FROM ${t}`).run();
  await seedUser('gh:admin', 'admin');
  await seedUser('gh:7', 'creator');
  for (const id of ['first', 'p2', 'p3', 'p4', 'p5', 'p6']) await seedApp(id, 'gh:admin');
  await seedApp('third', 'gh:7');
});
afterEach(async () => {
  const keys = (await env.STORAGE.list({ prefix: '_app-workers/' })).objects.map((o) => o.key);
  if (keys.length) await env.STORAGE.delete(keys);
});

describe('admin flag: first-party only, cap of 5 (#253)', () => {
  it('refuses a non-admin, a non-first-party app and a sixth app', async () => {
    const asCreator = await SELF.fetch(`${BASE}/v1/admin/apps/first/worker-enabled`, json('PUT', { enabled: true }, await session('gh:7')));
    expect(asCreator.status).toBe(403);
    const third = await enable('third');
    expect(third.status).toBe(403);
    expect(await third.text()).toContain('app workers are limited to first-party apps during the prototype');
    for (const id of ['first', 'p2', 'p3', 'p4', 'p5']) expect((await enable(id)).status, id).toBe(200);
    const sixth = await enable('p6');
    expect(sixth.status).toBe(409);
    expect(await sixth.text()).toContain('app worker cap reached (5)');
    // Re-enabling one already enabled is not a sixth slot.
    expect((await enable('first')).status).toBe(200);
    expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM app_workers WHERE enabled = 1').first<{ n: number }>())?.n).toBe(5);
  });
});

describe('keyless deploy (#253)', () => {
  it('with the flag off: 403, nothing stored, the refusal recorded', async () => {
    const res = await deploy('first');
    expect(res.status).toBe(403);
    expect(await res.text()).toContain('app workers are not enabled for this app');
    expect(await stored('first')).toEqual([]);
    expect((await env.DB.prepare("SELECT status FROM app_worker_deploys WHERE app_id = 'first'").all()).results).toEqual([{ status: 'refused' }]);
  });

  it('refuses another repo, a non-main ref and a bad bundle', async () => {
    await enable('first');
    expect((await deploy('first', undefined, 'proappstore-online/third')).status).toBe(403);
    expect((await deploy('first', undefined, undefined, 'refs/heads/feature')).status).toBe(403);
    const bads: Record<string, string>[] = [{ 'app.js': APP_OK, 'wrangler.toml': 'x' }, { 'app.js': APP_OK, '__pas_entry.js': 'evil' }, { 'app.js': APP_OK, metadata: '{}' }, { 'main.js': APP_OK }];
    for (const bad of bads) {
      expect((await deploy('first', bad)).status, Object.keys(bad).join(',')).toBe(400);
    }
    expect(await stored('first')).toEqual([]);
    expect((await row('first'))?.token_hash).toBeNull();
  });

  it('deploys: bundle in R2, credentials hashed and sealed, never returned', async () => {
    await enable('first');
    const res = await deploy('first', { 'app.js': APP_OK, 'lib/util.js': 'export const x = 1;' });
    expect(res.status, await res.clone().text()).toBe(200);
    const body = await res.json() as { backend: string; bundle_sha256: string; first_deploy: boolean };
    expect(body).toMatchObject({ backend: 'loader', first_deploy: true });
    expect((await stored('first')).sort()).toEqual([`_app-workers/first/${body.bundle_sha256}/app.js`, `_app-workers/first/${body.bundle_sha256}/lib/util.js`]);
    const w = (await row('first'))!;
    expect(w.token_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(w.token_ct).toBeTruthy();
    expect(w.event_key_ct).toBeTruthy();
    expect(w.bundle_sha256).toBe(body.bundle_sha256);
    expect(w.deployed_at).toBeTruthy();

    const status = await SELF.fetch(`${BASE}/v1/apps/first/worker`, json('GET', undefined, await session('gh:admin')));
    const text = await status.text();
    expect(status.status).toBe(200);
    expect(text).not.toContain(String(w.token_hash));
    expect(text).not.toMatch(/token|event_key/);

    // A redeploy keeps the credentials and the config version.
    const again = await deploy('first', { 'app.js': APP_OK + '\n// v2' });
    expect(((await again.json()) as { first_deploy: boolean }).first_deploy).toBe(false);
    const w2 = (await row('first'))!;
    expect(w2.token_hash).toBe(w.token_hash);
    expect(w2.config_version).toBe(w.config_version);
  });
});

describe('invocation through the platform shim on the Worker Loader (#253)', () => {
  const event = (payload: unknown, id = crypto.randomUUID()) => ({ id, type: 'schedule' as const, name: 'sync', attempt: 1, payload });

  beforeEach(async () => {
    await enable('first');
    expect((await deploy('first')).status).toBe(200);
  });

  it('runs a signed envelope end to end and records the invocation', async () => {
    const result = await appWorkerHost(env).invoke('first', event({}), { timeoutMs: 10_000 });
    expect(result).toMatchObject({ status: 'succeeded', httpStatus: 200 });
    // #308: the invoke request names its invocation, which AppWorkerTail reads back from the trace.
    expect(JSON.parse(result.body!)).toEqual({ got: 'sync', app: 'first', hasToken: true, invocation: result.invocationId });
    const rec = await env.DB.prepare('SELECT status, http_status, body_excerpt, finished_at FROM app_worker_invocations WHERE id = ?').bind(result.invocationId).first();
    expect(rec).toMatchObject({ status: 'succeeded', http_status: 200, body_excerpt: null });
  });

  it('a schedule, a hook and an http invocation each log their start and end with <event_id>:<attempt> (#308)', async () => {
    const lines: string[] = [];
    const spy = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => { lines.push(args.map(String).join(' ')); });
    try {
      for (const type of ['schedule', 'hook', 'http'] as const) {
        const id = crypto.randomUUID();
        const result = await appWorkerHost(env).invoke('first', { id, type, name: 'sync', attempt: 2, payload: {} }, { timeoutMs: 10_000 });
        expect(result.invocationId).toBe(`${id}:2`);
        expect(lines, type).toContain(`[app-worker] invoke first ${type} sync ${id}:2`);
        expect(lines.some((l) => new RegExp(`^\\[app-worker\\] ${id}:2 succeeded 200 \\d+ms$`).test(l)), type).toBe(true);
      }
    } finally {
      spy.mockRestore();
    }
  });

  it('a worker returning 500 with a 3 KB body is recorded failed with the first 1 KB', async () => {
    const result = await appWorkerHost(env).invoke('first', event({ fail: true }), { timeoutMs: 10_000 });
    expect(result).toMatchObject({ status: 'failed', httpStatus: 500 });
    const rec = await env.DB.prepare('SELECT status, http_status, body_excerpt FROM app_worker_invocations WHERE id = ?').bind(result.invocationId).first<{ body_excerpt: string }>();
    expect(rec).toMatchObject({ status: 'failed', http_status: 500 });
    expect(rec!.body_excerpt).toBe('E'.repeat(1024));
  });

  it('refuses a duplicate envelope id/attempt, and a disabled or deleted app', async () => {
    const e = event({});
    await appWorkerHost(env).invoke('first', e, { timeoutMs: 10_000 });
    await expect(appWorkerHost(env).invoke('first', e, { timeoutMs: 10_000 })).rejects.toThrow(/already exists/);
    await env.DB.prepare("DELETE FROM apps WHERE id = 'first'").run();
    await expect(appWorkerHost(env).invoke('first', event({}), { timeoutMs: 10_000 })).rejects.toThrow(/no active app worker/);
  });

  it('rotation bumps config_version (a new loader ID), keeps the old token for the overlap, and still invokes', async () => {
    const before = (await row('first'))!;
    const shim = await appWorkerShimSha();
    const { configVersion } = await rotateAppWorkerCredentials(env, 'first');
    expect(configVersion).toBe(Number(before.config_version) + 1);
    const after = (await row('first'))!;
    expect(after.prev_token_hash).toBe(before.token_hash);
    expect(after.token_hash).not.toBe(before.token_hash);
    expect(Number(after.prev_token_until) - Date.now()).toBeGreaterThan(ROTATION_OVERLAP_MS - 5_000);
    expect(loaderId('first', String(after.bundle_sha256), configVersion, shim)).not.toBe(loaderId('first', String(before.bundle_sha256), Number(before.config_version), shim));
    expect((await appWorkerHost(env).invoke('first', event({}), { timeoutMs: 10_000 })).status).toBe('succeeded');
  });
});

describe('removal (#253, ADR-009 §5)', () => {
  beforeEach(async () => {
    await enable('first');
    expect((await deploy('first')).status).toBe(200);
  });

  it('flag off runs remove(): credentials cleared, code deleted, a redeploy is refused', async () => {
    expect((await enable('first', false)).status).toBe(200);
    const w = (await row('first'))!;
    expect(w.enabled).toBe(0);
    for (const col of ['token_hash', 'token_ct', 'token_dek', 'token_iv', 'event_key_ct', 'prev_token_hash', 'bundle_sha256', 'deployed_at']) expect(w[col], col).toBeNull();
    expect(await stored('first')).toEqual([]);
    expect((await deploy('first')).status).toBe(403);
  });

  it('re-enabling needs a fresh deploy, which mints new credentials', async () => {
    const old = (await row('first'))!.token_hash;
    await enable('first', false);
    await enable('first');
    const res = await deploy('first');
    expect(((await res.json()) as { first_deploy: boolean }).first_deploy).toBe(true);
    expect((await row('first'))!.token_hash).not.toBe(old);
  });

  it('deleting the app disables and removes its worker', async () => {
    const del = await SELF.fetch(`${BASE}/v1/apps/first`, json('DELETE', undefined, await session('gh:admin')));
    expect(del.status).toBe(200);
    const w = (await row('first'))!;
    expect(w.enabled).toBe(0);
    expect(w.token_hash).toBeNull();
    expect(await stored('first')).toEqual([]);
  });

  it('the owner can remove it; nobody else can see or remove it', async () => {
    expect((await SELF.fetch(`${BASE}/v1/apps/first/worker`, json('DELETE', undefined, await session('gh:7')))).status).toBe(403);
    expect((await SELF.fetch(`${BASE}/v1/apps/first/worker`, json('GET', undefined, await session('gh:7')))).status).toBe(403);
    expect((await SELF.fetch(`${BASE}/v1/apps/first/worker`, json('DELETE', undefined, await session('gh:admin')))).status).toBe(200);
    expect((await row('first'))!.enabled).toBe(0);
  });
});
