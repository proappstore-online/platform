import { SELF, env as providedEnv, fetchMock, createExecutionContext } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { _resetJwksCache } from '../../../backend/src/lib/github-oidc';
import type { Env } from '../../../backend/src/types';
import worker from '../../../backend/src/index';
import { BASE, json, mockNetwork, resetTables, seedApp, seedUser, session } from './helpers';

// #399/#408 on workerd with real D1 + R2: the app's own deploy uploads an
// immutable, manifest-verified revision named by its commit, activation
// re-verifies it and switches the one pointer the host reads, and nothing else
// can move that pointer.

const env = providedEnv as unknown as Env & { APPS: R2Bucket };
const ISSUER = 'https://token.actions.githubusercontent.com';
const APP = 'shop';
const OTHER = 'rival';
/** Revisions are commit SHAs (#408). */
const R = (n: number | string) => String(n).repeat(40).slice(0, 40);
let priv: CryptoKey;
let jwk: JsonWebKey;

const b64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const b64urlJson = (o: unknown) => b64url(new TextEncoder().encode(JSON.stringify(o)));
/** A GitHub Actions token from `proappstore-online/<appId>` on main, for the app-deploy audience. */
async function oidc(over: Record<string, unknown> = {}, key = priv, appId = APP): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const repository = `proappstore-online/${appId}`;
  const claims = {
    iss: ISSUER, aud: 'https://api.proappstore.online', sub: `repo:${repository}:ref:refs/heads/main`,
    repository, repository_owner: 'proappstore-online', ref: 'refs/heads/main', run_id: '42', sha: R('c'),
    iat: now, nbf: now, exp: now + 300, ...over,
  };
  const header = b64urlJson({ alg: 'RS256', typ: 'JWT', kid: 'k1' });
  const payload = b64urlJson(claims);
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(`${header}.${payload}`));
  return `${header}.${payload}.${b64url(new Uint8Array(sig))}`;
}

const hex = async (b: Uint8Array) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', b))].map((x) => x.toString(16).padStart(2, '0')).join('');
const TYPES: Record<string, string> = { html: 'text/html; charset=utf-8', css: 'text/css; charset=utf-8', png: 'image/png' };

interface Artifact { manifest: Record<string, unknown>; files: Map<string, Uint8Array> }
async function build(appId: string, revision: string, heading: string): Promise<Artifact> {
  const enc = new TextEncoder();
  const files = new Map<string, Uint8Array>([
    // The template-app build's shape (#407): a directory page, Astro CSS and a root icon.
    ['/index.html', enc.encode(`<!doctype html><h1>${heading}</h1>`)],
    ['/privacy/index.html', enc.encode('<!doctype html><h1>Privacy</h1>')],
    ['/_astro/Layout.css', enc.encode('h1{color:red}')],
    ['/icon-192.png', new Uint8Array([0x89, 0x50, 0x4e, 0x47, heading.length])],
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
    method: 'PUT', body: form, headers: { Authorization: `Bearer ${opts.token ?? await oidc({ sha: revision }, priv, appId)}` },
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

describe('marketing deploy: upload, activation, rollback (#399, #408)', () => {
  it('uploads an immutable revision without activating it, activates it, and rolls back to the previous one', async () => {
    const up = await upload(APP, R(1), await build(APP, R(1), 'One'));
    expect(up.status).toBe(201);
    expect(await up.json()).toMatchObject({ revision: R(1), status: 'uploaded', files: 4 });
    expect(await keys(`marketing/${APP}/revisions/${R(1)}/`)).toEqual([
      '_astro/Layout.css', 'artifact-manifest.json', 'icon-192.png', 'index.html', 'privacy/index.html',
    ].map((k) => `marketing/${APP}/revisions/${R(1)}/${k}`));
    expect(await active()).toBeNull(); // uploading never activates

    const first = await activate(APP, R(1));
    expect(await first.json()).toEqual({ appId: APP, active: R(1), previous: null });
    expect(await active()).toBe(R(1));
    expect(await (await activate(APP, R(1))).json()).toMatchObject({ unchanged: true });

    await ship(R(2), 'Two');
    expect(await active()).toBe(R(2));
    const back = await rollback(APP, {});
    expect(await back.json()).toMatchObject({ active: R(1), previous: R(2), rolledBack: true });
    expect(await active()).toBe(R(1));
    expect(await (await rollback(APP, { revision: R(2) })).json()).toMatchObject({ active: R(2), previous: R(1) });

    // The receipt: owner-only, with the repository, run and commit that produced each revision.
    const receipts = await (await SELF.fetch(`${BASE}/v1/apps/${APP}/marketing/deployments`, json('GET', undefined, await session('gh:1')))).json() as { active: string; deployments: Record<string, unknown>[] };
    expect(receipts.active).toBe(R(2));
    expect(receipts.deployments.map((d) => [d.revision, d.status, d.active, d.repository, d.run_id, d.commit_sha])).toEqual(expect.arrayContaining([
      [R(1), 'uploaded', false, `proappstore-online/${APP}`, '42', R(1)], [R(2), 'uploaded', true, `proappstore-online/${APP}`, '42', R(2)],
    ]));
    expect((await SELF.fetch(`${BASE}/v1/apps/${APP}/marketing/deployments`, json('GET', undefined, await session('gh:2')))).status).toBeGreaterThanOrEqual(403);
  });

  it('a bad upload or manifest is refused, writes nothing and leaves the active revision serving', async () => {
    await ship(R(1));
    const good = await build(APP, R(2), 'Two');
    const variant = (mutate: (a: Artifact) => void): Artifact => {
      const a: Artifact = { manifest: structuredClone(good.manifest), files: new Map(good.files) };
      mutate(a);
      return a;
    };
    const files = (a: Artifact) => a.manifest.files as Record<string, unknown>[];
    const bad: [string, Artifact, [string, Uint8Array]?][] = [
      ['hash mismatch', variant((a) => a.files.set('/index.html', new TextEncoder().encode('<h1>tampered</h1>')))],
      ['missing file part', variant((a) => a.files.delete('/icon-192.png'))],
      ['no index.html', variant((a) => { a.manifest.files = files(a).filter((f) => f.path !== '/index.html'); a.files.delete('/index.html'); })],
      ['extra part', good, ['/assets/extra.png', new Uint8Array([1])]],
      ['preview build', variant((a) => { a.manifest.preview = true; })],
      ['another app', variant((a) => { a.manifest.appId = OTHER; })],
      ['another revision', variant((a) => { a.manifest.revision = R(9); })],
      ['foreign origin', variant((a) => { a.manifest.origin = 'https://evil.example'; })],
      ['traversal', variant((a) => { files(a)[3]!.path = '/assets/../../rival/x.png'; })],
      ['source map', variant((a) => { files(a)[3]!.path = '/assets/app.js.map'; })],
      ['dotfile', variant((a) => { files(a)[3]!.path = '/.well-known/x.png'; })],
      ['a non-index HTML page', variant((a) => { files(a)[1]!.path = '/privacy.html'; })],
      ['wrong content type', variant((a) => { files(a)[3]!.contentType = 'text/html; charset=utf-8'; })],
    ];
    for (const [name, art, extra] of bad) {
      const res = await upload(APP, R(2), art, extra ? { extra } : {});
      expect(res.status, name).toBe(400);
    }
    expect(await keys(`marketing/${APP}/revisions/${R(2)}/`)).toEqual([]);
    expect(await env.DB.prepare('SELECT 1 FROM app_marketing_deploys WHERE revision = ?').bind(R(2)).first()).toBeNull();
    expect((await activate(APP, R(2))).status).toBe(404);
    expect(await active()).toBe(R(1));

    // Immutable: the same bytes again are a no-op (a re-run), other bytes under the id are refused.
    expect(await (await upload(APP, R(1), await build(APP, R(1), R(1)))).json()).toMatchObject({ unchanged: true });
    expect((await upload(APP, R(1), await build(APP, R(1), 'Changed'))).status).toBe(409);
    const served = await env.APPS.get(`marketing/${APP}/revisions/${R(1)}/index.html`);
    expect(await served!.text()).toContain(R(1));
  });

  it('#441: a failed revision can be re-uploaded with different bytes, drops the old objects, and publishes', async () => {
    const prefix = `marketing/${APP}/revisions/${R(5)}/`;
    const first = await build(APP, R(5), 'First');
    first.files.set('/old-only.png', new Uint8Array([9])); // an object the rebuilt site will no longer contain
    (first.manifest.files as unknown[]).push({ path: '/old-only.png', contentType: TYPES.png, size: 1, sha256: await hex(new Uint8Array([9])) });
    expect((await upload(APP, R(5), first)).status).toBe(201);
    // Simulate a dead attempt: the row failed after objects (and a manifest) landed.
    await env.DB.prepare("UPDATE app_marketing_deploys SET status = 'failed', error = 'upload failed: boom' WHERE revision = ?").bind(R(5)).run();

    const rebuilt = await build(APP, R(5), 'Second, rebuilt with another lockfile resolution');
    const res = await upload(APP, R(5), rebuilt);
    expect(res.status).toBe(201);
    expect(await keys(prefix)).toEqual([
      '_astro/Layout.css', 'artifact-manifest.json', 'icon-192.png', 'index.html', 'privacy/index.html',
    ].map((k) => prefix + k));
    const row = await env.DB.prepare('SELECT status, error, manifest_sha256 FROM app_marketing_deploys WHERE revision = ?').bind(R(5)).first<Record<string, unknown>>();
    expect(row).toMatchObject({ status: 'uploaded', error: null });
    expect(row!.manifest_sha256).toBe((await res.json() as { manifestSha256: string }).manifestSha256);
    expect(await (await env.APPS.get(`${prefix}index.html`))!.text()).toContain('rebuilt');
    expect((await activate(APP, R(5))).status).toBe(200);
    expect(await active()).toBe(R(5));
  });

  it('#441: a stale uploading revision is re-reservable with a new manifest; a live one, an uploaded one and an activated one are not', async () => {
    const reserve = async (rev: string, heading: string) => (await upload(APP, rev, await build(APP, rev, heading))).status;
    const setRow = (rev: string, set: string) => env.DB.prepare(`UPDATE app_marketing_deploys SET ${set} WHERE revision = ?`).bind(rev).run();

    expect(await reserve(R(6), 'a')).toBe(201);
    await setRow(R(6), "status = 'uploading', updated_at = " + Date.now()); // a concurrent run still working
    expect(await reserve(R(6), 'b')).toBe(409);
    await setRow(R(6), "updated_at = " + (Date.now() - 16 * 60 * 1000)); // now dead
    expect(await reserve(R(6), 'b')).toBe(201);

    expect(await reserve(R(6), 'c')).toBe(409); // uploaded: immutable again

    await setRow(R(6), "status = 'failed', activated_at = 1"); // went live once: never rewritten
    expect(await reserve(R(6), 'd')).toBe(409);
  });

  it('robots.txt and sitemap.xml are optional; only index.html is required (#408)', async () => {
    const art = await build(APP, R(3), 'Three');
    expect((art.manifest.files as { path: string }[]).map((f) => f.path)).not.toContain('/robots.txt');
    expect((await upload(APP, R(3), art)).status).toBe(201);
    expect((await activate(APP, R(3))).status).toBe(200);
  });

  it('activation and rollback re-verify the stored artifact and refuse a changed or incomplete one', async () => {
    await ship(R(1));
    expect((await upload(APP, R(2), await build(APP, R(2), 'Two'))).status).toBe(201);
    await env.APPS.put(`marketing/${APP}/revisions/${R(2)}/icon-192.png`, new Uint8Array([0]));
    const tampered = await activate(APP, R(2));
    expect(tampered.status).toBe(409);
    expect(await tampered.text()).toContain('artifact verification failed');
    expect(await active()).toBe(R(1));

    expect((await upload(APP, R(3), await build(APP, R(3), 'Three'))).status).toBe(201);
    await env.APPS.delete(`marketing/${APP}/revisions/${R(3)}/artifact-manifest.json`);
    expect((await activate(APP, R(3))).status).toBe(409);
    expect(await active()).toBe(R(1));

    await ship(R(4));
    await env.APPS.delete(`marketing/${APP}/revisions/${R(1)}/index.html`);
    expect((await rollback(APP, {})).status).toBe(409); // the previous known-good one is no longer intact
    expect(await active()).toBe(R(4));
    expect((await rollback(APP, { revision: R(2) })).status).toBe(409);
    expect((await rollback(APP, { revision: R('f') })).status).toBe(404);
  });

  it('#409: a private, unlisted app activates and rolls back like any other; an unpublished site is not resurrected', async () => {
    await listed(APP, 0);
    await env.DB.prepare("INSERT INTO app_visibility (app_id, mode, roles, created_at) VALUES (?, 'private', '[]', 1)").bind(APP).run();
    await ship(R(1));
    await ship(R(2));
    expect(await active()).toBe(R(2));
    expect(await (await rollback(APP, {})).json()).toMatchObject({ active: R(1), previous: R(2) });

    await env.DB.prepare('UPDATE app_marketing_sites SET active_revision = NULL WHERE app_id = ?').bind(APP).run(); // unpublished
    expect((await rollback(APP, { revision: R(2) })).status).toBe(409);
    expect(await active()).toBeNull();
  });

  it("one app's revision or prefix is never another's", async () => {
    expect((await upload(APP, R(1), await build(APP, R(1), 'One'))).status).toBe(201);
    // rival's own deploy cannot activate a revision recorded for shop.
    expect((await activate(OTHER, R(1), await oidc({}, priv, OTHER))).status).toBe(404);
    // shop's manifest at rival's URL, with rival's own token: refused.
    expect((await upload(OTHER, R(1), await build(APP, R(1), 'One'))).status).toBe(400);
    expect(await keys(`marketing/${OTHER}/`)).toEqual([]);
    expect(await active(OTHER)).toBeNull();
    expect((await upload('about-shop', R(1), await build('about-shop', R(1), 'x'))).status).toBe(400);
    expect((await upload(APP, 'Rev_1', await build(APP, 'Rev_1', 'x'))).status).toBe(400);
  });
});

describe('marketing deploy credential contract (#408)', () => {
  it("accepts only the app's own deploy token on main, for the commit it is building", async () => {
    await ship(R(1));
    const art = await build(APP, R(2), 'Two');
    const foreign = (await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']) as CryptoKeyPair).privateKey;
    const cases: [string, string, number][] = [
      ["another app's repository", await oidc({ sha: R(2) }, priv, OTHER), 403],
      ['a same-named repository in another org', await oidc({ sha: R(2), repository: `evil/${APP}`, repository_owner: 'evil' }), 403],
      ['another branch', await oidc({ sha: R(2), ref: 'refs/heads/feature' }), 403],
      ['a pull request ref', await oidc({ sha: R(2), ref: 'refs/pull/1/merge' }), 403],
      ['the retired marketing audience', await oidc({ sha: R(2), aud: 'https://api.proappstore.online/marketing' }), 401],
      ['an expired token', await oidc({ sha: R(2), exp: Math.floor(Date.now() / 1000) - 3600 }), 401],
      ['a forged signature', await oidc({ sha: R(2) }, foreign), 401],
      ['a user session', await session('gh:1'), 401],
    ];
    for (const [name, token, status] of cases) {
      expect((await upload(APP, R(2), art, { token })).status, `upload: ${name}`).toBe(status);
      expect((await activate(APP, R(1), token)).status, `activate: ${name}`).toBe(status);
    }
    // The app's own token, but for another commit than the revision it uploads.
    expect((await upload(APP, R(2), art, { token: await oidc({ sha: R(3) }) })).status).toBe(403);
    const none = await SELF.fetch(`${BASE}/v1/apps/${APP}/marketing/activate`, json('POST', { revision: R(1) }));
    expect(none.status).toBe(401);
    expect(await keys(`marketing/${APP}/revisions/${R(2)}/`)).toEqual([]);
    expect(await active()).toBe(R(1));
  });

  it("rollback: the app's deploy or a platform admin, never the app owner", async () => {
    await ship(R(1));
    await ship(R(2));
    expect((await rollback(APP, {}, await session('gh:1'))).status).toBe(403);
    expect((await rollback(APP, {}, await oidc({}, priv, OTHER))).status).toBe(403);
    expect(await active()).toBe(R(2));
    await seedUser('gh:admin');
    const admin = await rollback(APP, {}, await session('gh:admin', { roles: ['user', 'admin'] }));
    expect(admin.status).toBe(200);
    expect(await active()).toBe(R(1));
  });

  it('refuses a stale workflow rollback whose candidate has already been replaced', async () => {
    await ship(R(1)); await ship(R(2)); await ship(R(3));
    const before = await env.DB.prepare('SELECT revision, activated_at FROM app_marketing_deploys WHERE app_id = ? ORDER BY revision').bind(APP).all();
    const result = await rollback(APP, { revision: R(1), expectedRevision: R(2) });
    expect(result.status).toBe(409);
    expect(await active()).toBe(R(3));
    expect((await env.DB.prepare('SELECT revision, activated_at FROM app_marketing_deploys WHERE app_id = ? ORDER BY revision').bind(APP).all()).results).toEqual(before.results);
  });

  for (const operation of ['activate', 'first-activate', 'rollback']) {
    for (const change of operation === 'first-activate' ? ['activate-newer'] : ['activate-newer', 'unpublish', 'remove-row']) {
      it(`${operation} does not overwrite ${change} during artifact verification`, async () => {
        if (operation === 'first-activate') expect((await upload(APP, R(1), await build(APP, R(1), 'First'))).status).toBe(201);
        else { await ship(R(1)); await ship(R(2)); }
        expect((await upload(APP, R(3), await build(APP, R(3), 'Newer'))).status).toBe(201);
        let changed = false;
        let receipts: unknown;
        const store = new Proxy(env.APPS, {
          get(target, property) {
            if (property === 'get') return async (...args: unknown[]) => {
              if (!changed) {
                changed = true;
                if (change === 'activate-newer') expect((await activate(APP, R(3))).status).toBe(200);
                else if (change === 'unpublish') await env.DB.prepare('UPDATE app_marketing_sites SET active_revision = NULL WHERE app_id = ?').bind(APP).run();
                else await env.DB.prepare('DELETE FROM app_marketing_sites WHERE app_id = ?').bind(APP).run();
                receipts = (await env.DB.prepare('SELECT revision, activated_at, updated_at FROM app_marketing_deploys WHERE app_id = ? ORDER BY revision').bind(APP).all()).results;
              }
              return Reflect.apply(target.get, target, args);
            };
            const value = Reflect.get(target, property, target);
            return typeof value === 'function' ? value.bind(target) : value;
          },
        });
        const route = operation === 'rollback' ? 'rollback' : 'activate';
        const body = route === 'activate' ? { revision: R(1) } : { revision: R(1), expectedRevision: R(2) };
        const response = await worker.fetch(new Request(`${BASE}/v1/apps/${APP}/marketing/${route}`, json('POST', body, await oidc())), { ...env, APPS: store }, createExecutionContext());
        expect(changed).toBe(true);
        expect(response.status).toBe(409);
        expect(await active()).toBe(change === 'activate-newer' ? R(3) : null);
        expect((await env.DB.prepare('SELECT revision, activated_at, updated_at FROM app_marketing_deploys WHERE app_id = ? ORDER BY revision').bind(APP).all()).results).toEqual(receipts);
      });
    }
  }
});
