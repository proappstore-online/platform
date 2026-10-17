import { SELF, env as providedEnv, fetchMock } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { _resetJwksCache } from '../../../backend/src/lib/github-oidc';
import {
  MARKETING_AUDIENCE,
  MARKETING_WORKFLOW_REF,
  STOREFRONT_OWNER_ID,
  STOREFRONT_REPOSITORY,
  STOREFRONT_REPOSITORY_ID,
} from '../../../backend/src/routes/marketing-deploy';
import type { Env } from '../../../backend/src/types';
import { BASE, json, mockNetwork, resetTables, seedApp, seedUser, session } from './helpers';

// #399 on workerd with real D1 + R2: the storefront workflow uploads an
// immutable, manifest-verified revision, activation re-verifies it and switches
// the one pointer the host reads, and nothing else can move that pointer.

const env = providedEnv as unknown as Env & { APPS: R2Bucket };
const ISSUER = 'https://token.actions.githubusercontent.com';
const APP = 'shop';
const OTHER = 'rival';
let priv: CryptoKey;
let jwk: JsonWebKey;

const b64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const b64urlJson = (o: unknown) => b64url(new TextEncoder().encode(JSON.stringify(o)));
async function oidc(over: Record<string, unknown> = {}, key = priv): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const claims = {
    iss: ISSUER, aud: MARKETING_AUDIENCE, sub: `repo:${STOREFRONT_REPOSITORY}:ref:refs/heads/main`,
    repository: STOREFRONT_REPOSITORY, repository_id: STOREFRONT_REPOSITORY_ID,
    repository_owner: 'proappstore-online', repository_owner_id: STOREFRONT_OWNER_ID,
    ref: 'refs/heads/main', workflow_ref: MARKETING_WORKFLOW_REF, run_id: '42', sha: 'c'.repeat(40),
    iat: now, nbf: now, exp: now + 300, ...over,
  };
  const header = b64urlJson({ alg: 'RS256', typ: 'JWT', kid: 'k1' });
  const payload = b64urlJson(claims);
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(`${header}.${payload}`));
  return `${header}.${payload}.${b64url(new Uint8Array(sig))}`;
}

const hex = async (b: Uint8Array) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', b))].map((x) => x.toString(16).padStart(2, '0')).join('');
const TYPES: Record<string, string> = { html: 'text/html; charset=utf-8', txt: 'text/plain; charset=utf-8', xml: 'application/xml; charset=utf-8', png: 'image/png' };

interface Artifact { manifest: Record<string, unknown>; files: Map<string, Uint8Array> }
async function build(appId: string, revision: string, heading: string): Promise<Artifact> {
  const enc = new TextEncoder();
  const files = new Map<string, Uint8Array>([
    ['/index.html', enc.encode(`<!doctype html><h1>${heading}</h1>`)],
    ['/robots.txt', enc.encode('User-agent: *\nAllow: /\n')],
    ['/sitemap.xml', enc.encode('<urlset/>')],
    ['/assets/hero.png', new Uint8Array([0x89, 0x50, 0x4e, 0x47, heading.length])],
  ]);
  const list = [];
  for (const [path, bytes] of files) list.push({ path, contentType: TYPES[path.split('.').pop()!], size: bytes.length, sha256: await hex(bytes) });
  return { files, manifest: { schemaVersion: 1, appId, revision, preview: false, origin: `https://about-${appId}.proappstore.online`, files: list } };
}

async function upload(appId: string, revision: string, art: Artifact, opts: { token?: string; extra?: [string, Uint8Array] } = {}): Promise<Response> {
  const form = new FormData();
  form.set('manifest', JSON.stringify(art.manifest));
  for (const [path, bytes] of art.files) form.append(path, new Blob([bytes]), path.split('/').pop());
  if (opts.extra) form.append(opts.extra[0], new Blob([opts.extra[1]]));
  return SELF.fetch(`${BASE}/v1/apps/${appId}/marketing/revisions/${revision}`, {
    method: 'PUT', body: form, headers: { Authorization: `Bearer ${opts.token ?? await oidc()}` },
  });
}
const activate = async (appId: string, revision: string, token?: string) =>
  SELF.fetch(`${BASE}/v1/apps/${appId}/marketing/activate`, json('POST', { revision }, token ?? await oidc()));
const rollback = async (appId: string, body: Record<string, unknown>, token?: string) =>
  SELF.fetch(`${BASE}/v1/apps/${appId}/marketing/rollback`, json('POST', body, token ?? await oidc()));
const active = async (appId = APP) =>
  (await env.DB.prepare('SELECT active_revision FROM app_marketing_sites WHERE app_id = ?').bind(appId).first<{ active_revision: string | null }>())?.active_revision ?? null;
const keys = async (prefix: string) => (await env.APPS.list({ prefix })).objects.map((o) => o.key).sort();
const listed = (appId: string, value = 1) =>
  env.DB.prepare('INSERT OR REPLACE INTO app_storefront_publication (app_id, listed, updated_at) VALUES (?, ?, 1)').bind(appId, value).run();

/** Upload + activate, asserting success. */
async function ship(revision: string, heading = revision): Promise<void> {
  expect((await upload(APP, revision, await build(APP, revision, heading))).status).toBe(201);
  expect((await activate(APP, revision)).status).toBe(200);
}

beforeEach(async () => {
  mockNetwork();
  _resetJwksCache();
  const pair = await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']) as CryptoKeyPair;
  priv = pair.privateKey;
  jwk = { ...(await crypto.subtle.exportKey('jwk', pair.publicKey) as JsonWebKey), kid: 'k1', alg: 'RS256', use: 'sig' } as JsonWebKey;
  fetchMock.get(ISSUER).intercept({ path: '/.well-known/jwks' }).reply(200, () => ({ keys: [jwk] })).persist();
  for (const t of ['app_marketing_deploys', 'app_marketing_sites', 'app_storefront_publication', 'app_visibility']) await env.DB.prepare(`DELETE FROM ${t}`).run();
  await resetTables();
  const objects = await env.APPS.list({ prefix: 'marketing/' });
  await Promise.all(objects.objects.map((o) => env.APPS.delete(o.key)));
  await seedUser('gh:1'); await seedApp(APP, 'gh:1');
  await seedUser('gh:2'); await seedApp(OTHER, 'gh:2');
  await listed(APP);
});

describe('marketing deploy: upload, activation, rollback (#399)', () => {
  it('uploads an immutable revision without activating it, activates it, and rolls back to the previous one', async () => {
    const up = await upload(APP, 'rev-1', await build(APP, 'rev-1', 'One'));
    expect(up.status).toBe(201);
    expect(await up.json()).toMatchObject({ revision: 'rev-1', status: 'uploaded', files: 4 });
    expect(await keys(`marketing/${APP}/revisions/rev-1/`)).toEqual([
      'artifact-manifest.json', 'assets/hero.png', 'index.html', 'robots.txt', 'sitemap.xml',
    ].map((k) => `marketing/${APP}/revisions/rev-1/${k}`));
    expect(await active()).toBeNull(); // uploading never activates

    const first = await activate(APP, 'rev-1');
    expect(await first.json()).toEqual({ appId: APP, active: 'rev-1', previous: null });
    expect(await active()).toBe('rev-1');
    expect(await (await activate(APP, 'rev-1')).json()).toMatchObject({ unchanged: true });

    await ship('rev-2', 'Two');
    expect(await active()).toBe('rev-2');
    const back = await rollback(APP, {});
    expect(await back.json()).toMatchObject({ active: 'rev-1', previous: 'rev-2', rolledBack: true });
    expect(await active()).toBe('rev-1');
    expect(await (await rollback(APP, { revision: 'rev-2' })).json()).toMatchObject({ active: 'rev-2', previous: 'rev-1' });

    // The receipt: owner-only, with the workflow run that produced each revision.
    const receipts = await (await SELF.fetch(`${BASE}/v1/apps/${APP}/marketing/deployments`, json('GET', undefined, await session('gh:1')))).json() as { active: string; deployments: Record<string, unknown>[] };
    expect(receipts.active).toBe('rev-2');
    expect(receipts.deployments.map((d) => [d.revision, d.status, d.active, d.run_id])).toEqual(expect.arrayContaining([
      ['rev-1', 'uploaded', false, '42'], ['rev-2', 'uploaded', true, '42'],
    ]));
    expect((await SELF.fetch(`${BASE}/v1/apps/${APP}/marketing/deployments`, json('GET', undefined, await session('gh:2')))).status).toBeGreaterThanOrEqual(403);
  });

  it('a bad upload or manifest is refused, writes nothing and leaves the active revision serving', async () => {
    await ship('rev-1');
    const good = await build(APP, 'rev-2', 'Two');
    const variant = (mutate: (a: Artifact) => void): Artifact => {
      const a: Artifact = { manifest: structuredClone(good.manifest), files: new Map(good.files) };
      mutate(a);
      return a;
    };
    const files = (a: Artifact) => a.manifest.files as Record<string, unknown>[];
    const bad: [string, Artifact, [string, Uint8Array]?][] = [
      ['hash mismatch', variant((a) => a.files.set('/index.html', new TextEncoder().encode('<h1>tampered</h1>')))],
      ['missing file part', variant((a) => a.files.delete('/assets/hero.png'))],
      ['missing required file', variant((a) => { a.manifest.files = files(a).filter((f) => f.path !== '/sitemap.xml'); a.files.delete('/sitemap.xml'); })],
      ['extra part', good, ['/assets/extra.png', new Uint8Array([1])]],
      ['preview build', variant((a) => { a.manifest.preview = true; })],
      ['another app', variant((a) => { a.manifest.appId = OTHER; })],
      ['another revision', variant((a) => { a.manifest.revision = 'rev-9'; })],
      ['foreign origin', variant((a) => { a.manifest.origin = 'https://evil.example'; })],
      ['traversal', variant((a) => { files(a)[3]!.path = '/assets/../../rival/x.png'; })],
      ['source map', variant((a) => { files(a)[3]!.path = '/assets/app.js.map'; })],
      ['dotfile', variant((a) => { files(a)[3]!.path = '/assets/.env.png'; })],
      ['wrong content type', variant((a) => { files(a)[3]!.contentType = 'text/html; charset=utf-8'; })],
    ];
    for (const [name, art, extra] of bad) {
      const res = await upload(APP, 'rev-2', art, extra ? { extra } : {});
      expect(res.status, name).toBe(400);
    }
    expect(await keys(`marketing/${APP}/revisions/rev-2/`)).toEqual([]);
    expect(await env.DB.prepare("SELECT 1 FROM app_marketing_deploys WHERE revision = 'rev-2'").first()).toBeNull();
    expect((await activate(APP, 'rev-2')).status).toBe(404);
    expect(await active()).toBe('rev-1');

    // Immutable: the same bytes again are a no-op, other bytes under the id are refused.
    expect(await (await upload(APP, 'rev-1', await build(APP, 'rev-1', 'rev-1'))).json()).toMatchObject({ unchanged: true });
    expect((await upload(APP, 'rev-1', await build(APP, 'rev-1', 'Changed'))).status).toBe(409);
    const served = await env.APPS.get(`marketing/${APP}/revisions/rev-1/index.html`);
    expect(await served!.text()).toContain('rev-1');
  });

  it('activation and rollback re-verify the stored artifact and refuse a changed or incomplete one', async () => {
    await ship('rev-1');
    expect((await upload(APP, 'rev-2', await build(APP, 'rev-2', 'Two'))).status).toBe(201);
    await env.APPS.put(`marketing/${APP}/revisions/rev-2/assets/hero.png`, new Uint8Array([0]));
    const tampered = await activate(APP, 'rev-2');
    expect(tampered.status).toBe(409);
    expect(await tampered.text()).toContain('artifact verification failed');
    expect(await active()).toBe('rev-1');

    expect((await upload(APP, 'rev-3', await build(APP, 'rev-3', 'Three'))).status).toBe(201);
    await env.APPS.delete(`marketing/${APP}/revisions/rev-3/artifact-manifest.json`);
    expect((await activate(APP, 'rev-3')).status).toBe(409);
    expect(await active()).toBe('rev-1');

    await ship('rev-4');
    await env.APPS.delete(`marketing/${APP}/revisions/rev-1/index.html`);
    expect((await rollback(APP, {})).status).toBe(409); // the previous known-good one is no longer intact
    expect(await active()).toBe('rev-4');
    expect((await rollback(APP, { revision: 'rev-2' })).status).toBe(409);
    expect((await rollback(APP, { revision: 'rev-nope' })).status).toBe(404);
  });

  it('#409: a private, unlisted app activates and rolls back like any other; an unpublished site is not resurrected', async () => {
    await listed(APP, 0);
    await env.DB.prepare("INSERT INTO app_visibility (app_id, mode, roles, created_at) VALUES (?, 'private', '[]', 1)").bind(APP).run();
    await ship('rev-1');
    await ship('rev-2');
    expect(await active()).toBe('rev-2');
    expect(await (await rollback(APP, {})).json()).toMatchObject({ active: 'rev-1', previous: 'rev-2' });

    await env.DB.prepare('UPDATE app_marketing_sites SET active_revision = NULL WHERE app_id = ?').bind(APP).run(); // unpublished
    expect((await rollback(APP, { revision: 'rev-2' })).status).toBe(409);
    expect(await active()).toBeNull();
    expect((await activate('no-such-app', 'rev-1')).status).toBe(404);
  });

  it("one app's revision or prefix is never another's", async () => {
    await listed(OTHER);
    expect((await upload(APP, 'rev-1', await build(APP, 'rev-1', 'One'))).status).toBe(201);
    expect((await activate(OTHER, 'rev-1')).status).toBe(404); // recorded for shop only
    expect((await upload(OTHER, 'rev-1', await build(APP, 'rev-1', 'One'))).status).toBe(400); // shop's manifest at rival's URL
    expect(await keys(`marketing/${OTHER}/`)).toEqual([]);
    expect(await active(OTHER)).toBeNull();
    expect((await upload('about-shop', 'rev-1', await build('about-shop', 'rev-1', 'x'))).status).toBe(400);
    expect((await upload(APP, 'Rev_1', await build(APP, 'Rev_1', 'x'))).status).toBe(400);
  });
});

describe('marketing deploy credential contract (#399)', () => {
  it('refuses every token but the storefront marketing workflow on main', async () => {
    await ship('rev-1');
    const art = await build(APP, 'rev-2', 'Two');
    const foreign = (await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']) as CryptoKeyPair).privateKey;
    const cases: [string, string, number][] = [
      ['an app repository', await oidc({ repository: `proappstore-online/${APP}`, repository_id: '1', sub: `repo:proappstore-online/${APP}:ref:refs/heads/main` }), 403],
      ['a reused repository name', await oidc({ repository_id: '999' }), 403],
      ['a transferred owner', await oidc({ repository_owner_id: '999' }), 403],
      ['another branch', await oidc({ ref: 'refs/heads/feature' }), 403],
      ['another workflow', await oidc({ workflow_ref: `${STOREFRONT_REPOSITORY}/.github/workflows/deploy.yml@refs/heads/main` }), 403],
      ['a pull request workflow', await oidc({ workflow_ref: `${STOREFRONT_REPOSITORY}/.github/workflows/marketing-deploy.yml@refs/pull/1/merge` }), 403],
      ['the app-deploy audience', await oidc({ aud: 'https://api.proappstore.online' }), 401],
      ['an expired token', await oidc({ exp: Math.floor(Date.now() / 1000) - 3600 }), 401],
      ['a forged signature', await oidc({}, foreign), 401],
      ['a user session', await session('gh:1'), 401],
    ];
    for (const [name, token, status] of cases) {
      expect((await upload(APP, 'rev-2', art, { token })).status, `upload: ${name}`).toBe(status);
      expect((await activate(APP, 'rev-1', token)).status, `activate: ${name}`).toBe(status);
    }
    const none = await SELF.fetch(`${BASE}/v1/apps/${APP}/marketing/activate`, json('POST', { revision: 'rev-1' }));
    expect(none.status).toBe(401);
    expect(await keys(`marketing/${APP}/revisions/rev-2/`)).toEqual([]);

    // The marketing token is useless at the app-deploy routes.
    const cross = await SELF.fetch(`${BASE}/v1/apps/${APP}/deploy-credentials`, json('POST', {}, await oidc()));
    expect(cross.status).toBe(401);
  });

  it('rollback: the workflow or a platform admin, never the app owner', async () => {
    await ship('rev-1');
    await ship('rev-2');
    expect((await rollback(APP, {}, await session('gh:1'))).status).toBe(403);
    expect(await active()).toBe('rev-2');
    await seedUser('gh:admin');
    const admin = await rollback(APP, {}, await session('gh:admin', { roles: ['user', 'admin'] }));
    expect(admin.status).toBe(200);
    expect(await active()).toBe('rev-1');
  });
});
