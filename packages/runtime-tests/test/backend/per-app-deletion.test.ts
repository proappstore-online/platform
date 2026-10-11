import { SELF, env as providedEnv } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Env } from '../../../backend/src/types';
import { BASE, json, mockNetwork, resetTables, seedApp, seedUser, session } from './helpers';

const env = providedEnv as unknown as Env;

// #379 (stash#41): deleting an account in one app removes the platform's data
// for that user in that app only. The same identity's data in another app, and
// another user's data in the same app, survive. Real D1, real R2.
//
//   gh:1 owns both apps   gh:2 the user deleting   gh:3 another user of stash   gh:4 a stranger

const USER = 'gh:2';
const OTHER_TABLES = ['kv', 'per_app_deleted_users', 'push_subscriptions'];

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
});
