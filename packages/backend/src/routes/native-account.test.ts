import { beforeEach, describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { mintSession, credentialContext } from '@proappstore/build-core';
import { nativeRoutes } from './native.js';
import { nativeAccountRoutes, nativeDiagnosticsSnapshot, NATIVE_DIAGNOSTICS_MAX } from './native-account.js';
import { nativeHash, NATIVE_RETENTION_MS, pruneNativeData } from '../lib/native-companion.js';
import { HttpError } from '../lib/auth.js';
import { sqliteD1 } from '../sqlite-d1.js';
import { makeEnv, TEST_SK } from '../test-helpers.js';
import type { Env } from '../types.js';

/** #660 / ADR-019: the user's own native reads (session + internal token) and the phone's diagnostics report. */
const app = new Hono<{ Bindings: Env }>();
app.route('/v1', nativeRoutes); app.route('/v1', nativeAccountRoutes);
app.onError((e, c) => c.json({ error: e.message }, (e instanceof HttpError ? e.status : 500) as 400));
const INTERNAL = 'internal-secret';
let db: ReturnType<typeof sqliteD1>, env: Env;
const request = (path: string, init: { method?: string; body?: unknown; raw?: string; token?: string; headers?: Record<string, string> } = {}) =>
  app.request(`https://api.proappstore.online/v1${path}`, {
    method: init.method ?? 'GET',
    headers: { ...(init.body !== undefined || init.raw ? { 'Content-Type': 'application/json' } : {}), ...(init.token ? { Authorization: `Bearer ${init.token}` } : {}), ...init.headers },
    ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : init.raw ? { body: init.raw } : {}),
  }, env);
const session = (uid: string, appId?: string) => mintSession({ uid, roles: ['user'], ...(appId ? { cred: credentialContext('app_bound', appId) } : {}) }, TEST_SK);
/** The MCP's call: the user's session and the first-party token. */
const owner = async (path: string, uid = 'google:1') => request(path, { token: await session(uid), headers: { 'X-Internal-Token': INTERNAL } });

const ALICE_PHONE = 'a'.repeat(64), ALICE_TABLET = 'b'.repeat(64), BOB_PHONE = 'c'.repeat(64);
const tokenOf = (id: string) => `ndev_${id.split('').reverse().join('')}`;
async function addDevice(id: string, uid: string, label: string) {
  await db.prepare('INSERT INTO native_devices (id, user_id, label, token_hash, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)')
    .bind(id, uid, label, await nativeHash(tokenOf(id)), Date.now(), Date.now() + 90 * 86_400_000).run();
}
async function enable(deviceId: string, appId: string, capability = 'location.background') {
  const me = await (await request('/native/me', { token: tokenOf(deviceId) })).json() as { capabilities: { appId: string; capability: string; version: string }[] };
  const version = me.capabilities.find(e => e.appId === appId && e.capability === capability)!.version;
  const path = capability === 'location.background' ? `/native/apps/${appId}/location` : `/native/apps/${appId}/capabilities/${capability}`;
  const response = await request(path, { method: 'PUT', body: { enabled: true, version }, token: tokenOf(deviceId) });
  expect(response.status).toBe(200);
  return (await response.json() as { grant: { id: string; consent_at: number } }).grant;
}
const insertPoint = (grant: string, id: string, at: number) =>
  db.sql.prepare('INSERT INTO native_locations (grant_id, point_id, recorded_at, latitude, longitude, accuracy) VALUES (?, ?, ?, 1, 2, 5)').run(grant, id, at);

/** A valid v1 report, as the iOS builder sends it. */
const report = (now = Date.now(), extra: Record<string, unknown> = {}) => ({
  v: 1, at: now, app: { platform: 'ios', version: '1.4.0', build: '57', os: 'iOS 18.1' },
  permissions: { location: 'whenInUse', precise: true, bluetooth: 'allowed' },
  sensors: { location: 'collecting', heartRate: 'connected' }, queue: { location: 3, heartRate: 0 },
  sync: { lastSuccessAt: now - 1000, lastAttemptAt: now - 1000, lastError: '', heartRate: { lastUploadAt: null, lastError: '' } },
  collection: { sessions: [], lastEnded: [], pendingRevocations: [] },
  activity: [{ at: now - 5000, appId: 'run', kind: 'enabled', detail: '' }], ...extra,
});
const putReport = (deviceId: string, snapshot: unknown) => request('/native/diagnostics', { method: 'PUT', body: { snapshot }, token: tokenOf(deviceId) });
const stored = () => db.sql.prepare('SELECT device_id, snapshot FROM native_diagnostics').all() as { device_id: string; snapshot: string }[];

beforeEach(async () => {
  db = sqliteD1(); env = makeEnv({ DB: db, APP_BASE: 'https://api.proappstore.online', INTERNAL_TOKEN: INTERNAL }) as Env;
  db.sql.exec(`PRAGMA foreign_keys=ON;
    INSERT INTO users (id, provider, provider_id, login, created_at, last_login_at) VALUES
      ('google:1','google','1','Alice',0,0),('google:2','google','2','Bob',0,0);
    INSERT INTO apps (id, creator_id, created_at) VALUES ('ski','google:1',0),('run','google:1',0),('rideshare','google:1',0);`);
  await addDevice(ALICE_PHONE, 'google:1', 'iPhone'); await addDevice(ALICE_TABLET, 'google:1', 'Pixel'); await addDevice(BOB_PHONE, 'google:2', 'Bob phone');
});

describe('the owner gate (ADR-019 §4)', () => {
  it('needs the session AND the internal token; refuses a device credential and an app-bound session; fails closed', async () => {
    const ok = await owner('/me/native/devices');
    expect(ok.status).toBe(200);
    expect(ok.headers.get('Cache-Control')).toBe('private, no-store');
    const { devices } = await ok.json() as { devices: { id: string }[] };
    expect(devices.map(d => d.id).sort()).toEqual([ALICE_PHONE, ALICE_TABLET]); // Bob's device absent
    expect((await request('/me/native/devices', { token: await session('google:1') })).status).toBe(403);
    expect((await request('/me/native/devices', { token: await session('google:1'), headers: { 'X-Internal-Token': 'wrong' } })).status).toBe(403);
    expect((await request('/me/native/devices', { token: tokenOf(ALICE_PHONE), headers: { 'X-Internal-Token': INTERNAL } })).status).toBe(401);
    expect((await request('/me/native/devices', { token: await session('google:1', 'run'), headers: { 'X-Internal-Token': INTERNAL } })).status).toBe(403);
    env = { ...env, INTERNAL_TOKEN: undefined } as Env;
    expect((await owner('/me/native/devices')).status).toBe(503);
  });

  it('every /me/native route runs the gate', async () => {
    for (const path of ['devices', 'grants', 'status', 'locations', 'heart-rate', 'diagnostics']) {
      expect((await request(`/me/native/${path}`, { token: await session('google:1') })).status, path).toBe(403);
    }
  });
});

describe('/me/native reads', () => {
  it('locations page across apps with a cursor stable at one millisecond, inside retention, and never another user\'s', async () => {
    const ski = await enable(ALICE_PHONE, 'ski'), run = await enable(ALICE_TABLET, 'run'), bob = await enable(BOB_PHONE, 'ski');
    const now = Date.now();
    insertPoint(ski.id, 'old', now - NATIVE_RETENTION_MS - 1000);
    insertPoint(ski.id, 's1', now - 3000); insertPoint(run.id, 'r1', now - 3000); // the same millisecond, two grants
    insertPoint(run.id, 'r2', now - 2000); insertPoint(bob.id, 'bob', now - 2500);
    const seen: string[] = []; let cursor = '';
    for (let page = 0; page < 5; page++) {
      const body = await (await owner(`/me/native/locations?limit=1${cursor}`)).json() as { points: { id: string; appId: string; deviceId: string }[]; next: { after: number; afterId: string } | null };
      seen.push(...body.points.map(p => `${p.appId}:${p.id}`));
      if (!body.next) break;
      cursor = `&after=${body.next.after}&afterId=${encodeURIComponent(body.next.afterId)}`;
    }
    expect(seen.sort()).toEqual(['run:r1', 'run:r2', 'ski:s1']);
    const all = await (await owner('/me/native/locations')).json() as { points: { id: string; lat: number; deviceId: string }[]; next: unknown };
    expect(all.next).toBeNull();
    expect(all.points[0]).toMatchObject({ lat: 1, lng: 2, accuracy: 5 });
    const onlyRun = await (await owner('/me/native/locations?appId=run')).json() as { points: { id: string }[] };
    expect(onlyRun.points.map(p => p.id)).toEqual(['r1', 'r2']);
    const onlyPhone = await (await owner(`/me/native/locations?deviceId=${ALICE_PHONE}`)).json() as { points: { id: string }[] };
    expect(onlyPhone.points.map(p => p.id)).toEqual(['s1']);
    expect((await owner('/me/native/locations?appId=../x')).status).toBe(400);
    expect((await owner('/me/native/locations?deviceId=nope')).status).toBe(400);
    expect((await owner('/me/native/locations?limit=501')).status).toBe(400);
  });

  it('heart rate reads the heart-rate table under the same rules', async () => {
    const hr = await enable(ALICE_PHONE, 'run', 'heart_rate.ble');
    db.sql.prepare('INSERT INTO native_heart_rate (grant_id, sample_id, recorded_at, bpm) VALUES (?, ?, ?, ?)').run(hr.id, 'h1', Date.now() - 1000, 140);
    const body = await (await owner('/me/native/heart-rate')).json() as { samples: unknown[]; next: unknown };
    expect(body.samples).toEqual([expect.objectContaining({ id: 'h1', appId: 'run', deviceId: ALICE_PHONE, grantId: hr.id, bpm: 140 })]);
    expect((await owner('/me/native/heart-rate?limit=1000')).status).toBe(200);
    expect((await owner('/me/native/heart-rate?limit=1001')).status).toBe(400);
  });

  it('grants lists an obsolete grant as current: false, which the app read never returns', async () => {
    const ski = await enable(ALICE_PHONE, 'ski');
    insertPoint(ski.id, 'p', Date.now() - 1000);
    db.sql.prepare("UPDATE native_grants SET contract_version = 'stale' WHERE id = ?").run(ski.id);
    const { grants } = await (await owner('/me/native/grants')).json() as { grants: { id: string; appName: string; current: boolean; contractVersion: string; catalogVersion: string }[] };
    expect(grants).toEqual([expect.objectContaining({ id: ski.id, appName: 'Ski', current: false, contractVersion: 'stale' })]);
    expect(grants[0].catalogVersion).toMatch(/^[a-f0-9]{64}$/);
    const appRead = await request('/apps/ski/native/locations', { token: await session('google:1', 'ski') });
    expect((await appRead.json() as { points: unknown[] }).points).toEqual([]);
    // The owner still sees their own samples under it.
    expect((await (await owner('/me/native/locations')).json() as { points: unknown[] }).points).toHaveLength(1);
  });

  it('status reports session state only from the user\'s report, and never to the app (byte-identical app status)', async () => {
    await enable(ALICE_PHONE, 'run');
    const appStatus = async () => (await request('/apps/run/native/status', { token: await session('google:1', 'run') })).text();
    const before = await appStatus();
    type Device = { deviceId: string; sharing: boolean | null; sessionStartedAt: number | null; lastSessionEnd: { at: number; reason: string } | null };
    type Status = { status: { appId: string; capability: string; enabled: boolean; devices: Device[] }[] };
    const run = async () => (await (await owner('/me/native/status?appId=run')).json() as Status).status.find(s => s.capability === 'location.background')!;
    expect(await run()).toMatchObject({ appId: 'run', enabled: true, devices: [{ deviceId: ALICE_PHONE, sharing: null, sessionStartedAt: null, lastSessionEnd: null }] });
    const sharing = { sessions: [{ appId: 'run', startedAt: 1000, lastMovedAt: 2000 }], lastEnded: [], pendingRevocations: [] };
    expect((await putReport(ALICE_PHONE, report(Date.now(), { collection: sharing }))).status).toBe(200);
    expect((await run()).devices[0]).toMatchObject({ sharing: true, sessionStartedAt: 1000, lastSessionEnd: null });
    expect(await appStatus()).toBe(before);
    const stopped = { sessions: [], lastEnded: [{ appId: 'run', at: 3000, reason: 'stationary' }], pendingRevocations: [] };
    await putReport(ALICE_PHONE, report(Date.now(), { collection: stopped }));
    expect((await run()).devices[0]).toMatchObject({ sharing: false, sessionStartedAt: null, lastSessionEnd: { at: 3000, reason: 'stationary' } });
    expect(await appStatus()).toBe(before);
    // A pause-era field is dropped, never stored (ADR-020 replaced Pause).
    await putReport(ALICE_PHONE, report(Date.now(), { collection: { ...stopped, pausedApps: ['run'] } }));
    expect(stored()[0].snapshot).not.toContain('paused');
  });

  it('devices carry platform, version, last seen and the report time; diagnostics returns the report without old activity', async () => {
    await request('/native/me', { token: tokenOf(ALICE_PHONE), headers: { 'X-PAS-Native-Client': 'ios/1.4.0 (57)' } });
    const now = Date.now();
    await putReport(ALICE_PHONE, report(now));
    db.sql.prepare('UPDATE native_diagnostics SET snapshot = json_set(snapshot, \'$.activity[0].at\', ?)').run(now - NATIVE_RETENTION_MS - 1000);
    const { devices } = await (await owner('/me/native/devices')).json() as { devices: { id: string; platform: string; appVersion: string; lastSeenAt: number; diagnostics: { receivedAt: number } | null }[] };
    expect(devices[0]).toMatchObject({ id: ALICE_PHONE, platform: 'ios', appVersion: '1.4.0 (57)', diagnostics: { receivedAt: expect.any(Number) } });
    expect(devices[1]).toMatchObject({ id: ALICE_TABLET, platform: null, diagnostics: null });
    const { diagnostics } = await (await owner('/me/native/diagnostics')).json() as { diagnostics: { deviceId: string; label: string; snapshot: { activity: unknown[]; app: unknown } }[] };
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toMatchObject({ deviceId: ALICE_PHONE, label: 'iPhone', snapshot: { app: { platform: 'ios' }, activity: [] } });
    expect((await (await owner('/me/native/diagnostics', 'google:2')).json() as { diagnostics: unknown[] }).diagnostics).toEqual([]);
  });
});

describe('PUT /native/diagnostics', () => {
  it('stores one report per device, replaced on upload, rebuilt from whitelisted fields only', async () => {
    const first = await putReport(ALICE_PHONE, report());
    expect(first.status).toBe(200);
    expect(first.headers.get('Cache-Control')).toBe('private, no-store');
    expect(await first.json()).toEqual({ receivedAt: expect.any(Number) });
    const smuggled = { ...report(), points: [{ lat: -36.4, lng: 148.4 }], app: { ...report().app, lat: -36.4 }, activity: [{ ...report().activity[0], lat: -36.4 }] };
    expect((await putReport(ALICE_PHONE, smuggled)).status).toBe(200);
    const rows = stored();
    expect(rows).toHaveLength(1);
    const snapshot = JSON.parse(rows[0].snapshot);
    expect(snapshot).not.toHaveProperty('points');
    expect(rows[0].snapshot).not.toContain('"lat"');
    expect(rows[0].snapshot).not.toContain('36.4');
  });

  it('rejects another version, an oversized body and a malformed field; drops activity older than 7 days; accepts a newer kind', async () => {
    expect((await putReport(ALICE_PHONE, { ...report(), v: 2 })).status).toBe(400);
    expect((await putReport(ALICE_PHONE, { ...report(), sensors: { location: 'flying', heartRate: 'off' } })).status).toBe(400);
    expect((await putReport(ALICE_PHONE, { ...report(), collection: { pendingRevocations: ['../x'] } })).status).toBe(400);
    expect((await request('/native/diagnostics', { method: 'PUT', raw: `{"snapshot":"${'x'.repeat(NATIVE_DIAGNOSTICS_MAX + 1 - 15)}"}`, token: tokenOf(ALICE_PHONE) })).status).toBe(413);
    const now = Date.now();
    const response = await putReport(ALICE_PHONE, report(now, { activity: [
      { at: now - 8 * 86_400_000, appId: 'run', kind: 'enabled', detail: '' },
      { at: now - 1000, appId: 'run', kind: 'heart_rate_problem', detail: '400' },
    ] }));
    expect(response.status).toBe(200);
    expect(JSON.parse(stored()[0].snapshot).activity).toEqual([{ at: now - 1000, appId: 'run', kind: 'heart_rate_problem', detail: '400' }]);
  });

  it('accepts the largest report the phones build (#660 comment: size the cap against the maximum, not a typical one)', async () => {
    const now = Date.now();
    // Every field at its cap, then activity filled with maximal ASCII events up to the body cap the phones keep under.
    const base = report(now, {
      app: { platform: 'android', version: '9'.repeat(32), build: '9'.repeat(10), os: 'x'.repeat(40) },
      permissions: { location: 'notDetermined', precise: false, bluetooth: 'unsupported', notifications: 'notDetermined', batteryOptimized: true, powerSave: true, locationServices: true },
      sensors: { location: 'collecting', heartRate: 'x'.repeat(24) }, queue: { location: 1_000_000, heartRate: 1_000_000 },
      sync: { lastSuccessAt: now, lastAttemptAt: now, lastError: 'e'.repeat(120), heartRate: { lastUploadAt: now, lastError: 'e'.repeat(120) } },
      collection: {
        sessions: Array.from({ length: 50 }, (_, i) => ({ appId: `a${'x'.repeat(55)}${String(i).padStart(2, '0')}`, startedAt: now, lastMovedAt: now })),
        lastEnded: Array.from({ length: 50 }, (_, i) => ({ appId: `a${'x'.repeat(55)}${String(i).padStart(2, '0')}`, at: now, reason: 'x'.repeat(24) })),
        pendingRevocations: Array.from({ length: 50 }, (_, i) => `a${'x'.repeat(55)}${String(i).padStart(2, '0')}/${'z'.repeat(40)}`),
      },
      activity: [],
    });
    const event = { at: now, appId: `a${'x'.repeat(57)}`, kind: 'x'.repeat(32), detail: 'd'.repeat(120) };
    const body = (n: number) => JSON.stringify({ snapshot: { ...base, activity: Array(n).fill(event) } });
    let n = 0;
    while (n < 200 && body(n + 1).length <= NATIVE_DIAGNOSTICS_MAX) n++;
    expect(body(n + 1).length).toBeGreaterThan(NATIVE_DIAGNOSTICS_MAX); // one more event would not fit
    const response = await request('/native/diagnostics', { method: 'PUT', raw: body(n), token: tokenOf(ALICE_PHONE) });
    expect(response.status).toBe(200);
    expect(JSON.parse(stored()[0].snapshot).activity).toHaveLength(n);
  });

  it('DELETE, disconnecting the device and the retention prune each remove the report', async () => {
    await putReport(ALICE_PHONE, report());
    const deleted = await request('/native/diagnostics', { method: 'DELETE', token: tokenOf(ALICE_PHONE) });
    expect(await deleted.json()).toEqual({ deleted: true });
    expect(stored()).toEqual([]);
    expect((await request('/native/diagnostics', { method: 'DELETE', token: tokenOf(ALICE_PHONE) })).status).toBe(200); // idempotent
    await putReport(ALICE_PHONE, report());
    await request('/native/device', { method: 'DELETE', token: tokenOf(ALICE_PHONE) });
    expect(stored()).toEqual([]);
    await putReport(ALICE_TABLET, report());
    await pruneNativeData(db, Date.now() + NATIVE_RETENTION_MS - 60_000);
    expect(stored()).toHaveLength(1);
    await pruneNativeData(db, Date.now() + NATIVE_RETENTION_MS + 1);
    expect(stored()).toEqual([]);
  });

  it('needs the device credential; a session is refused', async () => {
    expect((await request('/native/diagnostics', { method: 'PUT', body: { snapshot: report() }, token: await session('google:1') })).status).toBe(401);
    expect((await request('/native/diagnostics', { method: 'DELETE' })).status).toBe(401);
  });

  it('the validator is pure: the stored object has exactly the whitelisted keys', () => {
    const now = Date.now();
    expect(Object.keys(nativeDiagnosticsSnapshot({ ...report(now), extra: 1 }, now)).sort()).toEqual(['activity', 'app', 'at', 'collection', 'permissions', 'queue', 'sensors', 'sync', 'v']);
    expect(() => nativeDiagnosticsSnapshot({ ...report(now), at: now - 8 * 86_400_000 }, now)).toThrow(/at/);
  });
});

describe('GET /native/me records device facts (#660 §3)', () => {
  const facts = () => db.sql.prepare('SELECT platform, app_version, last_seen_at FROM native_devices WHERE id = ?').get(ALICE_PHONE) as { platform: string | null; app_version: string | null; last_seen_at: number | null };
  it('records platform, version and last seen, at most once a minute, without changing the response', async () => {
    const plain = await (await request('/native/me', { token: tokenOf(ALICE_TABLET) })).json();
    const response = await request('/native/me', { token: tokenOf(ALICE_PHONE), headers: { 'X-PAS-Native-Client': 'ios/1.4.0 (57)' } });
    expect(response.status).toBe(200);
    expect(Object.keys(await response.json() as object)).toEqual(Object.keys(plain as object));
    const first = facts();
    expect(first).toMatchObject({ platform: 'ios', app_version: '1.4.0 (57)', last_seen_at: expect.any(Number) });
    db.sql.prepare('UPDATE native_devices SET last_seen_at = ? WHERE id = ?').run(first.last_seen_at! - 30_000, ALICE_PHONE);
    await request('/native/me', { token: tokenOf(ALICE_PHONE), headers: { 'X-PAS-Native-Client': 'ios/1.4.0 (57)' } });
    expect(facts().last_seen_at).toBe(first.last_seen_at! - 30_000); // within 60 s: no write
    await request('/native/me', { token: tokenOf(ALICE_PHONE), headers: { 'X-PAS-Native-Client': 'ios/1.5.0 (60)' } });
    expect(facts()).toMatchObject({ app_version: '1.5.0 (60)' }); // a new version is written at once
  });
  it('a shipped client without the header, or a malformed one, records the time only', async () => {
    expect((await request('/native/me', { token: tokenOf(ALICE_PHONE) })).status).toBe(200);
    expect(facts()).toMatchObject({ platform: null, app_version: null, last_seen_at: expect.any(Number) });
    db.sql.prepare('UPDATE native_devices SET last_seen_at = 0 WHERE id = ?').run(ALICE_PHONE);
    await request('/native/me', { token: tokenOf(ALICE_PHONE), headers: { 'X-PAS-Native-Client': 'windows/1.0' } });
    expect(facts()).toMatchObject({ platform: null, app_version: null });
    expect(facts().last_seen_at).toBeGreaterThan(0);
  });
});
