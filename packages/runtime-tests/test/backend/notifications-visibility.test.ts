import { SELF, env as providedEnv, fetchMock } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Env } from '../../../backend/src/types';
import { deliverableSubs } from '../../../backend/src/routes/notifications';
import { BASE, json, mockNetwork, resetTables, seedApp, seedUser, session } from './helpers';

const env = providedEnv as unknown as Env;

// #325 on workerd and real D1: a private app's notifications reach only users its
// gate (lib/visibility.ts) allows. Subscribing and notify-user need the caller to
// pass the gate; every send re-checks each recipient, so a refused or revoked user
// gets nothing later. Public apps are unchanged.
//
// App ids are unique to this file: getAppVisibilityCached remembers each app's
// mode for 30 s per isolate, and other files flip their apps' visibility.

const PRIV = 'nv-private'; // private, roles: ['student']
const PUB = 'nv-public';
const OWNER = 'gh:nv1';
const STUDENT = 'gh:nv2'; // holds the declared role
const MEMBER = 'gh:nv3'; // only `member` (ensure-member) — refused
const TEAM = 'gh:nv4'; // team_members row
const OUTSIDER = 'gh:nv5'; // nothing
const ALIAS = 'gh:nv6'; // role granted to their GitHub login before first sign-in

let n = 0;
const sub = (appId: string, token: string) => SELF.fetch(
  `${BASE}/v1/notifications/subscribe`,
  json('POST', { appId, endpoint: `https://push.example/${++n}`, p256dh: 'k', auth: 's' }, token),
);
async function seedSub(appId: string, userId: string): Promise<void> {
  await env.DB.prepare('INSERT INTO push_subscriptions (id, user_id, app_id, endpoint, p256dh, auth_secret, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, 1)')
    .bind(crypto.randomUUID(), userId, appId, `https://push.example/${appId}/${userId}`, 'k', 's').run();
}
const recipients = async (appId: string, userId?: string) => (await deliverableSubs(env, appId, userId)).map((s) => s.user_id).sort();

afterEach(() => fetchMock.assertNoPendingInterceptors());
beforeEach(async () => {
  mockNetwork();
  await resetTables();
  for (const t of ['app_visibility', 'push_subscriptions', 'notification_log', 'notification_email_optout', 'email_usage']) await env.DB.prepare(`DELETE FROM ${t}`).run();
  for (const [uid, login] of [[OWNER, 'nv-owner'], [STUDENT, 'nv-student'], [MEMBER, 'nv-member'], [TEAM, 'nv-team'], [OUTSIDER, 'nv-out'], [ALIAS, 'nv-alias'], ['gh:admin', 'nv-admin']]) await seedUser(uid!, login);
  await seedApp(PRIV, OWNER);
  await seedApp(PUB, OWNER);
  await env.DB.prepare("INSERT INTO app_visibility (app_id, mode, roles, created_at) VALUES (?, 'private', '[\"student\"]', 1)").bind(PRIV).run();
  await env.DB.prepare("INSERT INTO app_roles (app_id, user_id, role_name) VALUES (?1, ?2, 'student'), (?1, ?3, 'member'), (?1, 'nv-alias', 'student')").bind(PRIV, STUDENT, MEMBER).run();
  await env.DB.prepare("INSERT INTO team_members (app_id, user_id, role, invited_by, created_at) VALUES (?, ?, 'developer', ?, 1)").bind(PRIV, TEAM, OWNER).run();
});

describe('subscribe enforces existence and visibility (#325)', () => {
  it('an unauthorized user cannot subscribe to a private app; nothing is stored', async () => {
    for (const uid of [MEMBER, OUTSIDER]) {
      const res = await sub(PRIV, await session(uid));
      expect(res.status, uid).toBe(403);
    }
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM push_subscriptions').first()).toEqual({ n: 0 });
  });

  it('the owner, a team member, a role holder (also by GitHub login) and an admin can subscribe to it', async () => {
    for (const uid of [OWNER, TEAM, STUDENT, 'gh:admin']) expect((await sub(PRIV, await session(uid))).status, uid).toBe(200);
    expect((await sub(PRIV, await session(ALIAS, { login: 'nv-alias', roles: ['user'] }))).status).toBe(200);
  });

  it('a nonexistent app is a 404 and stores nothing; a public app is open to anyone signed in', async () => {
    expect((await sub('nv-no-such-app', await session(OUTSIDER))).status).toBe(404);
    expect((await sub(PUB, await session(OUTSIDER))).status).toBe(200);
    expect(await env.DB.prepare('SELECT app_id, user_id FROM push_subscriptions').all().then((r) => r.results)).toEqual([{ app_id: PUB, user_id: OUTSIDER }]);
  });
});

describe('every send re-checks recipients (#325)', () => {
  it('a private app delivers only to users its gate allows now, whatever subscriptions exist', async () => {
    for (const uid of [OWNER, STUDENT, MEMBER, TEAM, OUTSIDER, ALIAS, 'gh:admin']) await seedSub(PRIV, uid); // e.g. subscribed before the app went private
    expect(await recipients(PRIV)).toEqual(['gh:admin', OWNER, STUDENT, TEAM, ALIAS].sort());
    expect(await recipients(PRIV, MEMBER)).toEqual([]);
    expect(await recipients(PRIV, STUDENT)).toEqual([STUDENT]);
  });

  it('a revoked role stops later broadcasts; re-granting restores them', async () => {
    await seedSub(PRIV, STUDENT);
    expect(await recipients(PRIV)).toEqual([STUDENT]);
    await env.DB.prepare("DELETE FROM app_roles WHERE app_id = ? AND user_id = ? AND role_name = 'student'").bind(PRIV, STUDENT).run();
    expect(await recipients(PRIV)).toEqual([]);
    // End to end: the owner's broadcast reaches nobody, and sends nothing.
    const res = await SELF.fetch(`${BASE}/v1/notifications/send`, json('POST', { appId: PRIV, title: 'secret', body: 'news' }, await session(OWNER)));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ sent: 0, failed: 0 });
    await env.DB.prepare("INSERT INTO app_roles (app_id, user_id, role_name) VALUES (?, ?, 'student')").bind(PRIV, STUDENT).run();
    expect(await recipients(PRIV)).toEqual([STUDENT]);
  });

  it('a public app delivers to every subscriber, as before', async () => {
    for (const uid of [OWNER, MEMBER, OUTSIDER]) await seedSub(PUB, uid);
    expect(await recipients(PUB)).toEqual([OWNER, MEMBER, OUTSIDER].sort());
  });

  it('the internal send to one refused user of a private app sends nothing', async () => {
    await seedSub(PRIV, MEMBER);
    const res = await SELF.fetch(`${BASE}/v1/notifications/send-internal`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Internal-Token': env.INTERNAL_TOKEN! },
      body: JSON.stringify({ appId: PRIV, userId: MEMBER, title: 't', body: 'b' }),
    });
    expect(await res.json()).toEqual({ sent: 0, failed: 0 });
  });
});

describe('notify-user requires the caller to pass the gate (#325)', () => {
  const notify = async (from: string, to: string, channel = 'push') => SELF.fetch(
    `${BASE}/v1/notifications/notify-user`,
    json('POST', { appId: PRIV, targetUserId: to, title: 't', body: 'b', channel }, await session(from)),
  );

  it('a refused user holding a subscription and a member row cannot notify the app’s users', async () => {
    await seedSub(PRIV, MEMBER); // e.g. subscribed while the app was public
    await seedSub(PRIV, STUDENT);
    for (const channel of ['push', 'email']) {
      const res = await notify(MEMBER, STUDENT, channel);
      expect(res.status, channel).toBe(403);
      expect(await res.text()).toContain('private');
    }
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM notification_log').first()).toEqual({ n: 0 });
  });

  it('an allowed user pushing to a refused one delivers nothing; email skips them as not a member', async () => {
    await seedSub(PRIV, STUDENT);
    await seedSub(PRIV, MEMBER);
    expect(await (await notify(STUDENT, MEMBER)).json()).toEqual({ sent: 0, failed: 0 });
    expect(await (await notify(STUDENT, MEMBER, 'email')).json()).toMatchObject({ email: 'skipped', skipped: 'not_member' });
  });

  it('a revoked caller is refused from then on', async () => {
    await seedSub(PRIV, STUDENT);
    await env.DB.prepare('DELETE FROM app_roles WHERE app_id = ? AND user_id = ?').bind(PRIV, STUDENT).run();
    expect((await notify(STUDENT, OWNER)).status).toBe(403);
  });
});
