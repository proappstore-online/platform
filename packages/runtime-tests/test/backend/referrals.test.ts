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
