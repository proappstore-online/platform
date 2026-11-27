import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { credentialContext, mintSession } from '@proappstore/build-core';
import { app } from '../index.js';
import { sqliteD1 } from '../sqlite-d1.js';
import { makeEnv } from '../test-helpers.js';
import type { Env } from '../types.js';
import { APP_ID_COLUMNS } from '../lib/app-rename-columns.js';

let db: ReturnType<typeof sqliteD1>, env: Env;
const tokens: Record<string, string> = {};
const endpoint = '/v1/apps/shop/team/recruitment';
const good = { name: 'Applicant', email: 'applicant@example.com', message: 'I can help translate.' };
const request = (method = 'GET', uid = 'gh:1', body?: unknown, path = endpoint) => app.request(path, {
  method, headers: { Authorization: `Bearer ${tokens[uid]}`, 'Content-Type': 'application/json' },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
}, env);
const join = (form = false, body: Record<string, string> = good, appId = 'shop', origin = `https://about-${appId}.proappstore.online`) => app.request(`/v1/storefront/apps/${appId}/enquiries/team-join`, {
  method: 'POST', headers: { Origin: origin, 'Content-Type': form ? 'application/x-www-form-urlencoded' : 'application/json', 'CF-Connecting-IP': '203.0.113.1' },
  body: form ? new URLSearchParams(body).toString() : JSON.stringify(body),
}, env);
const count = () => db.sql.prepare('SELECT COUNT(*) AS n FROM app_enquiries').get()!.n;

beforeEach(async () => {
  db = sqliteD1(); env = makeEnv({ DB: db }) as Env;
  db.sql.exec(`PRAGMA foreign_keys=ON;
    INSERT INTO users(id,provider,provider_id,login,created_at,last_login_at) VALUES
    ('gh:1','github','1','owner',0,0),('gh:2','github','2','developer',0,0),('gh:3','github','3','co-owner',0,0),('gh:4','github','4','other',0,0);
    INSERT INTO apps(id,creator_id,created_at) VALUES ('shop','gh:1',0),('other','gh:2',0);
    INSERT INTO app_storefront_publication(app_id,listed,updated_at) VALUES ('shop',1,0),('other',1,0);
    INSERT INTO team_members(app_id,user_id,role,created_at) VALUES ('shop','gh:2','developer',0),('shop','gh:3','owner',0);`);
  for (const uid of ['gh:1', 'gh:2', 'gh:3', 'gh:4']) tokens[uid] = await mintSession({ uid, roles: ['user'], cred: credentialContext('first_party_session') }, env.SESSION_SIGNING_KEY);
  tokens.admin = await mintSession({ uid: 'gh:4', roles: ['admin'], cred: credentialContext('first_party_session') }, env.SESSION_SIGNING_KEY);
});
afterEach(() => vi.restoreAllMocks());

it('preserves open-by-default behavior and privately persists a current owner setting', async () => {
  const initial = await request();
  expect(initial.headers.get('Cache-Control')).toBe('private, no-store');
  expect(await initial.json()).toEqual({ appId: 'shop', accepting_requests: true, updated_at: null });
  expect((await join()).status).toBe(201);
  const res = await request('PUT', 'gh:1', { accepting_requests: false });
  expect(res.headers.get('Cache-Control')).toBe('private, no-store');
  expect(await res.json()).toMatchObject({ appId: 'shop', accepting_requests: false, updated_at: expect.any(Number) });
  expect((await join()).status).toBe(404);
  expect(count()).toBe(1); // closing retains the private inbox
  expect((await request('PUT', 'gh:1', { accepting_requests: true })).status).toBe(200);
  expect((await join()).status).toBe(201); // existing duplicate remains harmless
  expect(count()).toBe(1);
});

it('uses requireAppOwner authority without granting developers, strangers, or cross-app creators access', async () => {
  for (const uid of ['gh:2', 'gh:4']) for (const method of ['GET', 'PUT']) expect((await request(method, uid, method === 'PUT' ? { accepting_requests: false } : undefined)).status).toBe(403);
  for (const uid of ['gh:3', 'admin']) expect((await request('PUT', uid, { accepting_requests: false })).status).toBe(200);
  expect((await request('GET', 'admin', undefined, '/v1/apps/missing/team/recruitment')).status).toBe(404);
  expect((await request('PUT', 'gh:1', { accepting_requests: false }, '/v1/apps/other/team/recruitment')).status).toBe(403);
});

it('requires first-party person credentials even for an owner', async () => {
  expect((await app.request(endpoint, {}, env)).status).toBe(401);
  for (const claims of [{}, { cred: credentialContext('app_origin_session', 'shop') }, { cred: credentialContext('first_party_session'), via: 'worker' }]) {
    tokens.old = await mintSession({ uid: 'gh:1', roles: ['user'], ...claims }, env.SESSION_SIGNING_KEY);
    expect((await request('GET', 'old')).status).toBe(403);
    expect((await request('PUT', 'old', { accepting_requests: false })).status).toBe(403);
  }
});

it.each([null, [], {}, { accepting_requests: 0 }, { accepting_requests: 'false' }])('rejects malformed settings: %j', async body => {
  expect((await request('PUT', 'gh:1', body)).status).toBe(400);
  expect(await (await request()).json()).toMatchObject({ accepting_requests: true });
});

it('rechecks current ownership in the setting write after a transfer', async () => {
  const prepare = db.prepare.bind(db);
  vi.spyOn(db, 'prepare').mockImplementation(sql => {
    if (sql.startsWith('INSERT INTO app_team_recruitment')) db.sql.exec("UPDATE apps SET creator_id='gh:4' WHERE id='shop'");
    return prepare(sql);
  });
  expect((await request('PUT', 'gh:1', { accepting_requests: false })).status).toBe(403);
  expect(db.sql.prepare('SELECT COUNT(*) AS n FROM app_team_recruitment').get()!.n).toBe(0);
});

it.each(['close', 'private', 'delete', 'unlist', 'unpublish'])('atomically refuses admission when %s happens after intake precheck', async change => {
  const prepare = db.prepare.bind(db);
  vi.spyOn(db, 'prepare').mockImplementation(sql => {
    if (sql.startsWith('INSERT INTO app_enquiries')) {
      if (change === 'close') db.sql.exec("INSERT INTO app_team_recruitment VALUES('shop',0,'gh:1',1)");
      if (change === 'private') db.sql.exec("INSERT INTO app_visibility(app_id,mode,roles,created_at) VALUES('shop','private','[]',0)");
      if (change === 'delete') db.sql.exec("DELETE FROM apps WHERE id='shop'");
      if (change === 'unlist') db.sql.exec("UPDATE app_storefront_publication SET listed=0 WHERE app_id='shop'");
      if (change === 'unpublish') db.sql.exec("DELETE FROM app_storefront_publication WHERE app_id='shop'");
    }
    return prepare(sql);
  });
  expect((await join()).status).toBe(404);
  expect(count()).toBe(0);
});

it('accepts native forms only from the exact about origin and uses fixed redirects without reflecting personal input', async () => {
  const res = await join(true, { ...good, return_url: 'https://evil.test/' });
  expect(res.status).toBe(303);
  expect(res.headers.get('Location')).toBe('https://about-shop.proappstore.online/?team_join=sent#team-join-sent');
  expect(count()).toBe(1);
  expect((await join(true)).status).toBe(303);
  expect(count()).toBe(1);
  for (const origin of ['https://proappstore.online', 'https://about-other.proappstore.online', 'https://about-shop.proappstore.online.evil.test', 'null']) {
    const denied = await join(true, good, 'shop', origin);
    expect(denied.status).toBe(origin === 'https://proappstore.online' ? 415 : 403);
    expect(denied.headers.get('Location')).toBeNull();
  }
});

it('has fixed invalid, unavailable, honeypot and rate-limited native-form outcomes with shared JSON limits', async () => {
  expect((await join(true, { ...good, email: 'bad' })).headers.get('Location')).toContain('?team_join=invalid#team-join-invalid');
  expect((await join(true, { ...good, website: 'bot' })).headers.get('Location')).toContain('?team_join=sent#team-join-sent');
  expect(count()).toBe(0);
  for (let i = 0; i < 5; i++) expect((await join(i % 2 === 0, { ...good, email: `person${i}@example.com` })).status).toBe(i % 2 === 0 ? 303 : 201);
  const limited = await join(true, { ...good, email: 'next@example.com' });
  expect(limited.headers.get('Location')).toContain('?team_join=rate-limited#team-join-rate-limited');
  expect(limited.headers.get('Retry-After')).toBe('3600');
  await request('PUT', 'gh:1', { accepting_requests: false });
  for (const appId of ['shop', 'missing']) expect((await join(true, good, appId)).headers.get('Location')).toBe(`https://about-${appId}.proappstore.online/?team_join=unavailable#team-join-unavailable`);
  db.sql.exec("INSERT INTO app_visibility(app_id,mode,roles,created_at) VALUES('other','private','[]',0)");
  expect((await join(true, good, 'other')).headers.get('Location')).toContain('team_join=unavailable');
});

it('enforces the actual encoded body limit when Content-Length is absent', async () => {
  expect((await join(true, { ...good, extra: 'a'.repeat(16384) })).status).toBe(413);
  expect(count()).toBe(0);
});

it.each(['unlist', 'unpublish'])('refuses %s through JSON and native forms until relisted', async change => {
  db.sql.exec(change === 'unlist' ? "UPDATE app_storefront_publication SET listed=0 WHERE app_id='shop'" : "DELETE FROM app_storefront_publication WHERE app_id='shop'");
  expect((await join()).status).toBe(404);
  expect((await join(true)).headers.get('Location')).toContain('team_join=unavailable');
  expect(count()).toBe(0);
  db.sql.exec("INSERT INTO app_storefront_publication VALUES('shop',1,0) ON CONFLICT(app_id) DO UPDATE SET listed=1");
  expect((await join()).status).toBe(201);
});

it('classifies recruitment as a mutable app id and preserves the closed setting through a registry rename', async () => {
  await request('PUT', 'gh:1', { accepting_requests: false });
  const column = APP_ID_COLUMNS.find(c => c.table === 'app_team_recruitment');
  expect(column).toEqual({ table: 'app_team_recruitment', column: 'app_id', kind: 'id' });
  // Rename switches copy the app row before rewriting child app IDs and removing the old row.
  db.sql.exec("INSERT INTO apps(id,creator_id,created_at) VALUES('renamed','gh:1',0)");
  db.sql.prepare(`UPDATE ${column!.table} SET ${column!.column}=? WHERE ${column!.column}=?`).run('renamed','shop');
  db.sql.exec("DELETE FROM apps WHERE id='shop'");
  expect(await (await request('GET', 'gh:1', undefined, '/v1/apps/renamed/team/recruitment')).json()).toMatchObject({ appId: 'renamed', accepting_requests: false });
});

it('keeps recruitment with the app across ownership changes and cascades only on app deletion', async () => {
  await request('PUT', 'gh:1', { accepting_requests: false });
  db.sql.exec("UPDATE apps SET creator_id='gh:4' WHERE id='shop'");
  expect((await request()).status).toBe(403);
  expect(await (await request('GET', 'gh:4')).json()).toMatchObject({ accepting_requests: false });
  db.sql.exec("DELETE FROM apps WHERE id='shop'");
  expect(db.sql.prepare('SELECT COUNT(*) AS n FROM app_team_recruitment').get()!.n).toBe(0);
});
