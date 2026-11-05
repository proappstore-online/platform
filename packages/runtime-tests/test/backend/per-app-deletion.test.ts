import { SELF, env as providedEnv, fetchMock } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Env } from '../../../backend/src/types';
import { BASE, json, mockNetwork, resetTables, seedApp, seedUser, session } from './helpers';
import { workerGoogleCalendar } from '../../../backend/src/lib/google-calendar-worker';
import { beginGoogleOAuth, completeGoogleOAuth } from '../../../backend/src/lib/google-calendar-accounts';
import { mintSession } from '@proappstore/build-core';
import { GOOGLE_CALENDAR_SCOPES } from '../../../backend/src/lib/google-calendar-common';

const env = providedEnv as unknown as Env;

// #379 (stash#41): deleting an account in one app removes the platform's data
// for that user in that app only. The same identity's data in another app, and
// another user's data in the same app, survive. Real D1, real R2.
//
//   gh:1 owns both apps   gh:2 the user deleting   gh:3 another user of stash   gh:4 a stranger

const USER = 'gh:2';
const OTHER_TABLES = ['kv', 'per_app_deleted_users', 'push_subscriptions', 'google_calendar_grants', 'google_calendar_oauth_states', 'google_calendar_app_authorizations', 'google_calendar_accounts', 'app_connectors'];

async function seedUserData(appId: string, uid: string): Promise<void> {
  await env.DB.prepare('INSERT INTO kv (app_id, user_id, key, value, value_size_bytes, updated_at) VALUES (?, ?, ?, ?, 1, 1)')
    .bind(appId, uid, 'profile', new Uint8Array([1])).run();
  await env.DB.prepare('INSERT INTO app_roles (app_id, user_id, role_name) VALUES (?, ?, ?)').bind(appId, uid, 'host').run();
  await env.DB.prepare('INSERT INTO push_subscriptions (id, user_id, app_id, endpoint, p256dh, auth_secret, created_at) VALUES (?, ?, ?, ?, ?, ?, 1)')
    .bind(`${appId}-${uid}`, uid, appId, `https://push.test/${appId}/${uid}`, 'p', 'a').run();
  for (const key of [`${appId}/${uid}/id.pdf`, `${appId}/_public/u/${uid}/avatar.jpg`, `${appId}/_public/u/${uid}/old-avatar.jpg`, `${appId}/_review/u/${uid}/passport.pdf`]) {
    await env.STORAGE.put(key, 'x');
  }
}

async function counts(appId: string, uid: string) {
  const n = async (table: string) =>
    (await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE app_id = ? AND user_id = ?`).bind(appId, uid).first<{ n: number }>())!.n;
  const files = (await Promise.all([`${appId}/${uid}/`, `${appId}/_public/u/${uid}/`, `${appId}/_review/u/${uid}/`]
    .map(async (prefix) => (await env.STORAGE.list({ prefix })).objects.length))).reduce((a, b) => a + b, 0);
  return { kv: await n('kv'), roles: await n('app_roles'), push: await n('push_subscriptions'), deleted: await n('per_app_deleted_users'), files };
}

const del = async (appId: string, uid: string, as: string) =>
  SELF.fetch(`${BASE}/v1/apps/${appId}/users/${encodeURIComponent(uid)}/account`, json('DELETE', undefined, await session(as, { roles: ['user'] })));

async function emptyBucket(): Promise<void> {
  const listed = await env.STORAGE.list();
  if (listed.objects.length) await env.STORAGE.delete(listed.objects.map((o) => o.key));
}

beforeEach(async () => {
  mockNetwork();
  await resetTables();
  for (const t of OTHER_TABLES) await env.DB.prepare(`DELETE FROM ${t}`).run();
  await emptyBucket();
  for (const uid of ['gh:1', 'gh:2', 'gh:3', 'gh:4']) await seedUser(uid);
  await seedApp('stash', 'gh:1');
  await seedApp('notes', 'gh:1');
  await seedUserData('stash', USER);
  await seedUserData('notes', USER);
  await seedUserData('stash', 'gh:3');
});
afterEach(async () => {
  for (const t of OTHER_TABLES) await env.DB.prepare(`DELETE FROM ${t}`).run();
  await emptyBucket();
});

describe('per-app account deletion (#379)', () => {
  it('removes the user\'s data in that app only — the same identity in another app is untouched', async () => {
    const res = await del('stash', USER, USER);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, files: 4 });

    expect(await counts('stash', USER)).toEqual({ kv: 0, roles: 0, push: 0, deleted: 1, files: 0 });
    expect(await counts('notes', USER)).toEqual({ kv: 1, roles: 1, push: 1, deleted: 0, files: 4 });
    expect(await counts('stash', 'gh:3')).toEqual({ kv: 1, roles: 1, push: 1, deleted: 0, files: 4 });
    // The shared identity survives.
    expect(await env.DB.prepare('SELECT id FROM users WHERE id = ?').bind(USER).first()).not.toBeNull();
  });

  it('reports the deletion per app, so the app can refuse the user', async () => {
    await del('stash', USER, USER);
    const status = async (appId: string) =>
      (await SELF.fetch(`${BASE}/v1/apps/${appId}/users/${encodeURIComponent(USER)}/account`, json('GET', undefined, await session(USER, { roles: ['user'] })))).json();
    expect(await status('stash')).toMatchObject({ deleted: true });
    expect(await status('notes')).toEqual({ deleted: false, deleted_at: null });
  });

  it('lets a team admin delete a user, and nobody else', async () => {
    expect((await del('stash', USER, 'gh:4')).status).toBe(403);
    expect(await counts('stash', USER)).toMatchObject({ kv: 1, files: 4, deleted: 0 });
    const res = await del('stash', USER, 'gh:1');
    expect(res.status).toBe(200);
    expect(await counts('stash', USER)).toMatchObject({ kv: 0, files: 0, deleted: 1 });
    const row = await env.DB.prepare('SELECT deleted_by FROM per_app_deleted_users WHERE app_id = ? AND user_id = ?').bind('stash', USER).first<{ deleted_by: string }>();
    expect(row?.deleted_by).toBe('gh:1');
  });

  it('lists a user\'s public uploads, including ones the app no longer references', async () => {
    const res = await SELF.fetch(`${BASE}/v1/apps/stash/users/${encodeURIComponent(USER)}/public-files`, json('GET', undefined, await session(USER, { roles: ['user'] })));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { files: { key: string }[] };
    expect(body.files.map((f) => f.key).sort()).toEqual([`u/${USER}/avatar.jpg`, `u/${USER}/old-avatar.jpg`]);
    const stranger = await SELF.fetch(`${BASE}/v1/apps/stash/users/${encodeURIComponent(USER)}/public-files`, json('GET', undefined, await session('gh:4', { roles: ['user'] })));
    expect(stranger.status).toBe(403);
  });

  it('is safe to repeat, and refuses an unknown app', async () => {
    expect((await del('stash', USER, USER)).status).toBe(200);
    expect(await (await del('stash', USER, USER)).json()).toEqual({ ok: true, files: 0 });
    expect((await del('nope', USER, USER)).status).toBe(404);
  });

  it('revokes only this app/user connector access and pending consent, preserving shared credentials', async () => {
    for (const uid of [USER, 'gh:3']) {
      await env.DB.prepare("INSERT INTO google_calendar_accounts (user_id, version, status, google_subject, email, credential_ct, updated_at) VALUES (?, 1, 'connected', '123456', 'test@example.test', ?, 1)")
        .bind(uid, new Uint8Array([1, 2, 3])).run();
    }
    const grants: string[] = [];
    for (const [appId, uid] of [['stash', USER], ['notes', USER], ['stash', 'gh:3']]) {
      const grantId = crypto.randomUUID(); grants.push(grantId);
      await env.DB.prepare(`INSERT OR IGNORE INTO app_connectors (app_id, name, kind, modes, events, created_at, capabilities_json) VALUES (?, ?, ?, ?, ?, 1, '["calendar.read","meet.read"]')`)
        .bind(appId, 'calendar', 'google_calendar', '["oauth"]', '[]').run();
      await env.DB.prepare('INSERT INTO google_calendar_app_authorizations (app_id, user_id, account_version) VALUES (?, ?, 1)').bind(appId, uid).run();
      await env.DB.prepare('INSERT INTO google_calendar_grants (id, app_id, user_id, account_version, calendar_id, calendar_name, created_at) VALUES (?, ?, ?, 1, ?, ?, 1)')
        .bind(grantId, appId, uid, 'team@example.test', 'Team').run();
      await env.DB.prepare('INSERT INTO google_calendar_oauth_states (state_hash, app_id, user_id, account_version, callback_url, return_to, expires_at) VALUES (?, ?, ?, 1, ?, ?, ?)')
        .bind(grantId, appId, uid, `https://${appId}.proappstore.online/callback`, `https://${appId}.proappstore.online/`, Date.now() + 60_000).run();
    }
    const before = await env.DB.prepare('SELECT * FROM google_calendar_accounts WHERE user_id = ?').bind(USER).first();
    expect((await del('stash', USER, USER)).status).toBe(200);
    const call = (appId: string, grant_id: string) => workerGoogleCalendar(env, appId, 'calendar', { operation: 'grant_status', grant_id }, null);
    expect(await call('stash', grants[0])).toMatchObject({ error: 'reconnect_required' });
    expect(await call('notes', grants[1])).toMatchObject({ grant_id: grants[1] });
    expect(await call('stash', grants[2])).toMatchObject({ grant_id: grants[2] });
    for (const table of ['google_calendar_app_authorizations', 'google_calendar_oauth_states', 'google_calendar_grants']) {
      expect(await env.DB.prepare(`SELECT * FROM ${table} WHERE app_id = 'stash' AND user_id = ?`).bind(USER).first()).toBeNull();
      expect(await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first('n')).toBe(2);
    }
    expect(await env.DB.prepare('SELECT * FROM google_calendar_accounts WHERE user_id = ?').bind(USER).first()).toEqual(before);
    expect((await del('stash', USER, USER)).status).toBe(200);
  });

  it('preserves independent app consent and grants when reconnecting the same Google account on real D1', async () => {
    const googleEnv = { ...env, GOOGLE_CLIENT_ID: 'test-client', GOOGLE_CLIENT_SECRET: 'test-secret' };
    for (const appId of ['stash', 'notes']) await env.DB.prepare(`INSERT INTO app_connectors (app_id,name,kind,modes,events,created_at,capabilities_json,disclosure_json) VALUES (?,'calendar','google_calendar','["oauth"]','[]',1,'["calendar.read","meet.read"]',?)`)
      .bind(appId, JSON.stringify({ purpose: 'Read selected meeting records.', audience: 'Authorized members of the app.', retention: 'Retention is described in the app notice.', privacy_path: '/privacy', deletion_path: '/settings/data' })).run();
    const connect = async (appId: string, capabilities: string[]) => {
      const start = await beginGoogleOAuth(googleEnv, appId, USER, '/callback', '/', capabilities);
      const state = new URL(start.authorization_url).searchParams.get('state')!;
      const loginToken = await mintSession({ uid: USER, roles: ['user'], auth_time: Math.floor(Date.now() / 1000), auth_method: 'github' }, env.SESSION_SIGNING_KEY);
      const login = await SELF.fetch(`${BASE}/v1/connectors/google-calendar/session?state=${state}`, { method: 'POST', headers: { Origin: BASE, Authorization: `Bearer ${loginToken}` } });
      expect(login.status).toBe(200);
      const cookie = login.headers.get('Set-Cookie')!.split(';')[0]!;
      const page = await SELF.fetch(`${BASE}/v1/connectors/google-calendar/consent?state=${state}`, { headers: { Cookie: cookie } });
      const csrf = (await page.text()).match(/name="csrf" value="([^"]+)"/)![1]!;
      const body = new FormData(); body.set('csrf', csrf); body.set('decision', 'allow'); for (const capability of capabilities) body.append('capability', capability);
      expect((await SELF.fetch(`${BASE}/v1/connectors/google-calendar/consent?state=${state}`, { method: 'POST', redirect: 'manual', headers: { Origin: BASE, Cookie: cookie }, body })).status).toBe(302);
      fetchMock.get('https://oauth2.googleapis.com').intercept({ path: '/token', method: 'POST' })
        .reply(200, JSON.stringify({ access_token: 'test-access', refresh_token: 'test-refresh', expires_in: 3600, scope: GOOGLE_CALENDAR_SCOPES.join(' ') }));
      fetchMock.get('https://openidconnect.googleapis.com').intercept({ path: '/v1/userinfo' })
        .reply(200, JSON.stringify({ sub: '123456', email: 'test@example.test', email_verified: true }));
      expect(await completeGoogleOAuth(googleEnv, appId, USER, state, 'test-code')).toMatchObject({ email: 'test@example.test' });
    };
    await connect('stash', ['calendar.read']);
    const first = await env.DB.prepare("SELECT * FROM google_calendar_app_authorizations WHERE app_id = 'stash' AND user_id = ?").bind(USER).first();
    await env.DB.prepare("INSERT INTO google_calendar_grants (id,app_id,user_id,account_version,authorization_version,calendar_id,calendar_name,created_at) VALUES ('00000000-0000-4000-8000-000000000001','stash',?,1,1,'primary','Personal',1)").bind(USER).run();
    await connect('notes', ['calendar.read', 'meet.read']);
    await connect('notes', ['calendar.read']);
    expect(await env.DB.prepare('SELECT version FROM google_calendar_accounts WHERE user_id = ?').bind(USER).first('version')).toBe(1);
    expect(await env.DB.prepare("SELECT * FROM google_calendar_app_authorizations WHERE app_id = 'stash' AND user_id = ?").bind(USER).first()).toEqual(first);
    expect(await workerGoogleCalendar(googleEnv, 'stash', 'calendar', { operation: 'grant_status', grant_id: '00000000-0000-4000-8000-000000000001' }, null)).toMatchObject({ grant_id: '00000000-0000-4000-8000-000000000001' });
    expect(await env.DB.prepare("SELECT authorization_version,capabilities_json,consent_version FROM google_calendar_app_authorizations WHERE app_id = 'notes' AND user_id = ?").bind(USER).first()).toEqual({ authorization_version: 2, capabilities_json: '["calendar.read"]', consent_version: 1 });
    expect(await env.DB.prepare('SELECT account_version FROM google_calendar_app_authorizations WHERE app_id = ? AND user_id = ?').bind('stash', USER).first('account_version')).toBe(1);
    await del('stash', USER, USER);
    await expect(beginGoogleOAuth(googleEnv, 'stash', USER, '/callback', '/')).rejects.toThrow('app_account_deleted');
    fetchMock.assertNoPendingInterceptors();
  });
});
