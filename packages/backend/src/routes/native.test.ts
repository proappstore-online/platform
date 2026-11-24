import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { mintSession, credentialContext } from '@proappstore/build-core';
import { nativeAuthRoutes } from './native-auth.js';
import { nativeRoutes } from './native.js';
import { listingsRoutes } from './listings.js';
import { nativeCatalog, nativeHash, nativeHeartRateSamples, nativePoints, NATIVE_RELAYS, NATIVE_RETENTION_MS, pruneNativeData } from '../lib/native-companion.js';
import { handleAppEventBatch } from '../lib/app-event-consumer.js';
import type { AppEventMessage } from '../lib/app-event-queue.js';
import type { ToolManifest } from '../lib/action-sql.js';
import { validateToolSet } from '../lib/manifest/tool-set.js';
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
    INSERT INTO apps (id, creator_id, created_at) VALUES ('ski','google:1',0),('run','google:1',0),('rideshare','google:1',0),('other','google:2',0);`);
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
  describe('pairing pages a person sees render errors as pages (#680)', () => {
    const isPage = async (response: Response, status: number, text: string) => {
      expect(response.status).toBe(status);
      expect(response.headers.get('content-type')).toMatch(/^text\/html/);
      expect(response.headers.get('Content-Security-Policy')).toContain("default-src 'none'");
      expect(response.headers.get('Cache-Control')).toBe('no-store');
      const body = await response.text();
      expect(body).toContain(text); expect(body).not.toContain('Phone connected');
    };
    const approve = (p: { cookie: string }, nonce: string) => app.request('https://api.proappstore.online/v1/native/auth/approve', { method: 'POST', headers: {
      Cookie: p.cookie, Origin: 'https://api.proappstore.online', 'Content-Type': 'application/x-www-form-urlencoded',
    }, body: `nonce=${nonce}` }, env);
    /** A pairing signed in at the callback, not yet approved; returns its form nonce. */
    const signedIn = async () => {
      const p = await pairing(), code = crypto.randomUUID();
      const hash = Buffer.from(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(code))).toString('base64url');
      await db.prepare('INSERT INTO auth_exchange_codes (code_hash, claims, expires_at, created_at) VALUES (?, ?, ?, ?)')
        .bind(hash, JSON.stringify({ uid: 'google:1', login: 'Alice', roles: ['user'] }), Date.now() + 60_000, Date.now()).run();
      const callback = await request(`/native/auth/callback?code=${code}`, 'GET', undefined, undefined, { Cookie: p.cookie });
      return { ...p, nonce: (await callback.text()).match(/name="nonce" value="([a-f0-9]+)"/)![1] };
    };

    it('authorize and callback errors are HTML with the message; /start and /complete stay JSON', async () => {
      await isPage(await request('/native/auth/authorize?id=00'), 400, 'Connection expired. Start again from the ProAppStore app on your phone.');
      await isPage(await request(`/native/auth/authorize?id=${'0'.repeat(64)}`), 400, 'Connection expired.');
      await isPage(await request('/native/auth/callback?code=x'), 403, 'Start this connection from the ProAppStore app on your phone.');
      const start = await request('/native/auth/start', 'POST', {});
      expect(start.status).toBe(400); expect(start.headers.get('content-type')).toMatch(/^application\/json/);
      const p = await pairing();
      const complete = await request('/native/auth/complete', 'POST', { id: p.id, verifier: 'c'.repeat(64) });
      expect(complete.status).toBe(403); expect(complete.headers.get('content-type')).toMatch(/^application\/json/);
    });
    it('escapes the message it renders', async () => {
      // A child refusal carries an apostrophe (#669): it renders escaped, inside the page.
      db.sql.exec("UPDATE users SET is_child = 1 WHERE id = 'google:1'");
      const p = await pairing(), code = crypto.randomUUID();
      const hash = Buffer.from(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(code))).toString('base64url');
      await db.prepare('INSERT INTO auth_exchange_codes (code_hash, claims, expires_at, created_at) VALUES (?, ?, ?, ?)')
        .bind(hash, JSON.stringify({ uid: 'google:1', login: 'Alice', roles: ['user'] }), Date.now() + 60_000, Date.now()).run();
      await isPage(await request(`/native/auth/callback?code=${code}`, 'GET', undefined, undefined, { Cookie: p.cookie }), 403,
        'The ProAppStore phone app isn&#39;t available for this account.');
    });
    it('approve of an expired pairing is a 403 page, never "Phone connected", and /complete refuses', async () => {
      const p = await signedIn();
      db.sql.exec('UPDATE native_pairings SET expires_at = 1');
      await isPage(await approve(p, p.nonce), 403, 'Connection expired');
      expect((await request('/native/auth/complete', 'POST', { id: p.id, verifier: p.verifier })).status).toBe(403);
    });
    it('approve checks its own write: a pairing that expires after it was read is not reported connected', async () => {
      const p = await signedIn(), prepare = db.prepare.bind(db);
      // Expire the row in the gap between browserPairing()'s read and the approving UPDATE.
      const spy = vi.spyOn(db, 'prepare').mockImplementation((query: string) => {
        if (query.startsWith('UPDATE native_pairings SET approved = 1')) db.sql.exec('UPDATE native_pairings SET expires_at = 1');
        return prepare(query);
      });
      const response = await approve(p, p.nonce);
      spy.mockRestore();
      await isPage(response, 403, 'Connection expired. Start again from the ProAppStore app on your phone.');
      // The pairing cookie is kept: the person is told to start again, not signed out of this browser's pairing.
      expect(response.headers.get('Set-Cookie')).toBeNull();
      expect(db.sql.prepare('SELECT approved FROM native_pairings').get()).toEqual({ approved: 0 });
      expect((await request('/native/auth/complete', 'POST', { id: p.id, verifier: p.verifier })).status).toBe(403);
    });
  });
  it('refuses a child account at the callback, deletes its pairing, and refuses one flagged before /complete (#669)', async () => {
    db.sql.exec("INSERT INTO users (id, provider, provider_id, login, created_at, last_login_at, is_child) VALUES ('credential:kid','credential','kid','kid',0,0,1)");
    const p = await pairing();
    const code = crypto.randomUUID();
    const hash = Buffer.from(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(code))).toString('base64url');
    await db.prepare('INSERT INTO auth_exchange_codes (code_hash, claims, expires_at, created_at) VALUES (?, ?, ?, ?)')
      .bind(hash, JSON.stringify({ uid: 'credential:kid', login: 'kid', roles: ['user'] }), Date.now() + 60_000, Date.now()).run();
    const callback = await request(`/native/auth/callback?code=${code}`, 'GET', undefined, undefined, { Cookie: p.cookie });
    expect(callback.status).toBe(403);
    expect(await callback.text()).toContain('The ProAppStore phone app isn&#39;t available for this account.');
    expect(db.sql.prepare('SELECT 1 FROM native_pairings WHERE id = ?').all(p.id)).toHaveLength(0);
    expect((await request('/native/auth/complete', 'POST', { id: p.id, verifier: p.verifier })).status).toBe(403);
    // An adult approved in the browser, then flagged before the phone completes: no device is issued.
    const adult = await pairing(); await authorize(adult);
    db.sql.exec("UPDATE users SET is_child = 1 WHERE id = 'google:1'");
    const complete = await request('/native/auth/complete', 'POST', { id: adult.id, verifier: adult.verifier });
    expect(complete.status).toBe(403);
    expect(await complete.json()).toEqual({ error: "The ProAppStore phone app isn't available for this account." });
    expect(db.sql.prepare('SELECT * FROM native_devices').all()).toHaveLength(0);
    // is_child = 0 still pairs.
    db.sql.exec("UPDATE users SET is_child = 0 WHERE id = 'google:1'");
    expect((await device()).token).toMatch(/^ndev_/);
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
    const runStatus = (enabled: boolean, lastPointAt: number | null) => ({ available: true, enabled, lastPointAt, capabilities: {
      'location.background': { available: true, enabled, lastAt: lastPointAt }, 'heart_rate.ble': { available: true, enabled: false, lastAt: null },
    } });
    const status = async (token: string, appId = 'run') => request(`/apps/${appId}/native/status`, 'GET', undefined, token);
    const statusOf = async (uid = 'google:1') => await (await status(await readToken(uid, 'run'))).json() as Status;
    const pointIds = async (appId: string) =>
      ((await (await request(`/apps/${appId}/native/locations`, 'GET', undefined, await readToken('google:1', appId))).json()) as { points: { id: string }[] }).points.map(p => p.id);

    it('lists Run after Ski and grants it', async () => {
      const d = await device();
      const me = await (await request('/native/me', 'GET', undefined, d.token)).json() as { apps: { id: string }[] };
      expect(me.apps.map(a => a.id)).toEqual(['ski', 'run', 'rideshare']);
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
      const versions = Object.fromEntries((await nativeCatalog()).map(a => [`${a.id}/${a.capability}`, a.version]));
      expect(versions).toEqual({
        'ski/location.background': '5df42145f4869724018cb24247d4491b4b01e0181b5283905b0063558bb0c0d9',
        'run/location.background': 'bb685eb591d6084efda371e43517a1d5db1da70a54f33934b20fd518ed5f3586',
        'rideshare/location.background': '28a49db514cce6539014fe28f0d2385e97f7ae20080535d8bbf1a6ea2ab2fbdc',
        'run/heart_rate.ble': 'e38067cdcf71ad1368ed68b76625be9ce41629fbd8a18ab595c805f05e88720c',
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
      expect(await read.json()).toEqual({ available: true, enabled: false, lastPointAt: null, capabilities: {
        'location.background': { available: true, enabled: false, lastAt: null }, 'heart_rate.ble': { available: true, enabled: false, lastAt: null },
      } });
      // nativeGrants never offers it as the app's grant either: /native/me shows Run's location as not granted.
      const me = await (await request('/native/me', 'GET', undefined, d.token)).json() as { apps: { id: string; grant: unknown }[] };
      expect(me.apps.find(a => a.id === 'run')!.grant).toBeNull();
    });
    it('/native/me keeps `apps` exactly as shipped clients decode it, and adds `capabilities`', async () => {
      const d = await device(), g = await grant(d.token, 'run');
      await otherGrant(d.deviceId);
      const me = await (await request('/native/me', 'GET', undefined, d.token)).json() as { apps: Record<string, unknown>[]; capabilities: Record<string, unknown>[] };
      const all = await nativeCatalog(), catalog = all.filter(a => a.capability === 'location.background');
      // The pre-registry shape: one location entry per app, catalog fields then its location grant, in today's key order.
      expect(me.apps.map(a => Object.keys(a))).toEqual(catalog.map(() => ['id', 'name', 'capability', 'version', 'purpose', 'disclosure', 'grant']));
      expect(me.apps).toEqual(catalog.map(a => ({ ...a, grant: null })).map(a => a.id === 'run' ? { ...a, grant: me.apps[1].grant } : a));
      expect(Object.keys(me.apps[1].grant as object)).toEqual(['id', 'app_id', 'consent_at', 'contract_version', 'publisher_id']);
      expect((me.apps[1].grant as { id: string }).id).toBe(g.id);
      expect(me.capabilities).toEqual(all.map(a => ({
        appId: a.id, appName: a.name, capability: a.capability, name: a.capability === 'location.background' ? 'Location' : 'Heart rate',
        purpose: a.purpose, disclosure: a.disclosure, version: a.version,
        grant: a.id === 'run' && a.capability === 'location.background' ? me.apps[1].grant : null,
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
      expect((await detail('run')).nativeCapabilities).toEqual([{ id: 'location.background', name: 'Location' }, { id: 'heart_rate.ble', name: 'Heart rate' }]);
      expect((await detail('ski')).nativeCapabilities).toEqual([{ id: 'location.background', name: 'Location' }]);
      expect((await detail('other')).nativeCapabilities).toEqual([]);
      expect((await detail('run')).permissions).toEqual([]);
      const cards = await (await request('/storefront/apps')).json() as { apps: { appId: string; nativeCapabilities: unknown }[] };
      expect(Object.fromEntries(cards.apps.map(a => [a.appId, a.nativeCapabilities]))).toEqual({
        ski: [{ id: 'location.background', name: 'Location' }], run: [{ id: 'location.background', name: 'Location' }, { id: 'heart_rate.ble', name: 'Heart rate' }],
        rideshare: [{ id: 'location.background', name: 'Location' }], other: [],
      });
    });
  });

  describe('Run heart rate from a Bluetooth strap (#631)', () => {
    const HR = '/native/apps/run/capabilities/heart_rate.ble';
    const hrVersion = async () => (await nativeCatalog()).find(a => a.id === 'run' && a.capability === 'heart_rate.ble')!.version;
    const hrGrant = async (token: string) => {
      const response = await request(HR, 'PUT', { version: await hrVersion(), enabled: true }, token);
      expect(response.status).toBe(200);
      return (await response.json() as { grant: { id: string; consent_at: number } }).grant;
    };
    const sample = (id: string, at: number, grants: string[], bpm = 142) => ({ id, at, bpm, grants });
    const stored = () => db.sql.prepare('SELECT sample_id FROM native_heart_rate ORDER BY sample_id').all().map(r => r.sample_id);
    const read = async (token: string | Promise<string>, appId = 'run') => request(`/apps/${appId}/native/heart-rate`, 'GET', undefined, await token);
    const readIds = async (uid = 'google:1') =>
      ((await (await read(readToken(uid, 'run'))).json()) as { samples: { id: string }[] }).samples.map(s => s.id);

    it('is grantable only through its own capability path with its own version', async () => {
      const d = await device(), version = await hrVersion();
      expect((await request('/native/apps/run/location', 'PUT', { version, enabled: true }, d.token)).status).toBe(400);
      expect((await request('/native/apps/ski/capabilities/heart_rate.ble', 'PUT', { version, enabled: true }, d.token)).status).toBe(404);
      const g = await hrGrant(d.token);
      expect(db.sql.prepare('SELECT capability FROM native_grants WHERE id = ?').get(g.id)).toEqual({ capability: 'heart_rate.ble' });
      const me = await (await request('/native/me', 'GET', undefined, d.token)).json() as { apps: { id: string; grant: unknown }[]; capabilities: { appId: string; capability: string; grant: { id: string } | null }[] };
      expect(me.apps.find(a => a.id === 'run')!.grant).toBeNull();
      expect(me.capabilities.find(e => e.appId === 'run' && e.capability === 'heart_rate.ble')!.grant!.id).toBe(g.id);
    });
    it('stores only post-consent samples naming the heart-rate grant; a location grant is acknowledged and stored nowhere', async () => {
      const d = await device(), hr = await hrGrant(d.token), loc = await grant(d.token, 'run');
      const samples = [sample('valid', hr.consent_at, [hr.id]), sample('old', hr.consent_at - 1, [hr.id]),
        sample('location', Date.now(), [loc.id]), sample('unknown', Date.now(), ['f'.repeat(64)])];
      for (let i = 0; i < 2; i++) {
        const response = await request('/native/heart-rate', 'POST', { samples }, d.token);
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({ acknowledged: ['valid', 'old', 'location', 'unknown'] });
      }
      expect(stored()).toEqual(['valid']);
      expect(db.sql.prepare('SELECT * FROM native_locations').all()).toHaveLength(0);
      // Nor does a heart-rate grant id make a location point.
      await request('/native/locations', 'POST', { points: [point('p', Date.now(), [hr.id])] }, d.token);
      expect(db.sql.prepare('SELECT * FROM native_locations').all()).toHaveLength(0);
    });
    it('rejects bpm 0, 300 and 25.5, an 8-day-old sample, and malformed batches', async () => {
      const d = await device(), g = await hrGrant(d.token), now = Date.now();
      for (const samples of [[sample('a', now, [g.id], 0)], [sample('a', now, [g.id], 300)], [sample('a', now, [g.id], 25.5)],
        [sample('a', now - 8 * 24 * 60 * 60_000, [g.id])], [], [sample('a', now, [])], Array.from({ length: 301 }, (_, i) => sample(`s${i}`, now, [g.id]))]) {
        expect((await request('/native/heart-rate', 'POST', { samples }, d.token)).status).toBe(400);
      }
      expect(() => nativeHeartRateSamples([sample('x', now, [g.id]), sample('x', now, [g.id])], now)).toThrow();
      expect(nativeHeartRateSamples([sample('lo', now, [g.id], 25), sample('hi', now, [g.id], 250)], now)).toHaveLength(2);
      expect((await request('/native/heart-rate', 'POST', { samples: [sample('x', now, [g.id])] }, await readToken('google:1', 'run'))).status).toBe(401);
      expect(stored()).toEqual([]);
    });
    it('is read only by Run, for its own user, never with a device token, and up to 1,000 samples a page', async () => {
      const d = await device(), g = await hrGrant(d.token), bob = await device('google:2'), bobGrant = await hrGrant(bob.token);
      await request('/native/heart-rate', 'POST', { samples: [sample('mine', Date.now(), [g.id])] }, d.token);
      await request('/native/heart-rate', 'POST', { samples: [sample('bobs', Date.now(), [bobGrant.id])] }, bob.token);
      expect((await read(readToken('google:1', 'ski'))).status).toBe(403);
      expect((await read(d.token)).status).toBe(401);
      expect((await read(readToken('google:1', 'ski'), 'ski')).status).toBe(404);
      expect(await readIds()).toEqual(['mine']);
      expect(await readIds('google:2')).toEqual(['bobs']);
      const body = await (await read(readToken('google:1', 'run'))).json() as { samples: Record<string, unknown>[] };
      expect(Object.keys(body.samples[0]!)).toEqual(['id', 'at', 'bpm', 'cursorId']);
      // The composite cursor pages past every sample at one timestamp, 1,000 at a time.
      db.sql.prepare('UPDATE native_grants SET consent_at = 0 WHERE id = ?').run(g.id);
      const at = Date.now() - 60_000;
      for (let i = 0; i < 4; i++) {
        const samples = Array.from({ length: 300 }, (_, j) => sample(String(i * 300 + j).padStart(36, '0'), at, [g.id]));
        expect((await request('/native/heart-rate', 'POST', { samples }, d.token)).status).toBe(200);
      }
      const first = await (await read(readToken('google:1', 'run'))).json() as { samples: { at: number; cursorId: string }[] };
      expect(first.samples).toHaveLength(1000);
      const last = first.samples.at(-1)!;
      const rest = await (await request(`/apps/run/native/heart-rate?after=${last.at}&afterId=${encodeURIComponent(last.cursorId)}`, 'GET', undefined, await readToken('google:1', 'run'))).json() as { samples: unknown[] };
      expect(rest.samples).toHaveLength(201);
    });
    it('accepts the largest batch the validator allows: 300 samples, 80-char ids, 10 grants (#671)', async () => {
      const d = await device(), g = await hrGrant(d.token), now = Date.now();
      const grants = [g.id, ...Array.from({ length: 9 }, (_, i) => String(i).repeat(64))];
      const samples = Array.from({ length: 300 }, (_, i) => sample(String(i).padStart(80, '0'), now, grants, 250));
      expect(JSON.stringify({ samples }).length).toBeGreaterThan(240_000);
      expect((await request('/native/heart-rate', 'POST', { samples }, d.token)).status).toBe(200);
      expect(stored()).toHaveLength(300);
    });
    it('revoking heart rate erases it while Run location still reads, and the reverse', async () => {
      const d = await device(), hr = await hrGrant(d.token), loc = await grant(d.token, 'run');
      await request('/native/heart-rate', 'POST', { samples: [sample('h', Date.now(), [hr.id])] }, d.token);
      await request('/native/locations', 'POST', { points: [point('p', Date.now(), [loc.id])] }, d.token);
      expect((await request(HR, 'DELETE', undefined, d.token)).status).toBe(200);
      expect(await readIds()).toEqual([]);
      const locations = await (await request('/apps/run/native/locations', 'GET', undefined, await readToken('google:1', 'run'))).json() as { points: { id: string }[] };
      expect(locations.points.map(p => p.id)).toEqual(['p']);
      const again = await hrGrant(d.token);
      await request('/native/heart-rate', 'POST', { samples: [sample('h2', Date.now(), [again.id])] }, d.token);
      expect((await request('/native/apps/run/location', 'DELETE', undefined, d.token)).status).toBe(200);
      expect(await readIds()).toEqual(['h2']);
    });
    it('status reports heart rate from its own grant and table; disconnect, transfer and prune erase it', async () => {
      const d = await device(), g = await hrGrant(d.token), at = Date.now();
      const status = async () => (await (await request('/apps/run/native/status', 'GET', undefined, await readToken('google:1', 'run'))).json()) as
        { enabled: boolean; capabilities: Record<string, { enabled: boolean; lastAt: number | null }> };
      expect((await status()).capabilities['heart_rate.ble']).toEqual({ available: true, enabled: true, lastAt: null });
      await request('/native/heart-rate', 'POST', { samples: [sample('h', at, [g.id])] }, d.token);
      const s = await status();
      expect(s.capabilities['heart_rate.ble']).toEqual({ available: true, enabled: true, lastAt: at });
      // Run's location fields are location's alone.
      expect(s.enabled).toBe(false); expect(s.capabilities['location.background']).toEqual({ available: true, enabled: false, lastAt: null });
      await pruneNativeData(db, at + NATIVE_RETENTION_MS + 1);
      expect(stored()).toEqual([]);
      await request('/native/heart-rate', 'POST', { samples: [sample('h2', Date.now(), [g.id])] }, d.token);
      db.sql.exec("UPDATE apps SET creator_id='google:2' WHERE id='run'");
      expect(stored()).toEqual([]);
      db.sql.exec("UPDATE apps SET creator_id='google:1' WHERE id='run'");
      const again = await hrGrant(d.token);
      await request('/native/heart-rate', 'POST', { samples: [sample('h3', Date.now(), [again.id])] }, d.token);
      expect((await request('/native/device', 'DELETE', undefined, d.token)).status).toBe(200);
      expect(stored()).toEqual([]);
      expect(await readIds()).toEqual([]);
    });
  });

  describe('Rideshare recipient and location relay (#654)', () => {
    const RELAY = {
      name: 'native_driver_location', description: 'Driver position from the companion', operation: 'execute', requires_auth: true, callers: ['native'],
      params: { lat: { type: 'number' }, lng: { type: 'number' }, accuracy: { type: 'number' }, at: { type: 'timestamp_ms' } },
      sql: 'INSERT INTO driver_locations (driver_id, lat, lng, accuracy, at) VALUES (:__user_id, :lat, :lng, :accuracy, :at)',
    };
    let sent: { m: AppEventMessage; delaySeconds?: number }[], calls: { url: string; body: { sql: string; params: unknown[] } }[];
    let answer: () => Promise<Response>;
    beforeEach(async () => {
      sent = []; calls = []; answer = async () => Response.json({ meta: { changes: 1 } });
      env.APP_EVENTS = { send: async (m: AppEventMessage, o?: { delaySeconds?: number }) => { sent.push({ m, ...(o ? { delaySeconds: o.delaySeconds } : {}) }); } } as unknown as Env['APP_EVENTS'];
      vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => { calls.push({ url, body: JSON.parse(String(init.body)) }); return answer(); }));
      await db.prepare("INSERT INTO app_tools (app_id, name, manifest, source, state, created_at, updated_at) VALUES ('rideshare', ?, ?, 'code', 'live', 1, 1)")
        .bind(RELAY.name, JSON.stringify(RELAY)).run();
    });
    afterEach(() => { vi.unstubAllGlobals(); });
    /** Run the queued messages through the real app-events consumer, as one batch. */
    const drain = async (attempts = 1) => {
      const outcome: string[] = [];
      const messages = sent.splice(0).map(({ m }) => ({ body: m, attempts, ack: () => outcome.push('ack'), retry: () => outcome.push('retry') }));
      await handleAppEventBatch({ queue: 'pas-app-events', messages } as unknown as MessageBatch<AppEventMessage>, env);
      return outcome;
    };
    const upload = (token: string, points: ReturnType<typeof point>[]) => request('/native/locations', 'POST', { points }, token);
    const relayRow = () => db.sql.prepare('SELECT status, delivered_at FROM native_relays').get();
    /** A grant whose consent predates the test's points. */
    const relayGrant = async (token: string) => {
      const g = await grant(token, 'rideshare');
      db.sql.prepare('UPDATE native_grants SET consent_at = 0 WHERE id = ?').run(g.id);
      return g;
    };

    it('lists Rideshare with its disclosure and reports it available; only Rideshare names a relay', async () => {
      const d = await device();
      const me = await (await request('/native/me', 'GET', undefined, d.token)).json() as { apps: { id: string; name: string; disclosure: string }[] };
      const rideshare = me.apps.find(a => a.id === 'rideshare')!;
      expect(rideshare.name).toBe('Rideshare');
      expect(rideshare.disclosure).toMatch(/dispatch while you are online as a driver.*your rider while you are on their trip.*expire after 7 days.*24 hours/);
      const status = await request('/apps/rideshare/native/status', 'GET', undefined, await readToken('google:1', 'rideshare'));
      expect(await status.json()).toMatchObject({ available: true, enabled: false });
      expect(Object.keys(NATIVE_RELAYS)).toEqual(['rideshare']);
    });
    it("runs the action as the device's owner with the newest point of an upload, and nothing about the device", async () => {
      const d = await device(), g = await relayGrant(d.token), now = Date.now();
      await upload(d.token, [{ ...point('a', now - 2000, [g.id]), lat: 1 }, { ...point('c', now, [g.id]), lat: 3 }, { ...point('b', now - 1000, [g.id]), lat: 2 }]);
      expect(sent).toHaveLength(1);
      expect(sent[0]!.delaySeconds).toBeUndefined();
      expect(sent[0]!.m).toMatchObject({ type: 'native', app_id: 'rideshare', id: 'google:1', name: 'native_driver_location' });
      expect(await drain()).toEqual(['ack']);
      expect(calls).toHaveLength(1);
      expect(calls[0]!.url).toContain('/execute');
      expect(calls[0]!.body.params).toEqual(['google:1', 3, 148.4, 5, now]);
      expect(JSON.stringify(calls[0]!.body)).not.toMatch(new RegExp(`${d.deviceId}|My Pixel|${g.id}`));
      expect(relayRow()).toEqual({ status: 'idle', delivered_at: now });
      // A retried upload saves nothing new and relays nothing.
      await upload(d.token, [point('c', now, [g.id])]);
      expect(sent).toHaveLength(0);
    });
    it('coalesces uploads into the queued delivery and spaces deliveries 3 s apart', async () => {
      const d = await device(), g = await relayGrant(d.token), now = Date.now();
      await upload(d.token, [point('a', now - 3000, [g.id])]);
      await upload(d.token, [point('b', now - 2000, [g.id])]);
      expect(sent).toHaveLength(1);
      await drain();
      expect(calls.map(c => c.body.params[4])).toEqual([now - 2000]);
      // The delivery just ran: the next one waits until 3 s after it.
      await upload(d.token, [point('c', now - 1000, [g.id])]);
      expect(sent).toHaveLength(1);
      expect(sent[0]!.delaySeconds).toBeGreaterThanOrEqual(2);
      expect(sent[0]!.delaySeconds).toBeLessThanOrEqual(3);
      // A point saved while a delivery runs coalesced into it, so that delivery re-arms the relay for it.
      answer = async () => { answer = async () => Response.json({ meta: { changes: 1 } }); await upload(d.token, [point('d', now, [g.id])]); return Response.json({ meta: { changes: 1 } }); };
      await drain();
      expect(calls.map(c => c.body.params[4])).toEqual([now - 2000, now - 1000]);
      expect(sent).toHaveLength(1);
      await drain();
      expect(calls.map(c => c.body.params[4])).toEqual([now - 2000, now - 1000, now]);
      expect(sent).toHaveLength(0);
    });
    it('relays nothing without a grant, for another app, or for Ski and Run', async () => {
      const d = await device(), ski = await grant(d.token, 'ski'), run = await grant(d.token, 'run');
      await upload(d.token, [point('s', Date.now(), [ski.id]), point('r', Date.now(), [run.id])]);
      expect(sent).toHaveLength(0);
      const bob = await device('google:2'), bobRun = await grant(bob.token, 'run');
      await upload(bob.token, [point('b', Date.now(), [bobRun.id])]);
      expect(sent).toHaveLength(0);
      expect(db.sql.prepare('SELECT 1 FROM native_relays').all()).toHaveLength(0);
    });
    it.each([
      ['revocation', (d: { token: string }) => request('/native/apps/rideshare/location', 'DELETE', undefined, d.token)],
      ['publisher transfer', async () => { db.sql.exec("UPDATE apps SET creator_id='google:2' WHERE id='rideshare'"); }],
      ['disclosure change', async () => { db.sql.exec("UPDATE native_grants SET contract_version='stale'"); }],
      ['device expiry', async () => { db.sql.exec('UPDATE native_devices SET expires_at=0'); }],
    ])('a %s between upload and delivery stops the delivery', async (_, change) => {
      const d = await device(), g = await relayGrant(d.token);
      await upload(d.token, [point('p', Date.now(), [g.id])]);
      expect(sent).toHaveLength(1);
      await change(d);
      expect(await drain()).toEqual(['ack']);
      expect(calls).toHaveLength(0);
      expect(relayRow()).toEqual({ status: 'idle', delivered_at: null });
    });
    it('retries a data-worker failure, drops a point the action refuses once, and frees the row on dead-letter', async () => {
      const d = await device(), g = await relayGrant(d.token), now = Date.now();
      answer = async () => new Response('down', { status: 503 });
      await upload(d.token, [point('a', now - 1000, [g.id])]);
      const queued = [...sent];
      expect(await drain()).toEqual(['retry']);
      expect(relayRow()).toMatchObject({ status: 'queued' });
      sent.push(...queued);
      await handleAppEventBatch({ queue: 'pas-app-events-dlq', messages: sent.splice(0).map(({ m }) => ({ body: m, attempts: 1, ack() {}, retry() {} })) } as unknown as MessageBatch<AppEventMessage>, env);
      expect(relayRow()).toEqual({ status: 'idle', delivered_at: null });
      // A 4xx is the action refusing this point: it is given up on, not retried, and not tried again in a loop.
      answer = async () => new Response('constraint', { status: 400 });
      await upload(d.token, [point('b', now, [g.id])]);
      expect(await drain()).toEqual(['ack']);
      expect(relayRow()).toEqual({ status: 'idle', delivered_at: now });
      expect(sent).toHaveLength(0);
    });
    it('refuses an action whose manifest is no longer a relay action at delivery', async () => {
      const d = await device(), g = await relayGrant(d.token);
      db.sql.prepare("UPDATE app_tools SET manifest = ? WHERE app_id = 'rideshare'").run(JSON.stringify({ ...RELAY, callers: ['user', 'native'] }));
      await upload(d.token, [point('p', Date.now(), [g.id])]);
      expect(await drain()).toEqual(['ack']);
      expect(calls).toHaveLength(0);
    });
    it('registration refuses a "native" caller anywhere but the reviewed relay action, in its exact shape', async () => {
      const register = async (appId: string, over: Record<string, unknown>) =>
        ((await validateToolSet([{ ...RELAY, ...over } as ToolManifest], undefined, appId))?.payload.error ?? null) as string | null;
      expect(await register('rideshare', {})).toBeNull();
      expect(await register('run', {})).toMatch(/reserved for the action the reviewed native catalog relays to, and this app has none/);
      expect(await register('rideshare', { name: 'set_location' })).toMatch(/reserved .*\("native_driver_location"\)/);
      expect(await register('rideshare', { callers: ['user', 'native'] })).toMatch(/callers: \["native"\] only/);
      expect(await register('rideshare', { operation: 'query', sql: 'SELECT :lat + :lng + :accuracy + :at AS v FROM drivers WHERE id = :__user_id LIMIT 1' })).toMatch(/execute or batch/);
      expect(await register('rideshare', { auth: { app_roles: ['driver'] } })).toMatch(/role-gated/);
      expect(await register('rideshare', { params: { ...RELAY.params, speed: { type: 'number' } } })).toMatch(/exactly the params/);
      expect(await register('rideshare', { params: { ...RELAY.params, lat: { type: 'string' } } })).toMatch(/exactly the params/);
      expect(await register('rideshare', { callers: ['natives'] })).toMatch(/callers must be a non-empty array of .*"native"/);
    });
  });
});
