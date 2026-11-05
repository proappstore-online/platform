import { seedReferralReady } from '../promoter-test-helpers.js';
import { beforeEach, describe, expect, it } from 'vitest';
import { credentialContext, mintSession } from '@proappstore/build-core';
import { app } from '../index.js';
import { sqliteD1 } from '../sqlite-d1.js';
import { makeEnv } from '../test-helpers.js';
import type { Env } from '../types.js';
import { CODE_LENGTH, generateCode, normalizeCode } from '../lib/promoters/codes.js';
import { enroll } from '../lib/promoters/service.js';

// #549 on real SQL (every migration applied): app-scoped promoter enrollment, public codes, narrow own access
// and owner lifecycle. Real workerd/D1 coverage of the same contract is in runtime-tests/test/backend/promoters.test.ts.

let db: ReturnType<typeof sqliteD1>;
let env: Env;
const OWNER = 'gh:1', ADA = 'gh:2', BOB = 'gh:3', CAROL = 'gh:4';
const tokens = new Map<string, string>();
const sign = (uid: string, cred: ReturnType<typeof credentialContext> | null = credentialContext('first_party_session'), extra: Record<string, unknown> = {}) =>
  mintSession({ uid, roles: ['user'], auth_time: Math.floor(Date.now() / 1000), auth_method: 'google', ...(cred ? { cred } : {}), ...extra }, env.SESSION_SIGNING_KEY);
const as = async (uid: string) => { if (!tokens.has(uid)) tokens.set(uid, await sign(uid)); return tokens.get(uid)!; };

const call = async (method: string, path: string, uid: string | null, body?: unknown, token?: string) => app.request(`/v1${path}`, {
  method, headers: { ...(uid || token ? { Authorization: `Bearer ${token ?? await as(uid!)}` } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
}, env);
const json = async <T = Record<string, any>>(r: Response) => (await r.json()) as T;
const enrollAs = (uid: string, appId = 'shop', extra: Record<string, unknown> = {}) => call('POST', `/apps/${appId}/promoters/enroll`, uid, { consent: true, ...extra });
const mine = async (uid: string, appId = 'shop') => (await json(await call('GET', `/apps/${appId}/promoters/me`, uid))).promoter;
const rows = (sql: string, ...args: unknown[]) => db.sql.prepare(sql).all(...(args as never[]));
const one = (sql: string, ...args: unknown[]) => rows(sql, ...args)[0];
const suspend = (promoterId: string, reason = 'spam', appId = 'shop', uid = OWNER) => call('POST', `/apps/${appId}/promoters/${promoterId}/status`, uid, { status: 'suspended', reason });
const lift = (promoterId: string, appId = 'shop', uid = OWNER) => call('POST', `/apps/${appId}/promoters/${promoterId}/status`, uid, { status: 'active' });
const resolve = (code: string) => app.request(`/v1/storefront/promoters/code/${encodeURIComponent(code)}`, {}, env);
const snapshot = () => JSON.stringify(['users', 'team_members', 'apps', 'app_roles', 'app_visibility'].map((t) => rows(`SELECT * FROM ${t} ORDER BY 1, 2`)));

beforeEach(async () => {
  db = sqliteD1();
  db.sql.exec(`PRAGMA foreign_keys = ON;
    INSERT INTO users (id, provider, provider_id, login, created_at, last_login_at) VALUES
      ('gh:1','github','1','owner-login',0,0),('gh:2','google','2','ada-login',0,0),('gh:3','github','3','bob-login',0,0),('gh:4','google','4','carol-login',0,0);
    INSERT INTO apps (id, creator_id, created_at) VALUES ('shop','gh:1',1),('other','gh:3',2),('quiet','gh:1',3);
    INSERT INTO team_members (app_id, user_id, role, created_at) VALUES ('shop','gh:1','owner',0),('other','gh:3','owner',0);
    INSERT INTO app_visibility (app_id, mode, roles, created_at) VALUES ('quiet','private','[]',0);`);
  await seedReferralReady(db, 'shop', 'other');
  env = makeEnv({ DB: db }) as Env;
  tokens.clear();
});

describe('promoter codes', () => {
  it('are 8 unambiguous characters, well spread, and forgiving to type', () => {
    const codes = new Set(Array.from({ length: 2000 }, () => generateCode()));
    expect(codes.size).toBe(2000);
    for (const code of codes) expect(code).toMatch(new RegExp(`^[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{${CODE_LENGTH}}$`));
    expect(normalizeCode(' abcd-efgh ')).toBe('ABCDEFGH');
    for (const bad of ['ABCDEFG', 'ABCDEFGHJ', 'ABCDEF0H', 'ABCDEFIH', '', null, 5, 'a'.repeat(40)]) expect(normalizeCode(bad)).toBeNull();
  });
});

describe('enrollment (#549)', () => {
  it('lets a person with no owned app enroll immediately and returns what the workspace needs, with no new login', async () => {
    const response = await enrollAs(ADA, 'shop', { display_name: 'Ada L.', return_path: '/promoters/shop?welcome=1' });
    expect(response.status).toBe(201);
    const out = await json(response);
    expect(out).toMatchObject({ ok: true, created: true, reactivated: false, return_path: '/promoters/shop?welcome=1',
      promoter: { app_id: 'shop', status: 'active', display_name: 'Ada L.', code_active: true, app_public: true } });
    expect(out.promoter.code).toMatch(/^[A-Z2-9]{8}$/);
    expect(out.promoter.share_path).toBe(`/apps/shop?ref=${out.promoter.code}`);
    expect(out.promoter.share_url).toBe(`https://proappstore.online/apps/shop?ref=${out.promoter.code}`);
    expect(JSON.stringify(out)).not.toMatch(/gh:2|ada-login|user_id/);
    expect((await mine(ADA)).promoter_id).toBe(out.promoter.promoter_id);
  });

  it('requires explicit consent and plain-text profile fields', async () => {
    for (const bad of [{}, { consent: false }, { consent: 'yes' }]) expect((await call('POST', '/apps/shop/promoters/enroll', ADA, bad)).status).toBe(400);
    for (const name of ['<b>Ada</b>', 'https://evil.test', 'ada@example.com', 'x'.repeat(61), 5]) expect((await enrollAs(ADA, 'shop', { display_name: name })).status).toBe(400);
    for (const path of ['//evil.test', 'https://evil.test/x', '/\\evil.test', 'javascript:alert(1)', '/javascript:alert(1)', '/a b', '/' + 'x'.repeat(600), 5]) {
      const r = await enrollAs(ADA, 'shop', { return_path: path });
      expect([r.status, await r.text()]).toEqual([400, 'invalid_return_path']);
    }
    expect((await call('POST', '/apps/shop/promoters/enroll', ADA)).status).toBe(400);
    expect(rows('SELECT * FROM app_promoters')).toEqual([]);
  });

  it('grants no other right: users, team, app roles, apps and visibility are untouched', async () => {
    const before = snapshot();
    expect((await enrollAs(ADA, 'shop', { display_name: 'Ada' })).status).toBe(201);
    expect((await enrollAs(ADA, 'other')).status).toBe(201);
    expect(snapshot()).toBe(before);
    for (const path of ['/apps/shop/promoters', '/apps/shop/promoters/events', '/apps/shop/promoters/settings', '/apps/shop/team', '/apps/shop/enquiries']) {
      expect([path, (await call('GET', path, ADA)).status]).toEqual([path, 403]);
    }
    expect((await call('PUT', '/apps/shop/promoters/settings', ADA, { enrollment_open: false })).status).toBe(403);
  });

  it('keeps an existing role, team membership and profile intact', async () => {
    db.sql.exec("INSERT INTO team_members (app_id, user_id, role, created_at) VALUES ('shop','gh:4','developer',5)");
    const before = snapshot();
    expect((await enrollAs(CAROL)).status).toBe(201);
    expect(snapshot()).toBe(before);
    expect(one("SELECT role FROM team_members WHERE user_id = 'gh:4'")).toEqual({ role: 'developer' });
  });

  it('refuses everything but a person signed in as themselves', async () => {
    const cases: [string, string][] = [
      ['app-bound', await sign(ADA, credentialContext('app_bound', 'shop'))],
      ['workload', await sign(ADA, credentialContext('workload_session'))],
      ['unproven', await sign(ADA, null)],
      ['via', await sign(ADA, credentialContext('first_party_session'), { via: 'oidc-e2e' })],
    ];
    for (const [name, token] of cases) {
      for (const [method, path, body] of [['POST', '/apps/shop/promoters/enroll', { consent: true }], ['GET', '/promoters/me'], ['GET', '/apps/shop/promoters/me'], ['POST', '/apps/shop/promoters/me/withdraw', {}]] as const) {
        expect([name, path, (await call(method, path, null, body, token)).status]).toEqual([name, path, 403]);
      }
    }
    expect((await call('GET', '/promoters/me', null)).status).toBe(401);
    expect(rows('SELECT * FROM app_promoters')).toEqual([]);
  });

  it('is idempotent: a replay changes nothing, keeps the person\'s profile and writes one audit event', async () => {
    const first = await json(await enrollAs(ADA, 'shop', { display_name: 'Ada' }));
    const again = await enrollAs(ADA, 'shop', { display_name: 'Someone Else' });
    expect(again.status).toBe(200);
    expect(await json(again)).toMatchObject({ created: false, reactivated: false, promoter: { promoter_id: first.promoter.promoter_id, code: first.promoter.code, display_name: 'Ada' } });
    expect(rows('SELECT * FROM app_promoters')).toHaveLength(1);
    expect(rows("SELECT action FROM app_promoter_events")).toEqual([{ action: 'enrolled' }]);
  });

  it('survives simultaneous enrollment: one row, one code, one event', async () => {
    const results = await Promise.all(Array.from({ length: 12 }, () => enrollAs(ADA, 'shop', { display_name: 'Ada' })));
    expect(results.map((r) => r.status).sort()).toEqual([200, 200, 200, 200, 200, 200, 200, 200, 200, 200, 200, 201]);
    expect(new Set((await Promise.all(results.map(json))).map((r) => r.promoter.code)).size).toBe(1);
    expect(rows('SELECT * FROM app_promoters')).toHaveLength(1);
    expect(rows("SELECT * FROM app_promoter_events WHERE action = 'enrolled'")).toHaveLength(1);
  });

  it('retries a code collision with a fresh code, and fails closed if it never gets one', async () => {
    const taken = (await json(await enrollAs(ADA))).promoter.code as string;
    const result = await enroll(db, 'shop', CAROL, { consent: true, display_name: null }, Date.now(), (() => { let n = 0; return () => (n++ === 0 ? taken : 'ZZZZZZZZ'); })());
    expect([result.created, result.promoter.code]).toEqual([true, 'ZZZZZZZZ']);
    await expect(enroll(db, 'other', CAROL, { consent: true, display_name: null }, Date.now(), () => taken)).rejects.toMatchObject({ status: 503 });
    expect(rows("SELECT * FROM app_promoters WHERE app_id = 'other'")).toEqual([]);
  });

  it('keeps a person\'s several apps separate: own code, own relationship, own scope', async () => {
    const shop = (await json(await enrollAs(ADA, 'shop'))).promoter, other = (await json(await enrollAs(ADA, 'other'))).promoter;
    expect(shop.code).not.toBe(other.code);
    expect(shop.promoter_id).not.toBe(other.promoter_id);
    expect((await json(await call('GET', '/promoters/me', ADA))).promoters.map((p: { app_id: string }) => p.app_id).sort()).toEqual(['other', 'shop']);
    expect((await json(await resolve(shop.code))).app_id).toBe('shop');
    expect((await json(await resolve(other.code))).app_id).toBe('other');
    expect((await call('GET', '/apps/shop/promoters/me', BOB)).status).toBe(404); // another person has nothing here
    expect((await call('GET', '/apps/quiet/promoters/me', ADA)).status).toBe(404);
    expect((await json(await call('GET', '/promoters/me', BOB))).promoters).toEqual([]);
  });

  it('renames only the caller\'s own active relationship', async () => {
    await enrollAs(ADA, 'shop', { display_name: 'Ada' });
    expect((await json(await call('PATCH', '/apps/shop/promoters/me', ADA, { display_name: 'Ada L.' }))).promoter.display_name).toBe('Ada L.');
    expect((await call('PATCH', '/apps/shop/promoters/me', ADA, { display_name: '<script>' })).status).toBe(400);
    expect((await call('PATCH', '/apps/shop/promoters/me', BOB, { display_name: 'x' })).status).toBe(404);
    expect((await json(await call('PATCH', '/apps/shop/promoters/me', ADA, { display_name: '' }))).promoter.display_name).toBeNull();
  });
});

describe('public codes and discovery', () => {
  it('resolves a live code of a public app, typed any way, and everything else identically', async () => {
    const { promoter } = await json(await enrollAs(ADA, 'shop', { display_name: 'Ada' }));
    const typed = `${promoter.code.slice(0, 4)}-${promoter.code.slice(4)}`.toLowerCase();
    const ok = await resolve(typed);
    expect(ok.headers.get('Cache-Control')).toBe('no-store');
    expect(await json(ok)).toEqual({ valid: true, app_id: 'shop', promoter: { display_name: 'Ada' } });
    const misses = await Promise.all(['ABCDEFGH', 'nope', '2222222222', ''].map(async (c) => { const r = await resolve(c || '%20'); return [r.status, await r.text()]; }));
    expect(new Set(misses.map((m) => JSON.stringify(m))).size).toBe(1);
    expect(misses[0]![0]).toBe(404);
  });

  it('lists only public apps whose enrollment is open, with no private fields, and pages', async () => {
    const all = await app.request('/v1/storefront/promoters/apps', {}, env);
    expect(all.headers.get('Cache-Control')).toBe('public, max-age=60');
    expect((await json(all)).apps.map((a: { appId: string }) => a.appId)).toEqual(['other', 'shop']); // 'quiet' is private
    const page = await json(await app.request('/v1/storefront/promoters/apps?limit=1', {}, env));
    expect(page).toMatchObject({ apps: [{ appId: 'other' }], next: { after: 'other' } });
    expect((await json(await app.request('/v1/storefront/promoters/apps?limit=1&after=other', {}, env))).apps.map((a: { appId: string }) => a.appId)).toEqual(['shop']);
    expect(JSON.stringify(page)).not.toMatch(/creator|gh:|support/);
    expect((await call('PUT', '/apps/shop/promoters/settings', OWNER, { enrollment_open: false })).status).toBe(200);
    expect((await json(await app.request('/v1/storefront/promoters/apps', {}, env))).apps.map((a: { appId: string }) => a.appId)).toEqual(['other']);
  });
});

describe('lifecycle: suspension, withdrawal and the owner', () => {
  it('suspension stops the code and survives replay, relogin, withdrawal attempts and concurrent onboarding', async () => {
    const { promoter } = await json(await enrollAs(ADA, 'shop', { display_name: 'Ada' }));
    const suspended = await json(await suspend(promoter.promoter_id, 'misleading posts'));
    expect(suspended.promoter).toMatchObject({ status: 'suspended', status_reason: 'misleading posts' });
    expect((await resolve(promoter.code)).status).toBe(404);

    const replays = await Promise.all([enrollAs(ADA), enrollAs(ADA), enrollAs(ADA), enrollAs(ADA, 'shop', { display_name: 'Ada 2' })]);
    for (const r of replays) expect(await json(r)).toMatchObject({ created: false, reactivated: false, promoter: { status: 'suspended', status_reason: 'misleading posts', display_name: 'Ada' } });
    const withdrawal = await call('POST', '/apps/shop/promoters/me/withdraw', ADA, {});
    expect([withdrawal.status, await withdrawal.text()]).toEqual([409, 'suspended_by_owner']);
    expect((await mine(ADA)).status).toBe('suspended');

    // Enrollment racing a suspension can never leave the promoter active.
    const raced = await json(await enrollAs(CAROL));
    await Promise.all([suspend(raced.promoter.promoter_id), enrollAs(CAROL), enrollAs(CAROL)]);
    expect((await mine(CAROL)).status).toBe('suspended');

    const lifted = await json(await lift(promoter.promoter_id));
    expect(lifted.promoter).toMatchObject({ status: 'active', status_reason: null, code: promoter.code });
    expect(((await json(await resolve(promoter.code))) as { app_id: string }).app_id).toBe('shop');
  });

  it('audits every owner change with who, what and why, and the trail cannot be rewritten', async () => {
    const { promoter } = await json(await enrollAs(ADA));
    await suspend(promoter.promoter_id, 'spam');
    await suspend(promoter.promoter_id, 'again'); // idempotent: no second event
    await lift(promoter.promoter_id);
    const trail = await json(await call('GET', `/apps/shop/promoters/events?promoter_id=${promoter.promoter_id}`, OWNER));
    expect(trail.events.map((e: { action: string }) => e.action)).toEqual(['reactivated', 'suspended', 'enrolled']);
    expect(trail.events[1]).toMatchObject({ actor_kind: 'owner', from_status: 'active', to_status: 'suspended', reason: 'spam' });
    expect(JSON.stringify(trail)).not.toMatch(/gh:|actor_id/);
    expect(() => db.sql.exec("UPDATE app_promoter_events SET reason = 'x'")).toThrow(/append-only/);
    expect((await call('GET', '/apps/shop/promoters/events', ADA)).status).toBe(403);
  });

  it('only the app owner manages, and only within the app', async () => {
    const shop = (await json(await enrollAs(ADA, 'shop'))).promoter, other = (await json(await enrollAs(ADA, 'other'))).promoter;
    expect((await suspend(shop.promoter_id, 'x', 'shop', BOB)).status).toBe(403); // another app's owner
    expect((await suspend(shop.promoter_id, 'x', 'shop', ADA)).status).toBe(403); // the promoter herself
    expect((await suspend(other.promoter_id, 'x', 'shop', OWNER)).status).toBe(404); // a promoter of another app, via this app's path
    expect((await call('GET', '/apps/shop/promoters', BOB)).status).toBe(403);
    expect((await suspend('no-such', 'x')).status).toBe(404);
    expect((await call('POST', `/apps/shop/promoters/${shop.promoter_id}/status`, OWNER, { status: 'withdrawn' })).status).toBe(400);
    expect((await call('POST', `/apps/shop/promoters/${shop.promoter_id}/status`, OWNER, { status: 'suspended', reason: 'x\u0000y' })).status).toBe(400);
    expect((await mine(ADA)).status).toBe('active');
  });

  it('shows the owner each promoter\'s chosen name and code, with counts and paging, but never a user id or email', async () => {
    for (const [uid, name] of [[ADA, 'Ada'], [CAROL, null], [BOB, 'Bob']] as const) await enrollAs(uid, 'shop', name ? { display_name: name } : {});
    const list = await json(await call('GET', '/apps/shop/promoters?limit=2', OWNER));
    expect(list.promoters).toHaveLength(2);
    expect(list.counts).toEqual({ active: 3, suspended: 0, withdrawn: 0, total: 3 });
    expect(list.next).toEqual({ before_id: list.promoters[1].promoter_id });
    const rest = await json(await call('GET', `/apps/shop/promoters?limit=2&before_id=${list.next.before_id}`, OWNER));
    expect(rest.promoters).toHaveLength(1);
    expect(rest.next).toBeNull();
    expect(JSON.stringify([list, rest])).not.toMatch(/gh:|login|@|user_id/);
    expect((await call('GET', '/apps/shop/promoters?status=bogus', OWNER)).status).toBe(400);
    expect((await json(await call('GET', '/apps/shop/promoters?status=suspended', OWNER))).promoters).toEqual([]);
  });

  it('pages stably through promoters created in the same millisecond', async () => {
    const insert = db.sql.prepare("INSERT INTO app_promoters (id, app_id, user_id, code, status, consent_version, consented_at, created_at, updated_at) VALUES (?, 'shop', ?, ?, 'active', 1, 5, 5, 5)");
    db.sql.exec("INSERT INTO users (id, provider, provider_id, login, created_at, last_login_at) VALUES ('gh:10','github','10','t10',0,0),('gh:11','github','11','t11',0,0),('gh:12','github','12','t12',0,0),('gh:13','github','13','t13',0,0),('gh:14','github','14','t14',0,0)");
    const ids = [10, 11, 12, 13, 14].map((n) => { insert.run(`p${n}`, `gh:${n}`, `CODE222${n - 10}`); return `p${n}`; });
    const seen: string[] = []; let cursor = '';
    for (let guard = 0; guard < 10; guard++) {
      const page = await json(await call('GET', `/apps/shop/promoters?limit=2${cursor}`, OWNER));
      seen.push(...page.promoters.map((p: { promoter_id: string }) => p.promoter_id));
      if (!page.next) break;
      cursor = `&before_id=${page.next.before_id}`;
    }
    expect(seen).toEqual([...ids].reverse());
  });

  it('withdrawal ends the code and public name, is idempotent, and re-enrollment keeps the code and records fresh consent', async () => {
    const first = (await json(await enrollAs(ADA, 'shop', { display_name: 'Ada' }))).promoter;
    const out = await call('POST', '/apps/shop/promoters/me/withdraw', ADA, {});
    expect(await json(out)).toMatchObject({ ok: true, promoter: { status: 'withdrawn', display_name: null, code_active: false } });
    expect((await resolve(first.code)).status).toBe(404);
    expect((await call('POST', '/apps/shop/promoters/me/withdraw', ADA, {})).status).toBe(200);
    expect((await call('POST', '/apps/shop/promoters/me/withdraw', BOB, {})).status).toBe(404);
    expect((await call('PATCH', '/apps/shop/promoters/me', ADA, { display_name: 'x' })).status).toBe(409);
    const invalid = await call('POST', `/apps/shop/promoters/${first.promoter_id}/status`, OWNER, { status: 'active' });
    expect([invalid.status, await invalid.text()]).toEqual([409, 'invalid_transition']);
    const back = await json(await enrollAs(ADA, 'shop', { display_name: 'Ada Again' }));
    expect(back).toMatchObject({ created: false, reactivated: true, promoter: { status: 'active', code: first.code, promoter_id: first.promoter_id, display_name: 'Ada Again' } });
    expect((await resolve(first.code)).status).toBe(200);
    expect(rows('SELECT action FROM app_promoter_events ORDER BY created_at, rowid').map((r) => r.action)).toEqual(['enrolled', 'withdrawn', 're_enrolled']);
  });

  it('withdraws and anonymises a person who erased their account in the app, and refuses them afterwards', async () => {
    const { promoter } = await json(await enrollAs(ADA, 'shop', { display_name: 'Ada' }));
    db.sql.exec("INSERT INTO per_app_deleted_users (app_id, user_id, deleted_by, deleted_at) VALUES ('shop','gh:2','gh:2',99)");
    expect(one("SELECT status, display_name FROM app_promoters WHERE id = ?", promoter.promoter_id)).toEqual({ status: 'withdrawn', display_name: null });
    expect((await resolve(promoter.code)).status).toBe(404);
    expect(one("SELECT action, actor_kind FROM app_promoter_events WHERE action = 'account_deleted'")).toEqual({ action: 'account_deleted', actor_kind: 'system' });
    const refused = await enrollAs(ADA);
    expect([refused.status, await refused.text()]).toEqual([403, 'account_deleted_in_app']);
    expect((await enrollAs(ADA, 'other')).status).toBe(201); // other apps are unaffected
  });
});

describe('app state: private, closed, removed, transferred', () => {
  it('answers private and missing apps identically, and a closed app with its own refusal', async () => {
    const missing = await enrollAs(ADA, 'nope'), priv = await enrollAs(ADA, 'quiet');
    expect([priv.status, await priv.text()]).toEqual([missing.status, await missing.text()]);
    expect(missing.status).toBe(404);
    expect((await call('PUT', '/apps/shop/promoters/settings', OWNER, { enrollment_open: false })).status).toBe(200);
    expect(await json(await call('GET', '/apps/shop/promoters/settings', OWNER))).toEqual({ enrollment_open: false, referral_tracking: { ready: true, reason: null, protocol_version: 1 } });
    const closed = await enrollAs(ADA, 'shop');
    expect([closed.status, await closed.text()]).toEqual([403, 'enrollment_closed']);
    expect((await call('PUT', '/apps/shop/promoters/settings', OWNER, { enrollment_open: 'no' })).status).toBe(400);
    expect(rows('SELECT * FROM app_promoters')).toEqual([]);
  });

  it('a promoter keeps their relationship when the app goes private or enrollment closes, but the code stops while private', async () => {
    const { promoter } = await json(await enrollAs(ADA, 'shop'));
    await call('PUT', '/apps/shop/promoters/settings', OWNER, { enrollment_open: false });
    expect((await resolve(promoter.code)).status).toBe(200); // closing enrollment does not kill existing links
    db.sql.exec("INSERT INTO app_visibility (app_id, mode, roles, created_at) VALUES ('shop','private','[]',0)");
    expect((await resolve(promoter.code)).status).toBe(404);
    expect((await mine(ADA))).toMatchObject({ status: 'active', app_public: false });
    expect((await json(await app.request('/v1/storefront/promoters/apps', {}, env))).apps.map((a: { appId: string }) => a.appId)).toEqual(['other']);
    db.sql.exec("UPDATE app_visibility SET mode = 'public' WHERE app_id = 'shop'");
    expect((await resolve(promoter.code)).status).toBe(200);
  });

  it('a withdrawn promoter cannot re-enroll into a private or closed app', async () => {
    await enrollAs(ADA, 'shop');
    await call('POST', '/apps/shop/promoters/me/withdraw', ADA, {});
    db.sql.exec("INSERT INTO app_visibility (app_id, mode, roles, created_at) VALUES ('shop','private','[]',0)");
    expect((await enrollAs(ADA, 'shop')).status).toBe(404);
    expect((await mine(ADA)).status).toBe('withdrawn');
  });

  it('removes a deleted app\'s promoters but keeps the audit trail', async () => {
    const { promoter } = await json(await enrollAs(ADA, 'other'));
    db.sql.exec('DELETE FROM apps WHERE id = \'other\'');
    expect(rows('SELECT * FROM app_promoters')).toEqual([]);
    expect((await resolve(promoter.code)).status).toBe(404);
    expect((await json(await call('GET', '/promoters/me', ADA))).promoters).toEqual([]);
    expect(rows("SELECT action FROM app_promoter_events WHERE app_id = 'other'")).toEqual([{ action: 'enrolled' }]);
  });

  it('survives an ownership transfer: promoters stay, control follows the new owner, no right changes hands', async () => {
    const { promoter } = await json(await enrollAs(ADA, 'shop', { display_name: 'Ada' }));
    // A transfer moves apps.creator_id; the previous owner's separate team row is the existing platform's to remove, so a full handover does both.
    db.sql.exec("UPDATE apps SET creator_id = 'gh:3' WHERE id = 'shop'; DELETE FROM team_members WHERE app_id = 'shop' AND user_id = 'gh:1'");
    expect((await call('GET', '/apps/shop/promoters', OWNER)).status).toBe(403);
    expect((await suspend(promoter.promoter_id, 'x', 'shop', OWNER)).status).toBe(403);
    expect((await json(await call('GET', '/apps/shop/promoters', BOB))).counts.total).toBe(1);
    expect((await suspend(promoter.promoter_id, 'new owner', 'shop', BOB)).status).toBe(200);
    expect((await mine(ADA)).status).toBe('suspended');
    expect(one("SELECT creator_id FROM apps WHERE id = 'shop'")).toEqual({ creator_id: 'gh:3' });
    expect(rows("SELECT * FROM team_members WHERE user_id = 'gh:2'")).toEqual([]);
  });
});
