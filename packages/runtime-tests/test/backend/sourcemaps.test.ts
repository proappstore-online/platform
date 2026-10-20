import { SELF, env, fetchMock } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { _resetJwksCache } from '../../../backend/src/lib/github-oidc';
import { sweepSourceMaps } from '../../../backend/src/lib/sourcemap';
import { STALE_RESERVATION_MS } from '../../../backend/src/routes/sourcemaps';
import { BASE, json, mockNetwork, resetTables, seedApp, seedUser, session } from './helpers';

// #393 on workerd with real D1 + R2: keyless upload of a release's private maps
// from the app's own repo, immutable per commit, and owner-only symbolication
// that resolves each release against itself.

const ISSUER = 'https://token.actions.githubusercontent.com';
const APP = 'map-demo';
const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);
let priv: CryptoKey;
let jwk: JsonWebKey;

const b64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const b64urlJson = (o: unknown) => b64url(new TextEncoder().encode(JSON.stringify(o)));
async function oidc(sha: string, repository = `proappstore-online/${APP}`, ref = 'refs/heads/main'): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const header = b64urlJson({ alg: 'RS256', typ: 'JWT', kid: 'k1' });
  const payload = b64urlJson({ iss: ISSUER, aud: 'https://api.proappstore.online', sub: `repo:${repository}:ref:${ref}`, repository, repository_owner: 'proappstore-online', ref, sha, iat: now, nbf: now, exp: now + 300 });
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', priv, new TextEncoder().encode(`${header}.${payload}`));
  return `${header}.${payload}.${b64url(new Uint8Array(sig))}`;
}
const bundle = (mappings: string) => JSON.stringify({ files: { 'assets/index-abc.js': { version: 3, sources: ['src/App.tsx'], names: [], mappings } } });
const upload = async (sha: string, body: string | Uint8Array, token?: string, appId = APP) =>
  SELF.fetch(`${BASE}/v1/apps/${appId}/sourcemaps?commitSha=${sha}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token === '' ? {} : { Authorization: `Bearer ${token ?? await oidc(sha)}` }) },
    body,
  });
const frame = { source: `https://${APP}.proappstore.online/assets/index-abc.js`, line: 1, col: 1 };
const symbolicate = async (sha: string, token: string, frames: unknown = [frame]) =>
  SELF.fetch(`${BASE}/v1/apps/${APP}/sourcemaps/${sha}/symbolicate`, json('POST', { frames, rawStack: 'at a (index-abc.js:1:1)' }, token));

beforeEach(async () => {
  mockNetwork();
  _resetJwksCache();
  const pair = await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']) as CryptoKeyPair;
  priv = pair.privateKey;
  jwk = { ...(await crypto.subtle.exportKey('jwk', pair.publicKey) as JsonWebKey), kid: 'k1', alg: 'RS256', use: 'sig' } as JsonWebKey;
  fetchMock.get(ISSUER).intercept({ path: '/.well-known/jwks' }).reply(200, () => ({ keys: [jwk] })).persist();
  await resetTables();
  await env.DB.prepare('DELETE FROM release_sourcemap_manifests').run();
  const listed = await env.STORAGE.list({ prefix: '_sourcemaps/' });
  await Promise.all(listed.objects.map((o) => env.STORAGE.delete(o.key)));
  await seedUser('gh:1'); await seedApp(APP, 'gh:1');
  await seedUser('gh:2'); await seedApp('other-app', 'gh:2');
});

describe('browser source maps (#393)', () => {
  it('two uploaded releases each symbolicate to their own original line, for the owner only', async () => {
    const a = await upload(SHA_A, bundle('AASI'));
    expect(a.status).toBe(201);
    const body = await a.json() as { storageKey: string; assetDigest: string; expiresAt: number };
    expect(body.storageKey).toBe(`_sourcemaps/${APP}/${SHA_A}/bundle.json`);
    expect(body.expiresAt - Date.now()).toBeGreaterThan(29 * 24 * 3600 * 1000);
    expect((await upload(SHA_B, bundle('AAmBE'))).status).toBe(201);

    const owner = await session('gh:1');
    const ra = await (await symbolicate(SHA_A, owner)).json() as { status: string; frames: Record<string, unknown>[]; rawStack: string };
    const rb = await (await symbolicate(SHA_B, owner)).json() as { status: string; frames: Record<string, unknown>[] };
    expect(ra).toMatchObject({ status: 'ok', rawStack: 'at a (index-abc.js:1:1)' });
    expect(ra.frames[0]).toMatchObject({ originalSource: 'src/App.tsx', originalLine: 10, originalCol: 5 });
    expect(rb.frames[0]).toMatchObject({ originalSource: 'src/App.tsx', originalLine: 20, originalCol: 3 });

    // An unknown release is explicit, never "latest".
    const missing = await (await symbolicate('c'.repeat(40), owner)).json() as { status: string; frames: Record<string, unknown>[] };
    expect(missing.status).toBe('missing');
    expect(missing.frames[0]).toMatchObject({ ...frame, unresolved: true });
  });

  it('a release is immutable: a second upload for the commit is 409 and leaves the stored bytes', async () => {
    const first = await (await upload(SHA_A, bundle('AASI'))).json() as { assetDigest: string };
    const again = await upload(SHA_A, bundle('AAmBE'));
    expect(again.status).toBe(409);
    const row = await env.DB.prepare('SELECT asset_digest FROM release_sourcemap_manifests WHERE app_id = ? AND commit_sha = ?').bind(APP, SHA_A).first<{ asset_digest: string }>();
    expect(row!.asset_digest).toBe(first.assetDigest);
    const r = await (await symbolicate(SHA_A, await session('gh:1'))).json() as { frames: Record<string, unknown>[] };
    expect(r.frames[0]!.originalLine).toBe(10);
  });

  // #429: a reservation whose upload never finished (request cancelled, Worker killed)
  // has no digest; it used to answer every retry 409 "already uploaded", with no bytes.
  it('an abandoned reservation is taken over by a retry once stale; a fresh one still answers 409', async () => {
    const reserve = (at: number) => env.DB.prepare(
      "INSERT INTO release_sourcemap_manifests (app_id, commit_sha, asset_digest, storage_key, uploaded_at, expires_at) VALUES (?, ?, '', 'k', ?, ?)",
    ).bind(APP, SHA_A, at, at + 86_400_000).run();
    await reserve(Date.now() - 60_000);
    expect((await upload(SHA_A, bundle('AASI'))).status).toBe(409);
    await env.DB.prepare('UPDATE release_sourcemap_manifests SET uploaded_at = ? WHERE app_id = ? AND commit_sha = ?')
      .bind(Date.now() - STALE_RESERVATION_MS - 1, APP, SHA_A).run();
    const retried = await upload(SHA_A, bundle('AASI'));
    expect(retried.status).toBe(201);
    const row = await env.DB.prepare('SELECT COUNT(*) AS n, MAX(asset_digest) AS digest FROM release_sourcemap_manifests WHERE app_id = ? AND commit_sha = ?').bind(APP, SHA_A).first<{ n: number; digest: string }>();
    expect(row).toEqual({ n: 1, digest: ((await retried.json()) as { assetDigest: string }).assetDigest });
    const r = await (await symbolicate(SHA_A, await session('gh:1'))).json() as { frames: Record<string, unknown>[] };
    expect(r.frames[0]!.originalLine).toBe(10);
  });

  it('upload auth: no token 401; another repo, a non-main ref or a different commit 403', async () => {
    expect((await upload(SHA_A, bundle('AASI'), '')).status).toBe(401);
    expect((await upload(SHA_A, bundle('AASI'), await oidc(SHA_A, 'proappstore-online/other-app'))).status).toBe(403);
    expect((await upload(SHA_A, bundle('AASI'), await oidc(SHA_A, `proappstore-online/${APP}`, 'refs/heads/feature'))).status).toBe(403);
    expect((await upload(SHA_A, bundle('AASI'), await oidc(SHA_B))).status).toBe(403);
    expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM release_sourcemap_manifests').first<{ n: number }>())!.n).toBe(0);
  });

  it('rejects traversal, bad commits, oversized and malformed bundles', async () => {
    expect((await upload('../evil', bundle('AASI'), await oidc('../evil'))).status).toBe(400);
    expect((await upload('abc', bundle('AASI'), await oidc('abc'))).status).toBe(400);
    const traversal = JSON.stringify({ files: { '../../_hook-bodies/x.js': { version: 3, sources: [], names: [], mappings: '' } } });
    expect((await upload(SHA_A, traversal)).status).toBe(400);
    expect((await upload(SHA_A, 'not json')).status).toBe(400);
    expect((await upload(SHA_A, new Uint8Array(20 * 1024 * 1024 + 1))).status).toBe(413);
    const owner = await session('gh:1');
    expect((await SELF.fetch(`${BASE}/v1/apps/${APP}/sourcemaps/..%2F..%2Fevil/symbolicate`, json('POST', { frames: [frame] }, owner))).status).toBe(400);
    expect((await symbolicate(SHA_A, owner, [])).status).toBe(400);
    expect((await symbolicate(SHA_A, owner, Array.from({ length: 51 }, () => frame))).status).toBe(400);
    expect((await symbolicate(SHA_A, owner, [{ source: 'x', line: 0, col: 1 }])).status).toBe(400);
    expect((await env.STORAGE.list({ prefix: '_sourcemaps/' })).objects).toEqual([]);
  });

  it('symbolication is owner-only: signed out 401, another app\'s owner refused', async () => {
    await upload(SHA_A, bundle('AASI'));
    expect((await SELF.fetch(`${BASE}/v1/apps/${APP}/sourcemaps/${SHA_A}/symbolicate`, json('POST', { frames: [frame] }))).status).toBe(401);
    const res = await symbolicate(SHA_A, await session('gh:2'));
    expect(res.status).toBeGreaterThanOrEqual(403);
    expect(await res.text()).not.toContain('src/App.tsx');
  });

  it('maps live only under the private _sourcemaps/ prefix, nowhere an app storage route reads', async () => {
    await upload(SHA_A, bundle('AASI'));
    expect((await env.STORAGE.list({ prefix: `${APP}/` })).objects).toEqual([]);
    expect((await env.STORAGE.list({ prefix: '_sourcemaps/' })).objects.map((o) => o.key)).toEqual([`_sourcemaps/${APP}/${SHA_A}/bundle.json`]);
  });

  it('owner logs ?symbolicate=true maps each row against its own build.sha; unknown or absent releases are explicit', async () => {
    await upload(SHA_A, bundle('AASI'));
    const now = Date.now();
    const stack = `TypeError: boom\n    at onClick (https://${APP}.proappstore.online/assets/index-abc.js:1:1)\n    at x (https://cdn.example/vendor.js:9:9)`;
    const row = (sha: string | null, ts: number) => env.DB.prepare(
      "INSERT INTO app_logs (app_id, ts, level, category, message, data, build_meta, source, ingested_at) VALUES (?, ?, 'error', 'runtime', 'boom', ?, ?, 'mediated', ?)",
    ).bind(APP, ts, JSON.stringify({ stack }), sha ? JSON.stringify({ sha }) : null, ts);
    await env.DB.batch([row(SHA_A, now), row('c'.repeat(40), now - 1), row(null, now - 2)]);
    const owner = await session('gh:1');

    const plain = await (await SELF.fetch(`${BASE}/v1/apps/${APP}/logs`, json('GET', undefined, owner))).json() as { logs: Record<string, unknown>[] };
    expect(plain.logs.every((l) => !('symbolication' in l))).toBe(true);

    const res = await SELF.fetch(`${BASE}/v1/apps/${APP}/logs?symbolicate=true`, json('GET', undefined, owner));
    expect(res.status).toBe(200);
    const { logs } = await res.json() as { logs: { data: { stack: string }; symbolication: { status: string; reason?: string; commitSha?: string; frames: Record<string, unknown>[] } }[] };
    expect(logs[0]!.symbolication).toMatchObject({ status: 'ok', commitSha: SHA_A });
    expect(logs[0]!.symbolication.frames[0]).toMatchObject({ originalSource: 'src/App.tsx', originalLine: 10, originalCol: 5 });
    expect(logs[0]!.symbolication.frames[1]).toMatchObject({ source: 'https://cdn.example/vendor.js', unresolved: true });
    expect(logs[0]!.data.stack).toBe(stack); // the raw stack is kept
    expect(logs[1]!.symbolication.status).toBe('missing');
    expect(logs[2]!.symbolication).toMatchObject({ status: 'missing', reason: 'no_build_sha' });

    expect((await SELF.fetch(`${BASE}/v1/apps/${APP}/logs?symbolicate=true`, json('GET', undefined, await session('gh:2')))).status).toBeGreaterThanOrEqual(403);
  });

  it('the daily sweep deletes an expired release\'s bundle (it then reads unavailable), keeps a live one, and drops year-old tombstones', async () => {
    await upload(SHA_A, bundle('AASI'));
    await upload(SHA_B, bundle('AAmBE'));
    const now = Date.now();
    await env.DB.prepare('UPDATE release_sourcemap_manifests SET expires_at = ? WHERE commit_sha = ?').bind(now - 1, SHA_A).run();

    expect(await sweepSourceMaps(env, now)).toEqual({ expired: 1, removed: 0 });
    expect(await env.STORAGE.head(`_sourcemaps/${APP}/${SHA_A}/bundle.json`)).toBeNull();
    expect(await env.STORAGE.head(`_sourcemaps/${APP}/${SHA_B}/bundle.json`)).not.toBeNull();
    const owner = await session('gh:1');
    expect(((await (await symbolicate(SHA_A, owner)).json()) as { status: string }).status).toBe('unavailable');
    expect(((await (await symbolicate(SHA_B, owner)).json()) as { status: string }).status).toBe('ok');
    expect(await sweepSourceMaps(env, now)).toEqual({ expired: 0, removed: 0 });

    await env.DB.prepare('UPDATE release_sourcemap_manifests SET uploaded_at = ? WHERE commit_sha = ?').bind(now - 366 * 24 * 3600 * 1000, SHA_A).run();
    expect(await sweepSourceMaps(env, now)).toEqual({ expired: 0, removed: 1 });
    expect((await env.DB.prepare('SELECT commit_sha FROM release_sourcemap_manifests').all()).results).toEqual([{ commit_sha: SHA_B }]);
  });

  it('one logs request loads at most 3 releases; a 4th release is skipped, not loaded', async () => {
    const shas = ['1', '2', '3', '4'].map((d) => d.repeat(40));
    for (const sha of shas) expect((await upload(sha, bundle('AASI'))).status).toBe(201);
    const now = Date.now();
    const stack = `Error\n    at f (https://${APP}.proappstore.online/assets/index-abc.js:1:1)`;
    await env.DB.batch(shas.map((sha, i) => env.DB.prepare(
      "INSERT INTO app_logs (app_id, ts, level, category, message, data, build_meta, source, ingested_at) VALUES (?, ?, 'error', 'runtime', 'e', ?, ?, 'mediated', ?)",
    ).bind(APP, now - i, JSON.stringify({ stack }), JSON.stringify({ sha }), now)));
    const { logs } = await (await SELF.fetch(`${BASE}/v1/apps/${APP}/logs?symbolicate=true`, json('GET', undefined, await session('gh:1')))).json() as { logs: { symbolication: { status: string; reason?: string } }[] };
    expect(logs.map((l) => l.symbolication.status)).toEqual(['ok', 'ok', 'ok', 'skipped']);
    expect(logs[3]!.symbolication.reason).toBe('per_request_limit');
  });
});
