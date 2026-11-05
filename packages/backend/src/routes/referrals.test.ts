import { beforeEach, describe, expect, it, vi } from 'vitest';
import { credentialContext, mintSession } from '@proappstore/build-core';
import { app } from '../index.js';
import { sqliteD1 } from '../sqlite-d1.js';
import { makeEnv } from '../test-helpers.js';
import type { Env } from '../types.js';
import { enroll } from '../lib/promoters/service.js';
import { ACTIVATION_GRACE_MS, CAPTURE_TTL_MS, claim, recordActivation } from '../lib/referrals/service.js';

// #550 on real SQL (every migration applied): server-owned referral capture and first-activation attribution.
// Real workerd/D1 coverage of the same contract is in runtime-tests/test/backend/referrals.test.ts.

let db: ReturnType<typeof sqliteD1>;
let env: Env;
const OWNER = 'gh:1', PAT = 'gh:2', PRU = 'gh:3', NEW1 = 'gh:10', NEW2 = 'gh:11', NEW3 = 'gh:12';
const sign = (uid: string, cred: ReturnType<typeof credentialContext> | null, extra: Record<string, unknown> = {}) =>
  mintSession({ uid, roles: ['user'], auth_time: Math.floor(Date.now() / 1000), auth_method: 'google', ...(cred ? { cred } : {}), ...extra }, env.SESSION_SIGNING_KEY);

interface CallOpts { appId?: string; mediated?: string | null; cred?: ReturnType<typeof credentialContext> | null; extra?: Record<string, unknown>; body?: unknown }
/** A request as the host sends it from inside `appId`: mediated, with an app-bound session. */
async function inApp(method: string, path: string, uid: string, opts: CallOpts = {}) {
  const appId = opts.appId ?? 'shop';
  const cred = opts.cred === undefined ? credentialContext('app_bound', appId) : opts.cred;
  const mediated = opts.mediated === undefined ? appId : opts.mediated;
  return app.request(`/v1${path}`, {
    method,
    headers: { Authorization: `Bearer ${await sign(uid, cred, opts.extra)}`, ...(mediated ? { 'X-PAS-App': mediated } : {}), ...(opts.body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    ...(opts.body === undefined ? {} : { body: JSON.stringify(opts.body) }),
  }, env);
}
const person = (method: string, path: string, uid: string, body?: unknown) => inApp(method, path, uid, { cred: credentialContext('first_party_session'), mediated: null, ...(body === undefined ? {} : { body }) });
const useApp = (uid: string, opts: CallOpts = {}) => inApp('GET', '/auth/me', uid, opts); // a successful authenticated request from inside the app
const claimCode = (uid: string, code: unknown, opts: CallOpts = {}) => inApp('POST', `/apps/${opts.appId ?? 'shop'}/referrals/claim`, uid, { ...opts, body: { code } });
const json = async <T = Record<string, any>>(r: Response) => (await r.json()) as T;
const rows = (sql: string, ...args: unknown[]) => db.sql.prepare(sql).all(...(args as never[]));
const one = (sql: string, ...args: unknown[]) => rows(sql, ...args)[0];
const attribution = (uid: string, appId = 'shop') => one('SELECT * FROM app_referral_attributions WHERE app_id = ? AND referred_user_id = ?', appId, uid);
const activation = (uid: string, appId = 'shop') => one('SELECT * FROM app_user_activations WHERE app_id = ? AND user_id = ?', appId, uid);
const events = (action?: string) => rows('SELECT * FROM app_referral_events' + (action ? ' WHERE action = ?' : '') + ' ORDER BY created_at, rowid', ...(action ? [action] : []));
let patCode = '', pruCode = '';
const promote = async (uid: string, appId = 'shop') => (await enroll(db, appId, uid, { consent: true, display_name: null })).promoter;

beforeEach(async () => {
  db = sqliteD1();
  db.sql.exec(`PRAGMA foreign_keys = ON;
    INSERT INTO users (id, provider, provider_id, login, created_at, last_login_at) VALUES
      ('gh:1','github','1','owner',0,0),('gh:2','google','2','pat',0,0),('gh:3','google','3','pru',0,0),('gh:10','google','10','n1',0,0),('gh:11','google','11','n2',0,0),('gh:12','google','12','n3',0,0);
    INSERT INTO apps (id, creator_id, created_at) VALUES ('shop','gh:1',1),('other','gh:1',2),('quiet','gh:1',3);
    INSERT INTO team_members (app_id, user_id, role, created_at) VALUES ('shop','gh:1','owner',0),('other','gh:1','owner',0);
    INSERT INTO app_visibility (app_id, mode, roles, created_at) VALUES ('quiet','private','[]',0);`);
  env = makeEnv({ DB: db }) as Env;
  patCode = (await promote(PAT)).code; pruCode = (await promote(PRU)).code;
});

describe('capture (pending) and activation (confirmed) are separate', () => {
  it('a claim before any activation is only pending, and tells the person nothing about the promoter', async () => {
    const res = await claimCode(NEW1, patCode);
    expect(await json(res)).toEqual({ credited: false, state: 'pending' });
    expect(attribution(NEW1)).toMatchObject({ status: 'pending', code: patCode, activated_at: null, confirmed_at: null });
    expect(activation(NEW1)).toBeUndefined(); // the claim itself is not an activation
    expect(JSON.stringify(await json(await claimCode(NEW1, patCode)))).not.toMatch(/gh:|promoter_id|display/);
  });

  it('the first authenticated, mediated, app-bound request confirms it, exactly once', async () => {
    await claimCode(NEW1, patCode);
    expect((await useApp(NEW1)).status).toBe(200);
    expect(attribution(NEW1)).toMatchObject({ status: 'confirmed', promoter_id: expect.any(String) });
    expect(activation(NEW1)).toBeTruthy();
    for (let i = 0; i < 3; i++) await useApp(NEW1);
    expect(rows('SELECT * FROM app_user_activations')).toHaveLength(1);
    expect(events('confirmed')).toHaveLength(1);
    expect(await json(await claimCode(NEW1, patCode))).toEqual({ credited: true, state: 'confirmed' }); // a replay is idempotent
    expect(rows('SELECT * FROM app_referral_attributions')).toHaveLength(1);
  });

  it('confirms at once when the app already activated them moments before the claim (the first request beats the SDK)', async () => {
    await useApp(NEW1);
    expect(await json(await claimCode(NEW1, patCode))).toEqual({ credited: true, state: 'confirmed' });
    expect(attribution(NEW1)).toMatchObject({ status: 'confirmed', activated_at: (activation(NEW1) as { first_activated_at: number }).first_activated_at });
  });

  it('things that are not an activation never create one or confirm a claim', async () => {
    await claimCode(NEW1, patCode);
    const attempts: [string, Response][] = [
      ['no session', await app.request('/v1/auth/me', { headers: { 'X-PAS-App': 'shop' } }, env)],
      ['unmediated', await useApp(NEW1, { mediated: null })],
      ['a first-party session', await useApp(NEW1, { cred: credentialContext('first_party_session') })],
      ['another app\'s session', await useApp(NEW1, { cred: credentialContext('app_bound', 'other') })],
      ['an unproven session', await useApp(NEW1, { cred: null })],
      ['a machine session', await useApp(NEW1, { extra: { via: 'oidc-e2e' } })],
      ['a failed request', await inApp('GET', '/apps/shop/promoters', NEW1)],
      ['telemetry ingestion', await inApp('POST', '/apps/shop/logs', NEW1, { body: { entries: [] } })],
      ['a page of the storefront', await inApp('GET', '/storefront/promoters/apps', NEW1)],
    ];
    expect(attempts.length).toBe(9);
    expect(rows('SELECT * FROM app_user_activations')).toEqual([]);
    expect(attribution(NEW1)).toMatchObject({ status: 'pending' });
    // Issuing a token is not an activation either.
    db.sql.exec("INSERT INTO user_app_tokens (token_hash, token_id, user_id, app_id, scopes, created_at, expires_at) VALUES ('h','t','gh:10','shop','{}',1,9)");
    expect(rows('SELECT * FROM app_user_activations')).toEqual([]);
  });

  it('survives simultaneous activations and a replayed activation: one record, one confirmation', async () => {
    await claimCode(NEW1, patCode);
    await Promise.all(Array.from({ length: 18 }, () => useApp(NEW1)));
    await recordActivation(db, 'shop', NEW1);
    expect(rows('SELECT * FROM app_user_activations')).toHaveLength(1);
    expect(events('confirmed')).toHaveLength(1);
    expect(attribution(NEW1)).toMatchObject({ status: 'confirmed' });
  });

  it('an activation failure never breaks the request it observed', async () => {
    vi.spyOn(db, 'batch').mockRejectedValueOnce(new Error('d1 down'));
    expect((await useApp(NEW1)).status).toBe(200);
    vi.restoreAllMocks();
  });
});

describe('who can be credited', () => {
  it('refuses a self-referral without a credit, and audits it', async () => {
    expect(await json(await claimCode(PAT, patCode))).toEqual({ credited: false, state: 'not_eligible' });
    expect(rows('SELECT * FROM app_referral_attributions')).toEqual([]);
    expect(events('claim_rejected')).toMatchObject([{ reason: 'self_referral', attribution_id: null }]);
  });

  it('never credits someone already using the app: an earlier activation, or older records of use', async () => {
    await useApp(NEW1);
    db.sql.exec(`UPDATE app_user_activations SET first_activated_at = ${Date.now() - ACTIVATION_GRACE_MS - 60_000}`);
    expect(await json(await claimCode(NEW1, patCode))).toEqual({ credited: false, state: 'not_eligible' });
    db.sql.exec("INSERT INTO kv (app_id, user_id, key, value, value_size_bytes, updated_at) VALUES ('shop','gh:11','k',x'01',1,1)");
    expect((await json(await claimCode(NEW2, patCode))).state).toBe('not_eligible');
    db.sql.exec("INSERT INTO app_roles (app_id, user_id, role_name, granted_at) VALUES ('shop','gh:12','member',5)");
    expect((await json(await claimCode(NEW3, patCode))).state).toBe('not_eligible');
    expect(rows('SELECT * FROM app_referral_attributions')).toEqual([]);
    expect(events('claim_rejected').map((e) => e.reason)).toEqual(['existing_user', 'existing_user', 'existing_user']);
  });

  it('a recent first write by a genuinely new person does not disqualify them', async () => {
    db.sql.exec(`INSERT INTO kv (app_id, user_id, key, value, value_size_bytes, updated_at) VALUES ('shop','gh:10','k',x'01',1,${Date.now()})`);
    expect((await json(await claimCode(NEW1, patCode))).state).toBe('pending');
  });

  it('a person new to THIS app qualifies even though they already have a PAS account and other apps', async () => {
    await useApp(NEW1, { appId: 'other' });
    expect((await json(await claimCode(NEW1, patCode))).state).toBe('pending');
    await useApp(NEW1);
    expect(attribution(NEW1)).toMatchObject({ status: 'confirmed' });
  });

  it('first valid claim wins: a competing promoter changes nothing, and a replay by the first is idempotent', async () => {
    expect((await json(await claimCode(NEW1, patCode))).state).toBe('pending');
    expect(await json(await claimCode(NEW1, pruCode))).toEqual({ credited: false, state: 'already_attributed' });
    expect((await json(await claimCode(NEW1, patCode))).state).toBe('pending');
    await useApp(NEW1);
    expect(await json(await claimCode(NEW1, pruCode))).toEqual({ credited: false, state: 'already_attributed' });
    const row = attribution(NEW1) as { promoter_id: string; code: string };
    expect(row.code).toBe(patCode);
    expect(rows('SELECT * FROM app_referral_attributions')).toHaveLength(1);
  });

  it('two competing claims at the same moment still credit one promoter', async () => {
    const results = await Promise.all([claimCode(NEW1, patCode), claimCode(NEW1, pruCode), claimCode(NEW1, patCode), claimCode(NEW1, pruCode)]);
    const states = (await Promise.all(results.map(json))).map((r) => r.state);
    expect(rows('SELECT * FROM app_referral_attributions')).toHaveLength(1);
    expect(states.filter((s) => s === 'pending')).toHaveLength(2); // the winner's own replays
    expect(states.filter((s) => s === 'already_attributed')).toHaveLength(2);
  });
});

describe('codes, lifecycle and isolation', () => {
  it('answers an unknown, malformed, other-app, private-app, suspended and withdrawn code identically', async () => {
    const otherCode = (await promote(PAT, 'other')).code;
    const quietCode = ((await enroll(db, 'shop', NEW3, { consent: true, display_name: null })).promoter).code;
    db.sql.exec(`UPDATE app_promoters SET status = 'suspended' WHERE code = '${pruCode}'`);
    db.sql.exec(`UPDATE app_promoters SET status = 'withdrawn' WHERE code = '${quietCode}'`);
    const states = await Promise.all(['ABCDEFGH', 'nope', '', otherCode, pruCode, quietCode, null, 5].map(async (c) => json(await claimCode(NEW1, c))));
    expect(new Set(states.map((s) => JSON.stringify(s)))).toEqual(new Set([JSON.stringify({ credited: false, state: 'invalid_code' })]));
    expect(rows('SELECT * FROM app_referral_attributions')).toEqual([]);
    db.sql.exec("INSERT INTO app_visibility (app_id, mode, roles, created_at) VALUES ('shop','private','[]',0)");
    expect((await json(await claimCode(NEW1, patCode))).state).toBe('invalid_code');
  });

  it('a claim whose promoter is suspended before the activation expires with no credit; a confirmed credit stays', async () => {
    await claimCode(NEW1, patCode);
    db.sql.exec(`UPDATE app_promoters SET status = 'suspended' WHERE code = '${patCode}'`);
    await useApp(NEW1);
    expect(attribution(NEW1)).toMatchObject({ status: 'expired', confirmed_at: null });
    expect(events('expired')).toHaveLength(1);

    db.sql.exec(`UPDATE app_promoters SET status = 'active' WHERE code = '${patCode}'`);
    await claimCode(NEW2, patCode); await useApp(NEW2);
    db.sql.exec(`UPDATE app_promoters SET status = 'suspended' WHERE code = '${patCode}'`);
    expect(attribution(NEW2)).toMatchObject({ status: 'confirmed' });
  });

  it('a capture that never activates lapses after its lifetime, and the person can be claimed afresh', async () => {
    const t0 = Date.now();
    await claim(db, 'shop', NEW1, patCode, t0);
    expect(attribution(NEW1)).toMatchObject({ status: 'pending', expires_at: t0 + CAPTURE_TTL_MS });
    const late = t0 + CAPTURE_TTL_MS + 1000;
    await recordActivation(db, 'shop', NEW1, late);
    expect(attribution(NEW1)).toMatchObject({ status: 'expired', confirmed_at: null });
    // The activation is moments old, so a fresh claim on this person confirms at once, for the new promoter.
    expect(await claim(db, 'shop', NEW1, pruCode, late + 1)).toEqual({ credited: true, state: 'confirmed' });
    expect(attribution(NEW1)).toMatchObject({ status: 'confirmed', code: pruCode });
    expect(events('claimed').length).toBeGreaterThanOrEqual(2);
  });

  it('an unconfirmed claim past its lifetime lapses on the next claim attempt rather than blocking it', async () => {
    const t0 = Date.now();
    await claim(db, 'shop', NEW1, patCode, t0);
    const after = t0 + CAPTURE_TTL_MS + 5;
    expect(await claim(db, 'shop', NEW1, pruCode, after)).toEqual({ credited: false, state: 'pending' });
    expect(attribution(NEW1)).toMatchObject({ status: 'pending', code: pruCode });
    expect(events('expired')).toHaveLength(1);
  });

  it('keeps apps apart: a claim, an activation and a credit in one app never touch another', async () => {
    const otherCode = (await promote(PAT, 'other')).code;
    await claimCode(NEW1, patCode);
    await claimCode(NEW1, otherCode, { appId: 'other' });
    await useApp(NEW1, { appId: 'other' });
    expect(attribution(NEW1, 'other')).toMatchObject({ status: 'confirmed', code: otherCode });
    expect(attribution(NEW1, 'shop')).toMatchObject({ status: 'pending', code: patCode });
    expect((await json(await claimCode(NEW2, otherCode))).state).toBe('invalid_code'); // other app's code in shop
    await useApp(NEW1);
    expect(attribution(NEW1, 'shop')).toMatchObject({ status: 'confirmed' });
  });

  it('only a request the host mediated for this app, with a session bound to it, can capture', async () => {
    for (const opts of [{ mediated: null }, { cred: credentialContext('first_party_session') }, { cred: credentialContext('app_bound', 'other') }, { mediated: 'other' }, { cred: null }, { extra: { via: 'x' } }] as CallOpts[]) {
      expect(await json(await claimCode(NEW1, patCode, opts))).toEqual({ credited: false, state: 'unverified_origin' });
    }
    expect((await app.request('/v1/apps/shop/referrals/claim', { method: 'POST', body: '{}' }, env)).status).toBe(401);
    expect(rows('SELECT * FROM app_referral_attributions')).toEqual([]);
  });
});

describe('owner review and correction', () => {
  async function credited(uid: string, code = patCode) { await claimCode(uid, code); await useApp(uid); return (attribution(uid) as { id: string }).id; }

  it('lists attributions with counts and no invitee identity, only for the app owner', async () => {
    await credited(NEW1); await claimCode(NEW2, pruCode);
    const list = await json(await person('GET', '/apps/shop/referrals', OWNER));
    expect(list.counts).toEqual({ pending: 1, confirmed: 1, expired: 0, reversed: 0 });
    expect(list.referrals).toHaveLength(2);
    expect(JSON.stringify(list)).not.toMatch(/gh:1\d|referred_user|login/);
    expect((await json(await person('GET', '/apps/shop/referrals?status=confirmed', OWNER))).referrals).toHaveLength(1);
    expect((await json(await person('GET', `/apps/shop/referrals?promoter_id=${(await promote(PRU)).id}`, OWNER))).referrals).toHaveLength(1);
    expect((await person('GET', '/apps/shop/referrals?status=bogus', OWNER)).status).toBe(400);
    for (const uid of [PAT, NEW1, PRU]) expect((await person('GET', '/apps/shop/referrals', uid)).status).toBe(403);
    expect((await person('GET', '/apps/other/referrals', PAT)).status).toBe(403);
  });

  it('reverses and restores a credit idempotently, with the reason on the audit trail, and a reversal cannot be undone by claiming again', async () => {
    const id = await credited(NEW1);
    expect((await person('POST', `/apps/shop/referrals/${id}/reverse`, OWNER, { kind: 'bogus' })).status).toBe(400);
    const reversed = await json(await person('POST', `/apps/shop/referrals/${id}/reverse`, OWNER, { kind: 'fraud_invalid', reason: 'bought accounts' }));
    expect(reversed.referral).toMatchObject({ status: 'reversed', reversal_kind: 'fraud_invalid', reversal_reason: 'bought accounts' });
    expect((await person('POST', `/apps/shop/referrals/${id}/reverse`, OWNER, { kind: 'fraud_invalid' })).status).toBe(200); // idempotent
    expect(events().filter((e) => String(e.action).startsWith('reversed'))).toHaveLength(1);
    expect(await json(await claimCode(NEW1, pruCode))).toEqual({ credited: false, state: 'already_attributed' });
    expect(await json(await claimCode(NEW1, patCode))).toEqual({ credited: false, state: 'not_eligible' });
    expect(attribution(NEW1)).toMatchObject({ status: 'reversed', code: patCode });
    expect((await json(await person('GET', '/apps/shop/referrals', OWNER))).counts).toMatchObject({ confirmed: 0, reversed: 1 });
    const restored = await json(await person('POST', `/apps/shop/referrals/${id}/restore`, OWNER, {}));
    expect(restored.referral.status).toBe('confirmed');
    expect((await person('POST', `/apps/shop/referrals/${id}/restore`, OWNER, {})).status).toBe(200);
    const trail = await json(await person('GET', `/apps/shop/referrals/events?referral_id=${id}`, OWNER));
    expect(trail.events.map((e: { action: string }) => e.action)).toEqual(['restored', 'reversed:fraud_invalid', 'confirmed', 'claimed']);
    expect(JSON.stringify(trail)).not.toMatch(/gh:/);
  });

  it('only a confirmed credit can be reversed, only within the owner\'s own app, only by the owner', async () => {
    await claimCode(NEW1, patCode);
    const pendingId = (attribution(NEW1) as { id: string }).id;
    expect((await person('POST', `/apps/shop/referrals/${pendingId}/reverse`, OWNER, { kind: 'correction' })).status).toBe(409);
    const id = await credited(NEW2, pruCode);
    expect((await person('POST', `/apps/shop/referrals/${id}/reverse`, PAT, { kind: 'correction' })).status).toBe(403);
    expect((await person('POST', `/apps/other/referrals/${id}/reverse`, OWNER, { kind: 'correction' })).status).toBe(404);
    expect((await person('POST', '/apps/shop/referrals/no-such/reverse', OWNER, { kind: 'correction' })).status).toBe(404);
    expect((await person('POST', `/apps/shop/referrals/${pendingId}/restore`, OWNER, {})).status).toBe(409); // nothing was reversed
    expect((await person('POST', `/apps/shop/referrals/${id}/restore`, OWNER, {})).status).toBe(200); // already confirmed: idempotent
    expect((await json(await person('GET', '/apps/shop/referrals/events', OWNER))).events.length).toBeGreaterThan(0);
    expect(() => db.sql.exec("UPDATE app_referral_events SET reason = 'x'")).toThrow(/append-only/);
  });
});

describe('what a promoter sees', () => {
  it('their own pending and confirmed referrals, never anyone\'s identity or another promoter\'s data', async () => {
    await claimCode(NEW1, patCode); await useApp(NEW1); await claimCode(NEW2, patCode); await claimCode(NEW3, pruCode); await useApp(NEW3);
    const mine = await json(await person('GET', '/apps/shop/promoters/me/referrals', PAT));
    expect(mine).toMatchObject({ promoter_status: 'active', counts: { pending: 1, confirmed: 1 } });
    expect(mine.referrals).toHaveLength(2);
    expect(JSON.stringify(mine)).not.toMatch(/gh:|referred_user|promoter_id|login/);
    expect((await json(await person('GET', '/apps/shop/promoters/me/referrals', PRU))).counts).toEqual({ pending: 0, confirmed: 1 });
    expect((await person('GET', '/apps/shop/promoters/me/referrals', NEW1)).status).toBe(404); // not a promoter
    expect((await inApp('GET', '/apps/shop/promoters/me/referrals', PAT)).status).toBe(403); // an app-bound session is not the person
  });
});

describe('erasure, transfer and deletion', () => {
  it('drops an erased person\'s unconfirmed claim, keeps a confirmed credit as an anonymous count, and refuses them after', async () => {
    await claimCode(NEW1, patCode); await useApp(NEW1);
    await claimCode(NEW2, patCode);
    db.sql.exec("INSERT INTO per_app_deleted_users (app_id, user_id, deleted_by, deleted_at) VALUES ('shop','gh:10','gh:10',99),('shop','gh:11','gh:11',99)");
    expect(attribution(NEW2)).toBeUndefined();
    expect(attribution(NEW1)).toBeUndefined();
    const kept = one("SELECT status, referred_user_id FROM app_referral_attributions WHERE status = 'confirmed'") as { status: string; referred_user_id: string };
    expect(kept.referred_user_id).toMatch(/^erased:/);
    expect(activation(NEW1)).toBeUndefined();
    expect(events('erased')).toHaveLength(2);
    expect((await json(await claimCode(NEW1, patCode))).state).toBe('not_eligible');
    expect((await json(await person('GET', '/apps/shop/referrals', OWNER))).counts.confirmed).toBe(1);
  });

  it('survives an ownership transfer, with review passing to the new owner, and goes with a deleted app', async () => {
    await claimCode(NEW1, patCode); await useApp(NEW1);
    db.sql.exec("UPDATE apps SET creator_id = 'gh:3' WHERE id = 'shop'; DELETE FROM team_members WHERE app_id = 'shop' AND user_id = 'gh:1'; INSERT INTO team_members (app_id, user_id, role, created_at) VALUES ('shop','gh:3','owner',1)");
    expect((await person('GET', '/apps/shop/referrals', OWNER)).status).toBe(403);
    expect((await json(await person('GET', '/apps/shop/referrals', PRU))).counts.confirmed).toBe(1);
    db.sql.exec("DELETE FROM apps WHERE id = 'shop'");
    expect(rows('SELECT * FROM app_referral_attributions')).toEqual([]);
    expect(rows('SELECT * FROM app_user_activations')).toEqual([]);
    expect(events('confirmed')).toHaveLength(1); // the audit record outlives the app
  });
});
