import { beforeEach, describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { mintSession, credentialContext } from '@proappstore/build-core';
import { nativeAuthRoutes } from './native-auth.js';
import { nativeRoutes } from './native.js';
import { listingsRoutes } from './listings.js';
import { nativeCatalog, nativeHash, nativePoints, NATIVE_RETENTION_MS, pruneNativeData } from '../lib/native-companion.js';
import { HttpError } from '../lib/auth.js';
import { sqliteD1 } from '../sqlite-d1.js';
import { makeEnv, TEST_SK } from '../test-helpers.js';
import type { Env } from '../types.js';

const app = new Hono<{ Bindings: Env }>();
app.route('/v1', nativeAuthRoutes); app.route('/v1', nativeRoutes); app.route('/v1', listingsRoutes);
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
  it('binds a pairing to the first browser that opens it; only that browser may reopen it (#650)', async () => {
    const p = await pairing();
    const reload = await request(`/native/auth/authorize?id=${p.id}`, 'GET', undefined, undefined, { Cookie: p.cookie });
    expect(reload.status).toBe(200);
    expect(reload.headers.get('Set-Cookie')!.split(';')[0]).toBe(p.cookie);
    expect((await request(`/native/auth/authorize?id=${p.id}`)).status).toBe(403);
    const forged = `${p.cookie.split('=')[0]}=${p.id}.${'c'.repeat(64)}`;
    expect((await request(`/native/auth/authorize?id=${p.id}`, 'GET', undefined, undefined, { Cookie: forged })).status).toBe(403);
    await authorize(p);
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
    type Status = { available: boolean; enabled: boolean; lastPointAt: number | null; capabilities: Record<string, unknown> };
    // ADR-018 §6: the top-level fields stay location's; `capabilities` repeats them per capability id.
    const runStatus = (enabled: boolean, lastPointAt: number | null) =>
      ({ available: true, enabled, lastPointAt, capabilities: { 'location.background': { available: true, enabled, lastAt: lastPointAt } } });
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
      expect(await other.json()).toEqual({ available: false, enabled: false, lastPointAt: null, capabilities: {} });
    });
    it('tracks grant, upload, revocation, publisher transfer and device expiry', async () => {
      expect(await statusOf()).toEqual(runStatus(false, null));
      const d = await device(), g = await grant(d.token, 'run');
      expect(await statusOf()).toEqual(runStatus(true, null));
      const at = Date.now();
      await request('/native/locations', 'POST', { points: [point('p1', at, [g.id])] }, d.token);
      expect(await statusOf()).toEqual(runStatus(true, at));
      await request('/native/apps/run/location', 'DELETE', undefined, d.token);
      expect(await statusOf()).toEqual(runStatus(false, null));
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
      expect(await statusOf()).toEqual(runStatus(false, null));
    });
    it('pins each contract version: a wording edit revokes every existing grant and must fail here', async () => {
      const versions = Object.fromEntries((await nativeCatalog()).map(a => [a.id, a.version]));
      expect(versions).toEqual({ 
        ski: '5df42145f4869724018cb24247d4491b4b01e0181b5283905b0063558bb0c0d9',
        run: 'bb685eb591d6084efda371e43517a1d5db1da70a54f33934b20fd518ed5f3586',
       });
    });
  });

  describe('native capability registry (#629, ADR-018)', () => {
    // No second reviewed entry exists yet, so another capability's grant is inserted directly, as a later capability would.
    const otherGrant = async (deviceId: string, appId = 'run') => {
      const id = 'e'.repeat(64);
      db.sql.prepare(`INSERT INTO native_grants (id, device_id, app_id, publisher_id, capability, contract_version, consent_at)
        VALUES (?, ?, ?, 'google:1', 'test.other', 'v-other', 0)`).run(id, deviceId, appId);
      return id;
    };
    const hasOther = () => db.sql.prepare("SELECT 1 FROM native_grants WHERE capability = 'test.other'").all().length === 1;

    it("revoking or re-enabling location never touches the app's other capability grant", async () => {
      const d = await device();
      await otherGrant(d.deviceId);
      await grant(d.token, 'run');
      expect((await request('/native/apps/run/location', 'DELETE', undefined, d.token)).status).toBe(200);
      expect(hasOther()).toBe(true);
      await grant(d.token, 'run');
      // An obsolete location grant is replaced; the replace delete must be scoped to location too.
      db.sql.exec("UPDATE native_grants SET contract_version = 'stale' WHERE capability = 'location.background'");
      await grant(d.token, 'run');
      expect(hasOther()).toBe(true);
      expect((await request('/native/apps/run/capabilities/location.background', 'DELETE', undefined, d.token)).status).toBe(200);
      expect(hasOther()).toBe(true);
      expect(db.sql.prepare("SELECT 1 FROM native_grants WHERE capability = 'location.background'").all()).toHaveLength(0);
    });
    it('a point naming another capability grant is acknowledged and stored nowhere, and never read as location', async () => {
      const d = await device(), other = await otherGrant(d.deviceId), loc = await grant(d.token, 'run');
      // Same app and contract version as the location grant: only the capability tells them apart.
      db.sql.exec("UPDATE native_grants SET contract_version = (SELECT contract_version FROM native_grants WHERE capability = 'location.background') WHERE capability = 'test.other'");
      const response = await request('/native/locations', 'POST', { points: [point('x', Date.now(), [other]), point('y', Date.now(), [other, loc.id])] }, d.token);
      expect(await response.json()).toEqual({ acknowledged: ['x', 'y'] });
      expect(db.sql.prepare('SELECT grant_id, point_id FROM native_locations').all()).toEqual([{ grant_id: loc.id, point_id: 'y' }]);
      // Even a row that got under it some other way is never served as the app's location.
      db.sql.prepare("INSERT INTO native_locations VALUES (?, 'z', ?, 1, 2, 3)").run(other, Date.now());
      const read = await request('/apps/run/native/locations', 'GET', undefined, await readToken('google:1', 'run'));
      expect((await read.json() as { points: { id: string }[] }).points.map(p => p.id)).toEqual(['y']);
    });
    it('status reports location from location grants only, even when another grant carries the same version', async () => {
      const d = await device(), runVersion = (await nativeCatalog())[1].version;
      await otherGrant(d.deviceId);
      db.sql.prepare("UPDATE native_grants SET contract_version = ? WHERE capability = 'test.other'").run(runVersion);
      const read = await request('/apps/run/native/status', 'GET', undefined, await readToken('google:1', 'run'));
      expect(await read.json()).toEqual({ available: true, enabled: false, lastPointAt: null,
        capabilities: { 'location.background': { available: true, enabled: false, lastAt: null } } });
      // nativeGrants never offers it as the app's grant either: /native/me shows Run's location as not granted.
      const me = await (await request('/native/me', 'GET', undefined, d.token)).json() as { apps: { id: string; grant: unknown }[] };
      expect(me.apps.find(a => a.id === 'run')!.grant).toBeNull();
    });
    it('/native/me keeps `apps` exactly as shipped clients decode it, and adds `capabilities`', async () => {
      const d = await device(), g = await grant(d.token, 'run');
      await otherGrant(d.deviceId);
      const me = await (await request('/native/me', 'GET', undefined, d.token)).json() as { apps: Record<string, unknown>[]; capabilities: Record<string, unknown>[] };
      const catalog = await nativeCatalog();
      // The pre-registry shape: one location entry per app, catalog fields then its location grant, in today's key order.
      expect(me.apps.map(a => Object.keys(a))).toEqual(catalog.map(() => ['id', 'name', 'capability', 'version', 'purpose', 'disclosure', 'grant']));
      expect(me.apps).toEqual(catalog.map(a => ({ ...a, grant: null })).map(a => a.id === 'run' ? { ...a, grant: me.apps[1].grant } : a));
      expect(Object.keys(me.apps[1].grant as object)).toEqual(['id', 'app_id', 'consent_at', 'contract_version', 'publisher_id']);
      expect((me.apps[1].grant as { id: string }).id).toBe(g.id);
      expect(me.capabilities).toEqual(catalog.map(a => ({
        appId: a.id, appName: a.name, capability: 'location.background', name: 'Location', purpose: a.purpose, disclosure: a.disclosure,
        version: a.version, grant: a.id === 'run' ? me.apps[1].grant : null,
      })));
    });
    it('PUT …/capabilities/:capability behaves exactly like PUT …/location', async () => {
      const d = await device(), path = '/native/apps/ski/capabilities/location.background';
      const version = (await nativeCatalog())[0].version;
      expect((await request('/native/apps/other/capabilities/location.background', 'PUT', { version, enabled: true }, d.token)).status).toBe(404);
      expect((await request('/native/apps/ski/capabilities/test.other', 'PUT', { version, enabled: true }, d.token)).status).toBe(404);
      expect((await request(path, 'PUT', { version: '0', enabled: true }, d.token)).status).toBe(400);
      expect((await request(path, 'PUT', { version, enabled: false }, d.token)).status).toBe(400);
      const created = await (await request(path, 'PUT', { version, enabled: true }, d.token)).json() as { grant: { id: string } };
      // Idempotent across both paths: the same grant either way.
      expect((await (await request('/native/apps/ski/location', 'PUT', { version, enabled: true }, d.token)).json() as { grant: { id: string } }).grant.id).toBe(created.grant.id);
      await db.prepare('INSERT INTO per_app_deleted_users (app_id, user_id, deleted_by, deleted_at) VALUES (?, ?, ?, ?)').bind('ski', 'google:1', 'google:1', Date.now()).run();
      expect((await request(path, 'PUT', { version, enabled: true }, d.token)).status).toBe(403);
    });
    it('the storefront listing names each app\'s reviewed native capabilities, never via `permissions`', async () => {
      const detail = async (id: string) => await (await request(`/storefront/apps/${id}`)).json() as { nativeCapabilities: unknown; permissions: unknown[] };
      expect((await detail('run')).nativeCapabilities).toEqual([{ id: 'location.background', name: 'Location' }]);
      expect((await detail('ski')).nativeCapabilities).toEqual([{ id: 'location.background', name: 'Location' }]);
      expect((await detail('other')).nativeCapabilities).toEqual([]);
      expect((await detail('run')).permissions).toEqual([]);
      const cards = await (await request('/storefront/apps')).json() as { apps: { appId: string; nativeCapabilities: unknown }[] };
      expect(Object.fromEntries(cards.apps.map(a => [a.appId, a.nativeCapabilities]))).toEqual({
        ski: [{ id: 'location.background', name: 'Location' }], run: [{ id: 'location.background', name: 'Location' }], other: [],
      });
    });
  });
});
