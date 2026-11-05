import { SELF, env as providedEnv } from 'cloudflare:test';
import { credentialContext, mintSession } from '@proappstore/build-core';
import { beforeEach, describe, expect, it } from 'vitest';
import type { Env } from '../../../backend/src/types';
import { BASE, mockNetwork, resetTables, seedApp, seedUser } from './helpers';

// #549 on workerd and real D1: app-scoped promoter enrollment, the lifecycle, and the migration's triggers.
// Enrolling grants no other right; suspension survives concurrent onboarding; private apps look like missing ones.

const env = providedEnv as unknown as Env;
const OWNER = 'gh:1', ADA = 'gh:2', BOB = 'gh:3';
const TABLES = ['app_promoter_events', 'app_promoter_settings', 'app_promoters', 'per_app_deleted_users', 'app_visibility', 'team_members'];

const token = (uid: string, cred: ReturnType<typeof credentialContext> | null = credentialContext('first_party_session')) =>
  mintSession({ uid, roles: ['user'], auth_time: Math.floor(Date.now() / 1000), auth_method: 'google', ...(cred ? { cred } : {}) }, env.SESSION_SIGNING_KEY);
async function call(method: string, path: string, uid: string | null, body?: unknown, bearer?: string) {
  return SELF.fetch(`${BASE}/v1${path}`, {
    method,
    headers: { ...(uid || bearer ? { Authorization: `Bearer ${bearer ?? await token(uid!)}` } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}
const enroll = (uid: string, appId = 'shop', extra: Record<string, unknown> = {}) => call('POST', `/apps/${appId}/promoters/enroll`, uid, { consent: true, ...extra });
const first = async <T>(sql: string, ...args: unknown[]) => env.DB.prepare(sql).bind(...args).first<T>();
const count = async (sql: string, ...args: unknown[]) => (await first<{ n: number }>(sql, ...args))!.n;

beforeEach(async () => {
  mockNetwork();
  for (const t of TABLES) await env.DB.prepare(`DELETE FROM ${t}`).run();
  await resetTables();
  for (const uid of [OWNER, ADA, BOB]) await seedUser(uid);
  await seedApp('shop', OWNER); await seedApp('other', BOB); await seedApp('quiet', OWNER);
  await env.DB.prepare("INSERT INTO app_visibility (app_id, mode, roles, created_at) VALUES ('quiet','private','[]',1)").run();
  await env.DB.prepare("INSERT INTO team_members (app_id, user_id, role, created_at) VALUES ('shop','gh:1','owner',1),('other','gh:3','owner',1)").run();
});

describe('promoter enrollment on D1 (#549)', () => {
  it('enrolls a person who owns no app, grants nothing else, and replays idempotently', async () => {
    const people = await env.DB.prepare('SELECT id, login FROM users ORDER BY id').all();
    const team = await env.DB.prepare('SELECT * FROM team_members ORDER BY app_id, user_id').all();
    const apps = await env.DB.prepare('SELECT id, creator_id FROM apps ORDER BY id').all();
    const res = await enroll(ADA, 'shop', { display_name: 'Ada', return_path: '/promoters/shop' });
    expect(res.status).toBe(201);
    const out = await res.json<{ created: boolean; return_path: string; promoter: { code: string; status: string; share_url: string } }>();
    expect(out).toMatchObject({ created: true, return_path: '/promoters/shop', promoter: { status: 'active' } });
    expect(out.promoter.code).toMatch(/^[A-Z2-9]{8}$/);
    expect((await env.DB.prepare('SELECT id, login FROM users ORDER BY id').all()).results).toEqual(people.results);
    expect((await env.DB.prepare('SELECT * FROM team_members ORDER BY app_id, user_id').all()).results).toEqual(team.results);
    expect((await env.DB.prepare('SELECT id, creator_id FROM apps ORDER BY id').all()).results).toEqual(apps.results);
    for (const path of ['/apps/shop/promoters', '/apps/shop/team', '/apps/shop/promoters/settings']) expect((await call('GET', path, ADA)).status).toBe(403);
    const again = await enroll(ADA, 'shop', { display_name: 'Changed' });
    expect(await again.json()).toMatchObject({ created: false, promoter: { code: out.promoter.code, display_name: 'Ada' } });
    expect(await count('SELECT COUNT(*) AS n FROM app_promoters')).toBe(1);
  });

  it('refuses app-bound, workload and unproven credentials and a missing token', async () => {
    for (const cred of [credentialContext('app_bound', 'shop'), credentialContext('workload_session'), null]) {
      expect((await call('POST', '/apps/shop/promoters/enroll', null, { consent: true }, await token(ADA, cred))).status).toBe(403);
    }
    expect((await call('POST', '/apps/shop/promoters/enroll', null, { consent: true })).status).toBe(401);
    expect(await count('SELECT COUNT(*) AS n FROM app_promoters')).toBe(0);
  });

  it('a real concurrent burst makes one promoter, one code and one audit event', async () => {
    const burst = await Promise.all(Array.from({ length: 20 }, () => enroll(ADA)));
    expect(burst.filter((r) => r.status === 201)).toHaveLength(1);
    expect(burst.filter((r) => r.status === 200)).toHaveLength(19);
    expect(await count('SELECT COUNT(*) AS n FROM app_promoters')).toBe(1);
    expect(await count("SELECT COUNT(*) AS n FROM app_promoter_events WHERE action = 'enrolled'")).toBe(1);
    const many = await Promise.all([BOB, OWNER, ADA].map((uid) => Promise.all(Array.from({ length: 5 }, () => enroll(uid, 'other')))));
    expect(many.flat().every((r) => r.status === 200 || r.status === 201)).toBe(true);
    expect(await count("SELECT COUNT(DISTINCT code) AS n FROM app_promoters")).toBe(await count('SELECT COUNT(*) AS n FROM app_promoters'));
  });

  it('keeps a suspension through concurrent onboarding, relogin and a withdrawal attempt, and only the owner lifts it', async () => {
    const { promoter } = await (await enroll(ADA)).json<{ promoter: { promoter_id: string; code: string } }>();
    await Promise.all([
      call('POST', `/apps/shop/promoters/${promoter.promoter_id}/status`, OWNER, { status: 'suspended', reason: 'spam' }),
      enroll(ADA), enroll(ADA), enroll(ADA, 'shop', { display_name: 'x' }),
    ]);
    expect((await first<{ status: string }>('SELECT status FROM app_promoters'))!.status).toBe('suspended');
    for (const r of await Promise.all([enroll(ADA), enroll(ADA)])) expect((await r.json<{ promoter: { status: string } }>()).promoter.status).toBe('suspended');
    expect((await call('POST', '/apps/shop/promoters/me/withdraw', ADA, {})).status).toBe(409);
    expect((await call('GET', `/storefront/promoters/code/${promoter.code}`, null)).status).toBe(404);
    expect((await call('POST', `/apps/shop/promoters/${promoter.promoter_id}/status`, ADA, { status: 'active' })).status).toBe(403);
    expect((await call('POST', `/apps/shop/promoters/${promoter.promoter_id}/status`, OWNER, { status: 'active' })).status).toBe(200);
    expect((await call('GET', `/storefront/promoters/code/${promoter.code}`, null)).status).toBe(200);
    const trail = await (await call('GET', '/apps/shop/promoters/events', OWNER)).json<{ events: { action: string }[] }>();
    expect(trail.events.map((e) => e.action)).toEqual(['reactivated', 'suspended', 'enrolled']);
  });

  it('answers private and missing apps identically, scopes per app, and keeps promoters apart', async () => {
    const missing = await enroll(ADA, 'nope'), priv = await enroll(ADA, 'quiet');
    expect([priv.status, await priv.text()]).toEqual([missing.status, await missing.text()]);
    const shop = await (await enroll(ADA, 'shop')).json<{ promoter: { code: string } }>(), other = await (await enroll(ADA, 'other')).json<{ promoter: { code: string } }>();
    expect(shop.promoter.code).not.toBe(other.promoter.code);
    expect((await (await call('GET', '/promoters/me', ADA)).json<{ promoters: unknown[] }>()).promoters).toHaveLength(2);
    expect((await call('GET', '/apps/shop/promoters/me', BOB)).status).toBe(404);
    expect((await call('GET', '/apps/shop/promoters', BOB)).status).toBe(403);
    await env.DB.prepare("INSERT INTO app_visibility (app_id, mode, roles, created_at) VALUES ('other','private','[]',1)").run();
    expect((await call('GET', `/storefront/promoters/code/${other.promoter.code}`, null)).status).toBe(404);
    expect((await call('GET', '/storefront/promoters/apps', null).then((r) => r.json<{ apps: { appId: string }[] }>())).apps.map((a) => a.appId)).toEqual(['shop']);
  });

  it('withdraws on per-app account deletion, survives transfer, drops with the app, and the audit trail is append-only', async () => {
    const { promoter } = await (await enroll(ADA, 'shop', { display_name: 'Ada' })).json<{ promoter: { code: string; promoter_id: string } }>();
    await env.DB.prepare("INSERT INTO per_app_deleted_users (app_id, user_id, deleted_by, deleted_at) VALUES ('shop','gh:2','gh:2',50)").run();
    expect(await first("SELECT status, display_name FROM app_promoters WHERE app_id = 'shop'")).toEqual({ status: 'withdrawn', display_name: null });
    const refused = await enroll(ADA, 'shop');
    expect([refused.status, await refused.text()]).toEqual([403, 'account_deleted_in_app']);
    expect(await count("SELECT COUNT(*) AS n FROM app_promoter_events WHERE action = 'account_deleted'")).toBe(1);

    const kept = await (await enroll(ADA, 'other')).json<{ promoter: { promoter_id: string } }>();
    await env.DB.prepare("UPDATE apps SET creator_id = 'gh:1' WHERE id = 'other'").run();
    await env.DB.prepare("DELETE FROM team_members WHERE app_id = 'other' AND user_id = 'gh:3'").run();
    expect((await call('GET', '/apps/other/promoters', BOB)).status).toBe(403);
    expect((await call('GET', '/apps/other/promoters', OWNER)).status).toBe(200);
    expect(await count("SELECT COUNT(*) AS n FROM app_promoters WHERE id = ?", kept.promoter.promoter_id)).toBe(1);

    await expect(env.DB.prepare("UPDATE app_promoter_events SET reason = 'x'").run()).rejects.toThrow(/append-only/);
    await env.DB.prepare("DELETE FROM apps WHERE id = 'other'").run();
    expect(await count("SELECT COUNT(*) AS n FROM app_promoters WHERE app_id = 'other'")).toBe(0);
    expect(await count("SELECT COUNT(*) AS n FROM app_promoter_events WHERE app_id = 'other'")).toBe(1);
    expect(promoter.code).toBeTruthy();
  });
});
