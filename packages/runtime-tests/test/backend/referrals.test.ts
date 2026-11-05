import { SELF, env as providedEnv } from 'cloudflare:test';
import { credentialContext, mintSession } from '@proappstore/build-core';
import { beforeEach, describe, expect, it } from 'vitest';
import type { Env } from '../../../backend/src/types';
import { BASE, mockNetwork, resetTables, seedApp, seedUser, viaHostApi } from './helpers';

// #550 on workerd and real D1: referral capture and first-activation attribution. The trust boundary is real here:
// only the HostApi service binding keeps X-PAS-App, so a forged header on a direct request is not an activation.

const env = providedEnv as unknown as Env;
const OWNER = 'gh:1', PAT = 'gh:2', PRU = 'gh:3', NEW1 = 'gh:10', NEW2 = 'gh:11', NEW3 = 'gh:12', NEW4 = 'gh:13';
const TABLES = ['app_referral_events', 'app_referral_attributions', 'app_user_activations', 'app_promoter_events', 'app_promoters', 'per_app_deleted_users', 'app_visibility', 'team_members', 'kv'];

const token = (uid: string, cred: ReturnType<typeof credentialContext>) => mintSession({ uid, roles: ['user'], auth_time: Math.floor(Date.now() / 1000), auth_method: 'google', cred }, env.SESSION_SIGNING_KEY);
const appBound = (uid: string, appId = 'shop') => token(uid, credentialContext('app_bound', appId));
const person = (uid: string) => token(uid, credentialContext('first_party_session'));

/** Through the host's binding: the one path that keeps X-PAS-App. */
const host = async (method: string, path: string, uid: string, body?: unknown, appId = 'shop') => viaHostApi(`${BASE}/v1${path}`, {
  method, headers: { Authorization: `Bearer ${await appBound(uid, appId)}`, 'X-PAS-App': appId, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});
/** Straight to the API, with a header the caller made up: the platform strips it. */
const forged = async (method: string, path: string, uid: string, body?: unknown) => SELF.fetch(`${BASE}/v1${path}`, {
  method, headers: { Authorization: `Bearer ${await appBound(uid)}`, 'X-PAS-App': 'shop', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});
const owner = async (method: string, path: string, uid: string, body?: unknown) => SELF.fetch(`${BASE}/v1${path}`, {
  method, headers: { Authorization: `Bearer ${await person(uid)}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});
const claim = (uid: string, code: string, appId = 'shop') => host('POST', `/apps/${appId}/referrals/claim`, uid, { code }, appId).then((r) => r.json<{ credited: boolean; state: string }>());
const use = (uid: string, appId = 'shop') => host('GET', '/auth/me', uid, undefined, appId);
const first = async <T>(sql: string, ...args: unknown[]) => env.DB.prepare(sql).bind(...args).first<T>();
const count = async (sql: string, ...args: unknown[]) => (await first<{ n: number }>(sql, ...args))!.n;
let patCode = '', pruCode = '';

beforeEach(async () => {
  mockNetwork();
  for (const t of TABLES) await env.DB.prepare(`DELETE FROM ${t}`).run();
  await resetTables();
  for (const uid of [OWNER, PAT, PRU, NEW1, NEW2, NEW3, NEW4]) await seedUser(uid);
  await seedApp('shop', OWNER); await seedApp('other', OWNER);
  await env.DB.prepare("INSERT INTO team_members (app_id, user_id, role, created_at) VALUES ('shop','gh:1','owner',1),('other','gh:1','owner',1)").run();
  const enroll = async (uid: string, appId = 'shop') => (await (await owner('POST', `/apps/${appId}/promoters/enroll`, uid, { consent: true })).json<{ promoter: { code: string } }>()).promoter.code;
  patCode = await enroll(PAT); pruCode = await enroll(PRU);
});

describe('referral attribution on D1 (#550)', () => {
  it('captures pending, then confirms exactly once on the first activation made through the host', async () => {
    expect(await claim(NEW1, patCode)).toEqual({ credited: false, state: 'pending' });
    expect(await count('SELECT COUNT(*) AS n FROM app_user_activations')).toBe(0); // a claim is not an activation
    expect((await use(NEW1)).status).toBe(200);
    expect(await first("SELECT status FROM app_referral_attributions WHERE referred_user_id = 'gh:10'")).toEqual({ status: 'confirmed' });
    for (let i = 0; i < 3; i++) await use(NEW1);
    expect(await count('SELECT COUNT(*) AS n FROM app_user_activations')).toBe(1);
    expect(await count("SELECT COUNT(*) AS n FROM app_referral_events WHERE action = 'confirmed'")).toBe(1);
    expect(await claim(NEW1, patCode)).toEqual({ credited: true, state: 'confirmed' });
  });

  it('a made-up X-PAS-App on a direct request is neither a claim nor an activation', async () => {
    const res = await forged('POST', '/apps/shop/referrals/claim', NEW1, { code: patCode });
    expect(await res.json()).toEqual({ credited: false, state: 'unverified_origin' });
    expect((await forged('GET', '/auth/me', NEW2)).status).toBe(200);
    expect(await count('SELECT COUNT(*) AS n FROM app_user_activations')).toBe(0);
    expect(await count('SELECT COUNT(*) AS n FROM app_referral_attributions')).toBe(0);
  });

  it('a first-party session, another app\'s session, and a failed request are not activations', async () => {
    await claim(NEW1, patCode);
    const viaPerson = await viaHostApi(`${BASE}/v1/auth/me`, { headers: { Authorization: `Bearer ${await person(NEW1)}`, 'X-PAS-App': 'shop' } });
    expect(viaPerson.status).toBe(200);
    expect((await use(NEW1, 'other')).status).toBe(200);
    expect((await host('GET', '/apps/shop/promoters', NEW1)).status).toBeGreaterThanOrEqual(400);
    expect(await count("SELECT COUNT(*) AS n FROM app_user_activations WHERE app_id = 'shop'")).toBe(0);
    expect(await first("SELECT status FROM app_referral_attributions WHERE referred_user_id = 'gh:10'")).toEqual({ status: 'pending' });
  });

  it('simultaneous activations and competing claims credit one promoter, once', async () => {
    const claims = await Promise.all([claim(NEW1, patCode), claim(NEW1, pruCode), claim(NEW1, patCode), claim(NEW1, pruCode)]);
    expect(claims.filter((c) => c.state === 'already_attributed')).toHaveLength(2);
    await Promise.all(Array.from({ length: 20 }, () => use(NEW1)));
    expect(await count('SELECT COUNT(*) AS n FROM app_referral_attributions')).toBe(1);
    expect(await count('SELECT COUNT(*) AS n FROM app_user_activations')).toBe(1);
    expect(await count("SELECT COUNT(*) AS n FROM app_referral_events WHERE action = 'confirmed'")).toBe(1);
    expect(await count("SELECT COUNT(*) AS n FROM app_referral_attributions WHERE status = 'confirmed'")).toBe(1);
  });

  it('refuses a self-referral, an existing user, a code from another app and a suspended promoter', async () => {
    expect(await claim(PAT, patCode)).toEqual({ credited: false, state: 'not_eligible' });
    await env.DB.prepare("INSERT INTO kv (app_id, user_id, key, value, value_size_bytes, updated_at) VALUES ('shop','gh:11','k',x'01',1,1)").run();
    expect(await claim(NEW2, patCode)).toEqual({ credited: false, state: 'not_eligible' });
    const otherCode = (await (await owner('POST', '/apps/other/promoters/enroll', PAT, { consent: true })).json<{ promoter: { code: string } }>()).promoter.code;
    expect(await claim(NEW3, otherCode)).toEqual({ credited: false, state: 'invalid_code' });
    await env.DB.prepare("UPDATE app_promoters SET status = 'suspended' WHERE code = ?").bind(pruCode).run();
    expect(await claim(NEW3, pruCode)).toEqual({ credited: false, state: 'invalid_code' });
    expect(await count('SELECT COUNT(*) AS n FROM app_referral_attributions')).toBe(0);
    expect(await count("SELECT COUNT(*) AS n FROM app_referral_events WHERE action = 'claim_rejected'")).toBe(2);
  });

  it('expires a claim whose promoter stopped being active before the activation; a confirmed credit stays', async () => {
    await claim(NEW1, patCode);
    await env.DB.prepare("UPDATE app_promoters SET status = 'suspended' WHERE code = ?").bind(patCode).run();
    await use(NEW1);
    expect(await first("SELECT status FROM app_referral_attributions WHERE referred_user_id = 'gh:10'")).toEqual({ status: 'expired' });
    await env.DB.prepare("UPDATE app_promoters SET status = 'active' WHERE code = ?").bind(patCode).run();
    await claim(NEW2, patCode); await use(NEW2);
    await env.DB.prepare("UPDATE app_promoters SET status = 'suspended' WHERE code = ?").bind(patCode).run();
    expect(await first("SELECT status FROM app_referral_attributions WHERE referred_user_id = 'gh:11'")).toEqual({ status: 'confirmed' });
  });

  it('the owner reviews, reverses and restores idempotently; a reversed person cannot be re-credited; the trail is append-only', async () => {
    await claim(NEW1, patCode); await use(NEW1);
    const list = await (await owner('GET', '/apps/shop/referrals', OWNER)).json<{ counts: Record<string, number>; referrals: { referral_id: string }[] }>();
    expect(list.counts).toMatchObject({ confirmed: 1 });
    expect(JSON.stringify(list)).not.toMatch(/gh:10|referred_user/);
    const id = list.referrals[0]!.referral_id;
    expect((await owner('POST', `/apps/shop/referrals/${id}/reverse`, PAT, { kind: 'correction' })).status).toBe(403);
    expect((await owner('POST', `/apps/shop/referrals/${id}/reverse`, OWNER, { kind: 'fraud_invalid', reason: 'bought' })).status).toBe(200);
    expect((await owner('POST', `/apps/shop/referrals/${id}/reverse`, OWNER, { kind: 'fraud_invalid' })).status).toBe(200);
    expect(await claim(NEW1, pruCode)).toEqual({ credited: false, state: 'already_attributed' });
    expect(await claim(NEW1, patCode)).toEqual({ credited: false, state: 'not_eligible' });
    expect(await count("SELECT COUNT(*) AS n FROM app_referral_events WHERE action LIKE 'reversed:%'")).toBe(1);
    expect((await owner('POST', `/apps/shop/referrals/${id}/restore`, OWNER, {})).status).toBe(200);
    expect(await first("SELECT status FROM app_referral_attributions WHERE id = ?", id)).toEqual({ status: 'confirmed' });
    await expect(env.DB.prepare("UPDATE app_referral_events SET reason = 'x'").run()).rejects.toThrow(/append-only/);
  });

  it('shows a promoter only their own totals, and erasure anonymises a credit and drops an unconfirmed claim', async () => {
    await claim(NEW1, patCode); await use(NEW1); await claim(NEW2, patCode); await claim(NEW3, pruCode); await use(NEW3);
    const mine = await (await owner('GET', '/apps/shop/promoters/me/referrals', PAT)).json<{ counts: Record<string, number> }>();
    expect(mine.counts).toEqual({ pending: 1, confirmed: 1 });
    expect(JSON.stringify(mine)).not.toMatch(/gh:1\d/);
    expect((await owner('GET', '/apps/shop/promoters/me/referrals', NEW1)).status).toBe(404);
    await env.DB.prepare("INSERT INTO per_app_deleted_users (app_id, user_id, deleted_by, deleted_at) VALUES ('shop','gh:10','gh:10',9),('shop','gh:11','gh:11',9)").run();
    expect(await count("SELECT COUNT(*) AS n FROM app_referral_attributions WHERE referred_user_id LIKE 'erased:%'")).toBe(1);
    expect(await count("SELECT COUNT(*) AS n FROM app_referral_attributions WHERE status = 'pending'")).toBe(0);
    expect(await count("SELECT COUNT(*) AS n FROM app_user_activations WHERE user_id = 'gh:10'")).toBe(0);
    expect(await claim(NEW1, patCode)).toEqual({ credited: false, state: 'not_eligible' });
  });

  it('goes with a deleted app, and the audit record stays', async () => {
    await claim(NEW1, patCode); await use(NEW1);
    await env.DB.prepare("DELETE FROM apps WHERE id = 'shop'").run();
    expect(await count('SELECT COUNT(*) AS n FROM app_referral_attributions')).toBe(0);
    expect(await count('SELECT COUNT(*) AS n FROM app_user_activations')).toBe(0);
    expect(await count("SELECT COUNT(*) AS n FROM app_referral_events WHERE action = 'confirmed'")).toBe(1);
  });
});


// ── #551: promoter contribution read models and public recognition ─────────────────────────────

describe('promoter contributions on D1 (#551)', () => {
  const T = Date.UTC(2026, 9, 1), DAY = 86_400_000;
  const idOf = async (code: string) => (await first<{ id: string }>('SELECT id FROM app_promoters WHERE code = ?', code))!.id;
  let seq = 0;
  const credit = async (promoterId: string, status: string, at: number) => {
    const settled = status === 'confirmed' || status === 'reversed';
    const id = `cr${++seq}`;
    await env.DB.prepare(`INSERT INTO app_referral_attributions (id, app_id, referred_user_id, promoter_id, code, status, captured_at, expires_at, activated_at, confirmed_at, created_at, updated_at)
      VALUES (?, 'shop', ?, ?, 'CODE2222', ?, ?, ?, ?, ?, ?, ?)`).bind(id, `gh:${5000 + seq}`, promoterId, status, at, at + 1e10, settled ? at : null, settled ? at : null, at, at).run();
    return id;
  };
  const mine = async (uid: string, query = '') => (await owner('GET', `/apps/shop/promoters/me/contributions${query}`, uid)).json<any>();
  const standings = async (query = '', uid = OWNER) => (await owner('GET', `/apps/shop/promoters/contributions${query}`, uid)).json<any>();

  it('computes exact totals, a share among promoters and ranks on D1, with a half-open period', async () => {
    const pat = await idOf(patCode), pru = await idOf(pruCode);
    await credit(pat, 'confirmed', T - 1); await credit(pat, 'confirmed', T); await credit(pat, 'confirmed', T + DAY - 1); await credit(pat, 'confirmed', T + DAY);
    await credit(pru, 'confirmed', T + 5); await credit(pat, 'pending', T + 6); await credit(pru, 'reversed', T + 7);
    const all = await mine(PAT);
    expect(all.contributions.promotion).toMatchObject({ counts: { confirmed: 4, pending: 1 }, share_of_referred_users: { numerator: 4, denominator: 5, percent: 80 } });
    const window = await mine(PAT, `?from=${T}&to=${T + DAY}`);
    expect(window.contributions.promotion).toMatchObject({ counts: { confirmed: 2 }, share_of_referred_users: { numerator: 2, denominator: 3 }, standing: { rank: 1, ranked_promoters: 2 } });
    expect(window.contributions.code).toMatchObject({ available: false });
    const owned = await standings(`?from=${T}&to=${T + DAY}`);
    expect(owned.totals).toMatchObject({ confirmed: 3, reversed: 1, promoters: 2 });
    expect(owned.standings.map((s: { promoter_id: string }) => s.promoter_id)).toEqual([pat, pru]);
    expect(JSON.stringify(owned)).not.toMatch(/gh:\d/);
  });

  it('handles zero denominators and an all-organic app without errors', async () => {
    const out = await mine(PAT);
    expect(out.contributions.promotion).toMatchObject({ recorded: false, share_of_referred_users: { ratio: 0, percent: 0, denominator: 0 }, standing: { rank: null } });
    await env.DB.prepare("INSERT INTO app_user_activations (app_id, user_id, first_activated_at) VALUES ('shop','gh:10',?), ('shop','gh:11',?)").bind(T, T + 1).run();
    const owned = await standings();
    expect(owned.acquisition).toMatchObject({ activations_recorded: 2, organic: 2, referred_confirmed: 0 });
    expect(JSON.stringify(owned)).not.toMatch(/NaN|Infinity/);
  });

  it('a reversal refreshes every view, once, and a restore returns it', async () => {
    const pat = await idOf(patCode);
    await credit(pat, 'confirmed', T);
    const second = await credit(pat, 'confirmed', T + 1);
    expect((await mine(PAT)).contributions.promotion.counts.confirmed).toBe(2);
    expect((await owner('POST', `/apps/shop/referrals/${second}/reverse`, OWNER, { kind: 'correction' })).status).toBe(200);
    expect((await owner('POST', `/apps/shop/referrals/${second}/reverse`, OWNER, { kind: 'correction' })).status).toBe(200);
    expect((await mine(PAT)).contributions.promotion.counts).toMatchObject({ confirmed: 1, reversed: 1 });
    expect((await standings()).totals).toMatchObject({ confirmed: 1, reversed: 1 });
    expect(await count("SELECT COUNT(*) AS n FROM app_referral_events WHERE action LIKE 'reversed:%'")).toBe(1);
    await owner('POST', `/apps/shop/referrals/${second}/restore`, OWNER, {});
    expect((await mine(PAT)).contributions.promotion.counts).toMatchObject({ confirmed: 2, reversed: 0 });
  });

  it('keeps reads narrow: a promoter cannot read standings, a non-promoter has no record, an app-bound session and a bad period are refused', async () => {
    expect((await owner('GET', '/apps/shop/promoters/contributions', PAT)).status).toBe(403);
    expect((await owner('GET', '/apps/shop/promoters/me/contributions', NEW1)).status).toBe(404);
    expect((await host('GET', '/apps/shop/promoters/me/contributions', PAT)).status).toBeGreaterThanOrEqual(400);
    expect((await owner('GET', '/apps/shop/promoters/contributions?from=yesterday', OWNER)).status).toBe(400);
  });

  it('shows a public card only after the promoter opts in, hides it when suspended, withdrawn or private, and never revives it', async () => {
    const pat = await idOf(patCode);
    await credit(pat, 'confirmed', T); await credit(pat, 'pending', T + 1);
    const card = () => SELF.fetch(`${BASE}/v1/apps/shop/promoters/${pat}/public-card`);
    expect((await card()).status).toBe(404); // not opted in
    expect((await owner('PUT', '/apps/shop/team/public/me', PAT, { display_name: 'Pat P.', visible: true, show_promotion: true })).status).toBe(200);
    const res = await card();
    expect(res.status).toBe(200);
    const body = await res.json<any>();
    expect(body).toMatchObject({ display_name: 'Pat P.', contributions: { promotion: { confirmed_referrals: 1 }, code: { available: false } } });
    expect(JSON.stringify(body)).not.toMatch(/gh:|"user_id"|promoter_id|pending|referred_user_id/);
    expect(((await (await SELF.fetch(`${BASE}/v1/storefront/apps/shop/contributors`)).json<any>()).contributors as unknown[]).length).toBe(1);

    await env.DB.prepare("UPDATE app_promoters SET status = 'suspended' WHERE id = ?").bind(pat).run();
    expect((await card()).status).toBe(404);
    await env.DB.prepare("UPDATE app_promoters SET status = 'active' WHERE id = ?").bind(pat).run();
    expect((await card()).status).toBe(200);
    expect((await owner('POST', '/apps/shop/promoters/me/withdraw', PAT, {})).status).toBe(200);
    expect(await first("SELECT show_promotion FROM app_team_public_profiles WHERE user_id = 'gh:2'")).toEqual({ show_promotion: 0 });
    expect((await card()).status).toBe(404);
    expect((await owner('POST', '/apps/shop/promoters/enroll', PAT, { consent: true })).status).toBe(200);
    expect((await card()).status).toBe(404); // re-enrolling does not bring it back
    await owner('PUT', '/apps/shop/team/public/me', PAT, { display_name: 'Pat P.', visible: true, show_promotion: true });
    expect((await card()).status).toBe(200);
    await env.DB.prepare("INSERT INTO app_visibility (app_id, mode, roles, created_at) VALUES ('shop','private','[]',1)").run();
    const priv = await card(), missing = await SELF.fetch(`${BASE}/v1/apps/nope/promoters/${pat}/public-card`);
    expect([priv.status, await priv.text()]).toEqual([missing.status, await missing.text()]);
    expect((await SELF.fetch(`${BASE}/v1/storefront/apps/shop/contributors`)).status).toBe(404);
  });
});
