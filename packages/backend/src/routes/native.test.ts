import { beforeEach, describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { mintSession, credentialContext } from '@proappstore/build-core';
import { nativeAuthRoutes } from './native-auth.js';
import { nativeRoutes } from './native.js';
import { nativeCatalog, nativeHash, nativePoints, NATIVE_RETENTION_MS, pruneNativeData } from '../lib/native-companion.js';
import { HttpError } from '../lib/auth.js';
import { sqliteD1 } from '../sqlite-d1.js';
import { makeEnv, TEST_SK } from '../test-helpers.js';
import type { Env } from '../types.js';

const app = new Hono<{ Bindings: Env }>();
app.route('/v1', nativeAuthRoutes); app.route('/v1', nativeRoutes);
app.onError((e, c) => c.json({ error: e.message }, (e instanceof HttpError ? e.status : 500) as 400));
let db: ReturnType<typeof sqliteD1>, env: Env;
const request = (path: string, method = 'GET', body?: unknown, token?: string, headers = {}) => app.request(`https://api.proappstore.online/v1${path}`, {
  method, headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
}, env);
beforeEach(() => {
  db = sqliteD1(); env = makeEnv({ DB: db, APP_BASE: 'https://api.proappstore.online' }) as Env;
  db.sql.exec(`PRAGMA foreign_keys=ON;
    INSERT INTO users (id, provider, provider_id, login, created_at, last_login_at) VALUES
      ('google:1','google','1','Alice',0,0),('google:2','google','2','Bob',0,0);
    INSERT INTO apps (id, creator_id, created_at) VALUES ('ski','google:1',0),('run','google:1',0),('other','google:2',0);`);
});
async function pairing() {
  const verifier = 'b'.repeat(64);
  const start = await request('/native/auth/start', 'POST', { challenge: await nativeHash(verifier), label: 'My Pixel' });
  expect(start.status).toBe(200);
  const { id } = await start.json() as { id: string };
  const auth = await request(`/native/auth/authorize?id=${id}`);
  const cookie = auth.headers.get('Set-Cookie')!.split(';')[0];
  return { id, verifier, cookie };
}
async function authorize(p: Awaited<ReturnType<typeof pairing>>, uid = 'google:1') {
  const code = crypto.randomUUID();
  const hash = Buffer.from(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(code))).toString('base64url');
  await db.prepare('INSERT INTO auth_exchange_codes (code_hash, claims, expires_at, created_at) VALUES (?, ?, ?, ?)')
    .bind(hash, JSON.stringify({ uid, login: 'Alice', roles: ['user'] }), Date.now() + 60_000, Date.now()).run();
  const callback = await request(`/native/auth/callback?code=${code}`, 'GET', undefined, undefined, { Cookie: p.cookie });
  expect(callback.status).toBe(200);
  // Under no-referrer a real browser would POST the approve form with `Origin: null`.
  expect(callback.headers.get('Referrer-Policy')).toBe('same-origin');
  const nonce = (await callback.text()).match(/name="nonce" value="([a-f0-9]+)"/)![1];
  const result = await app.request('https://api.proappstore.online/v1/native/auth/approve', { method: 'POST', headers: {
    Cookie: p.cookie, Origin: 'https://api.proappstore.online', 'Content-Type': 'application/x-www-form-urlencoded',
  }, body: `nonce=${nonce}` }, env);
  expect(result.status).toBe(200);
}
async function device(uid = 'google:1') {
  const p = await pairing(); await authorize(p, uid);
  const response = await request('/native/auth/complete', 'POST', { id: p.id, verifier: p.verifier });
  expect(response.status).toBe(200);
  return await response.json() as { token: string; deviceId: string };
}
async function grant(token: string, appId = 'ski') {
  const catalog = await (await request('/native/me', 'GET', undefined, token)).json() as { apps: { id: string; version: string }[] };
  const response = await request(`/native/apps/${appId}/location`, 'PUT', { version: catalog.apps.find(a => a.id === appId)!.version, enabled: true }, token);
  expect(response.status).toBe(200);
  return (await response.json() as { grant: { id: string; consent_at: number } }).grant;
}
const point = (id: string, at: number, grants: string[]) => ({ id, at, lat: -36.4, lng: 148.4, accuracy: 5, grants });
const readToken = (uid: string, appId = 'ski') => mintSession({ uid, roles: ['user'], cred: credentialContext('app_bound', appId) }, TEST_SK);

describe('consumer native companion', () => {
  it('requires browser confirmation AND the initiating device proof; consumes approval once', async () => {
    const p = await pairing();
    expect((await request('/native/auth/complete', 'POST', { id: p.id, verifier: p.verifier })).status).toBe(202);
    expect((await request('/native/auth/complete', 'POST', { id: p.id, verifier: 'c'.repeat(64) })).status).toBe(403);
    await authorize(p);
    const response = await request('/native/auth/complete', 'POST', { id: p.id, verifier: p.verifier });
    const result = await response.json() as { token: string };
    expect(result.token).toMatch(/^ndev_[a-f0-9]{64}$/);
    expect(db.sql.prepare('SELECT token_hash FROM native_devices').get()!.token_hash).not.toBe(result.token);
    expect((await request('/native/auth/complete', 'POST', { id: p.id, verifier: p.verifier })).status).toBe(403);
    const me = await (await request('/native/me', 'GET', undefined, result.token)).json() as { user: { id: string }; apps: { grant: unknown }[] };
    expect(me.user.id).toBe('google:1'); expect(me.apps[0].grant).toBeNull();
  });
  it('rejects missing browser binding, cross-origin approval, expired pairing and malformed challenge', async () => {
    expect((await request('/native/auth/start', 'POST', null)).status).toBe(400);
    expect((await request('/native/auth/start', 'POST', { label: 'x'.repeat(5000) })).status).toBe(413);
    expect((await request('/native/auth/start', 'POST', { challenge: 'bad', label: 'Phone' })).status).toBe(400);
    const p = await pairing();
    expect((await request('/native/auth/callback?code=bad')).status).toBe(403);
    expect((await request('/native/auth/approve', 'POST', { nonce: 'bad' }, undefined, { Origin: 'https://ski.proappstore.online', Cookie: p.cookie })).status).toBe(403);
    expect((await request('/native/auth/approve', 'POST', { nonce: 'bad' }, undefined, { Origin: 'null', Cookie: p.cookie })).status).toBe(403);
    db.sql.exec('UPDATE native_pairings SET expires_at=0');
    expect((await request('/native/auth/complete', 'POST', { id: p.id, verifier: p.verifier })).status).toBe(403);
  });
  it('stores only explicitly granted, post-consent points and makes retries idempotent', async () => {
    const d = await device(), g = await grant(d.token);
    const points = [point('valid', g.consent_at, [g.id]), point('old', g.consent_at - 1, [g.id]), point('unknown', g.consent_at, ['f'.repeat(64)])];
    for (let i = 0; i < 2; i++) expect((await request('/native/locations', 'POST', { points }, d.token)).status).toBe(200);
    expect(db.sql.prepare('SELECT point_id FROM native_locations').all()).toEqual([{ point_id: 'valid' }]);
  });
  it('isolates app, user and device identities and never treats a session as native permission', async () => {
    const d = await device(), g = await grant(d.token), other = await device('google:2');
    expect((await request('/native/locations', 'POST', { points: [point('forged', Date.now(), [g.id])] }, other.token)).status).toBe(200);
    expect(db.sql.prepare('SELECT * FROM native_locations').all()).toHaveLength(0);
    await request('/native/locations', 'POST', { points: [point('mine', Date.now(), [g.id])] }, d.token);
    const me = await readToken('google:1'), stranger = await readToken('google:2'), wrongApp = await readToken('google:1', 'other');
    expect((await request('/native/apps/ski/location', 'PUT', { enabled: true, version: '1' }, me)).status).toBe(401);
    expect((await request('/apps/ski/native/locations', 'GET', undefined, wrongApp)).status).toBe(403);
    expect((await request('/apps/ski/native/locations', 'GET', undefined, d.token)).status).toBe(401);
    expect((await (await request('/apps/ski/native/locations', 'GET', undefined, stranger)).json() as { points: unknown[] }).points).toHaveLength(0);
    expect((await (await request('/apps/ski/native/locations', 'GET', undefined, me)).json() as { points: unknown[] }).points).toHaveLength(1);
  });
  it('revokes historical access and rejects queued points after regrant or publisher transfer', async () => {
    const d = await device(), g = await grant(d.token);
    await request('/native/locations', 'POST', { points: [point('before', Date.now(), [g.id])] }, d.token);
    await request('/native/apps/ski/location', 'DELETE', undefined, d.token);
    expect(db.sql.prepare('SELECT * FROM native_locations').all()).toHaveLength(0);
    const newGrant = await grant(d.token); expect(newGrant.id).not.toBe(g.id);
    await request('/native/locations', 'POST', { points: [point('queued', Date.now(), [g.id])] }, d.token);
    expect(db.sql.prepare('SELECT * FROM native_locations').all()).toHaveLength(0);
    db.sql.exec("UPDATE apps SET creator_id='google:2' WHERE id='ski'");
    await request('/native/locations', 'POST', { points: [point('transferred', Date.now(), [newGrant.id])] }, d.token);
    expect(db.sql.prepare('SELECT * FROM native_locations').all()).toHaveLength(0);
  });
  it('refuses unsupported apps, stale contracts, non-consent and malformed batches', async () => {
    const d = await device();
    expect((await request('/native/apps/other/location', 'PUT', { version: '1', enabled: true }, d.token)).status).toBe(404);
    expect((await request('/native/apps/ski/location', 'PUT', { version: '0', enabled: true }, d.token)).status).toBe(400);
    expect((await request('/native/apps/ski/location', 'PUT', { version: '1', enabled: false }, d.token)).status).toBe(400);
    for (const points of [[], [point('x', Date.now(), [])], [point('x', 0, ['a'.repeat(64)])], [{ ...point('x', Date.now(), ['a'.repeat(64)]), lat: 91 }]]) {
      expect((await request('/native/locations', 'POST', { points }, d.token)).status).toBe(400);
    }
    expect(() => nativePoints([point('x', Date.now(), ['a'.repeat(64)]), point('x', Date.now(), ['a'.repeat(64)])], Date.now())).toThrow();
  });
  it('disconnect removes grants and points, and expired devices cannot ingest', async () => {
    const d = await device(), g = await grant(d.token);
    await request('/native/locations', 'POST', { points: [point('x', Date.now(), [g.id])] }, d.token);
    expect((await request('/native/device', 'DELETE', undefined, d.token)).status).toBe(200);
    expect(db.sql.prepare('SELECT * FROM native_locations').all()).toHaveLength(0);
    expect((await request('/native/me', 'GET', undefined, d.token)).status).toBe(401);
    const expired = await device(); db.sql.exec('UPDATE native_devices SET expires_at=0');
    expect((await request('/native/me', 'GET', undefined, expired.token)).status).toBe(401);
  });
  it('per-app account deletion immediately erases native access and prevents new grants', async () => {
    const d = await device(), g = await grant(d.token);
    await request('/native/locations', 'POST', { points: [point('x', Date.now(), [g.id])] }, d.token);
    await db.prepare('INSERT INTO per_app_deleted_users (app_id, user_id, deleted_by, deleted_at) VALUES (?, ?, ?, ?)')
      .bind('ski', 'google:1', 'google:1', Date.now()).run();
    expect(db.sql.prepare('SELECT * FROM native_grants').all()).toHaveLength(0);
    expect(db.sql.prepare('SELECT * FROM native_locations').all()).toHaveLength(0);
    const catalog = await (await request('/native/me', 'GET', undefined, d.token)).json() as { apps: { version: string }[] };
    expect((await request('/native/apps/ski/location', 'PUT', { version: catalog.apps[0].version, enabled: true }, d.token)).status).toBe(403);
  });
  it('physically prunes expired points and device credentials', async () => {
    const d = await device(), g = await grant(d.token);
    await request('/native/locations', 'POST', { points: [point('x', Date.now(), [g.id])] }, d.token);
    await pruneNativeData(db, Date.now() + NATIVE_RETENTION_MS + 1);
    expect(db.sql.prepare('SELECT * FROM native_locations').all()).toHaveLength(0);
    await pruneNativeData(db, Date.now() + 100 * 24 * 60 * 60_000);
    expect(db.sql.prepare('SELECT * FROM native_devices').all()).toHaveLength(0);
  });

  describe('Run recipient and status read (#613)', () => {
    type Status = { available: boolean; enabled: boolean; lastPointAt: number | null };
    const status = async (token: string, appId = 'run') => request(`/apps/${appId}/native/status`, 'GET', undefined, token);
    const statusOf = async (uid = 'google:1') => await (await status(await readToken(uid, 'run'))).json() as Status;
    const pointIds = async (appId: string) =>
      ((await (await request(`/apps/${appId}/native/locations`, 'GET', undefined, await readToken('google:1', appId))).json()) as { points: { id: string }[] }).points.map(p => p.id);

    it('lists Run after Ski and grants it', async () => {
      const d = await device();
      const me = await (await request('/native/me', 'GET', undefined, d.token)).json() as { apps: { id: string }[] };
      expect(me.apps.map(a => a.id)).toEqual(['ski', 'run']);
      expect((await grant(d.token, 'run')).id).toMatch(/^[a-f0-9]{64}$/);
    });
    it('delivers a point only to the app whose grant it carries', async () => {
      const d = await device(), ski = await grant(d.token, 'ski'), run = await grant(d.token, 'run');
      await request('/native/locations', 'POST', { points: [point('run-only', Date.now(), [run.id]), point('ski-only', Date.now(), [ski.id])] }, d.token);
      expect(await pointIds('run')).toEqual(['run-only']);
      expect(await pointIds('ski')).toEqual(['ski-only']);
    });
    it('gates status like the locations read and reports apps outside the catalog as unavailable', async () => {
      const d = await device();
      expect((await status(await readToken('google:1', 'ski'))).status).toBe(403);
      expect((await status(d.token)).status).toBe(401);
      const other = await status(await readToken('google:2', 'other'), 'other');
      expect(other.status).toBe(200);
      expect(await other.json()).toEqual({ available: false, enabled: false, lastPointAt: null });
    });
    it('tracks grant, upload, revocation, publisher transfer and device expiry', async () => {
      expect(await statusOf()).toEqual({ available: true, enabled: false, lastPointAt: null });
      const d = await device(), g = await grant(d.token, 'run');
      expect(await statusOf()).toEqual({ available: true, enabled: true, lastPointAt: null });
      const at = Date.now();
      await request('/native/locations', 'POST', { points: [point('p1', at, [g.id])] }, d.token);
      expect(await statusOf()).toEqual({ available: true, enabled: true, lastPointAt: at });
      await request('/native/apps/run/location', 'DELETE', undefined, d.token);
      expect(await statusOf()).toEqual({ available: true, enabled: false, lastPointAt: null });
      await grant(d.token, 'run');
      db.sql.exec("UPDATE apps SET creator_id='google:2' WHERE id='run'");
      expect((await statusOf()).enabled).toBe(false);
      db.sql.exec("UPDATE apps SET creator_id='google:1' WHERE id='run'");
      await grant(d.token, 'run');
      expect((await statusOf()).enabled).toBe(true);
      db.sql.exec('UPDATE native_devices SET expires_at=0');
      expect((await statusOf()).enabled).toBe(false);
    });
    it("never reports another user's grant", async () => {
      const bob = await device('google:2');
      await grant(bob.token, 'run');
      expect((await statusOf('google:2')).enabled).toBe(true);
      expect(await statusOf()).toEqual({ available: true, enabled: false, lastPointAt: null });
    });
    it('pins each contract version: a wording edit revokes every existing grant and must fail here', async () => {
      const versions = Object.fromEntries((await nativeCatalog()).map(a => [a.id, a.version]));
      expect(versions).toEqual({ 
        ski: '5df42145f4869724018cb24247d4491b4b01e0181b5283905b0063558bb0c0d9',
        run: 'bb685eb591d6084efda371e43517a1d5db1da70a54f33934b20fd518ed5f3586',
       });
    });
  });
});
