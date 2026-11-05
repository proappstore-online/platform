import { beforeEach, describe, expect, it } from 'vitest';
import { credentialContext, mintSession } from '@proappstore/build-core';
import { app } from '../index.js';
import { sqliteD1 } from '../sqlite-d1.js';
import { makeEnv } from '../test-helpers.js';
import type { Env } from '../types.js';
import { enroll } from '../lib/promoters/service.js';
import { getShareAmongPromoters, parsePeriod } from '../lib/referrals/contributions.js';

// #551 on real SQL (every migration applied): promoter contribution totals, shares, standings and public cards.
// Credits are seeded directly with exact timestamps so boundaries, ties and denominators are deterministic.

let db: ReturnType<typeof sqliteD1>;
let env: Env;
const OWNER = 'gh:1', PAT = 'gh:2', PRU = 'gh:3', CAR = 'gh:4', BOB = 'gh:5';
const T = Date.UTC(2026, 9, 1); // 2026-10-01T00:00:00Z
const DAY = 86_400_000;
const sign = (uid: string, cred: ReturnType<typeof credentialContext> | null) =>
  mintSession({ uid, roles: ['user'], auth_time: Math.floor(Date.now() / 1000), auth_method: 'google', ...(cred ? { cred } : {}) }, env.SESSION_SIGNING_KEY);
const call = async (method: string, path: string, uid: string | null, body?: unknown, cred: ReturnType<typeof credentialContext> | null = credentialContext('first_party_session')) => app.request(`/v1${path}`, {
  method, headers: { ...(uid ? { Authorization: `Bearer ${await sign(uid, cred)}` } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
}, env);
const json = async <T = Record<string, any>>(r: Response) => (await r.json()) as T;
const rows = (sql: string, ...args: unknown[]) => db.sql.prepare(sql).all(...(args as never[]));
const promote = async (uid: string, appId = 'shop') => (await enroll(db, appId, uid, { consent: true, display_name: null })).promoter;

let n = 0;
/** One attribution row with exact timestamps. Pending/expired are placed by captured_at, confirmed/reversed by confirmed_at. */
function credit(promoterId: string, status: 'pending' | 'confirmed' | 'reversed' | 'expired', at: number, appId = 'shop') {
  const id = `r${++n}`;
  const settled = status === 'confirmed' || status === 'reversed';
  db.sql.prepare(`INSERT INTO app_referral_attributions (id, app_id, referred_user_id, promoter_id, code, status, captured_at, expires_at, activated_at, confirmed_at, created_at, updated_at)
    VALUES (?, ?, ?, ?, 'CODE2222', ?, ?, ?, ?, ?, ?, ?)`).run(id, appId, `gh:${1000 + n}`, promoterId, status, at, at + 1e10, settled ? at : null, settled ? at : null, at, at);
  return id;
}
const range = (from: number | string, to: number | string) => `from=${from}&to=${to}`;
const mine = async (uid: string, query = '', appId = 'shop') => json(await call('GET', `/apps/${appId}/promoters/me/contributions${query ? `?${query}` : ''}`, uid));
const standings = async (query = '', uid = OWNER, appId = 'shop') => json(await call('GET', `/apps/${appId}/promoters/contributions${query ? `?${query}` : ''}`, uid));
let pat: Awaited<ReturnType<typeof promote>>, pru: Awaited<ReturnType<typeof promote>>, car: Awaited<ReturnType<typeof promote>>;

beforeEach(async () => {
  n = 0;
  db = sqliteD1();
  db.sql.exec(`PRAGMA foreign_keys = ON;
    INSERT INTO users (id, provider, provider_id, login, created_at, last_login_at) VALUES
      ('gh:1','github','1','owner',0,0),('gh:2','google','2','pat',0,0),('gh:3','google','3','pru',0,0),('gh:4','google','4','car',0,0),('gh:5','github','5','bob',0,0);
    INSERT INTO apps (id, creator_id, created_at) VALUES ('shop','gh:1',1),('other','gh:5',2),('quiet','gh:1',3);
    INSERT INTO team_members (app_id, user_id, role, created_at) VALUES ('shop','gh:1','owner',0),('other','gh:5','owner',0);
    INSERT INTO app_visibility (app_id, mode, roles, created_at) VALUES ('quiet','private','[]',0);`);
  env = makeEnv({ DB: db }) as Env;
  [pat, pru, car] = [await promote(PAT), await promote(PRU), await promote(CAR)] as [typeof pat, typeof pat, typeof pat];
});

describe('period parsing', () => {
  it('accepts ISO dates, zoned date-times and epoch milliseconds, and refuses everything else', () => {
    expect(parsePeriod({ from: '2026-10-01', to: '2026-10-02' })).toEqual({ from: T, to: T + DAY });
    expect(parsePeriod({ from: '2026-10-01T10:00:00+10:00' })).toEqual({ from: T, to: null });
    expect(parsePeriod({ from: String(T), to: String(T + 5) })).toEqual({ from: T, to: T + 5 });
    expect(parsePeriod({})).toEqual({ from: null, to: null });
    for (const bad of ['yesterday', '2026-13-45', '2026-10-01T10:00:00', '1e9', '-5', '0x10']) expect(() => parsePeriod({ from: bad })).toThrow(/ISO date/);
    expect(() => parsePeriod({ from: String(T), to: String(T) })).toThrow(/before/);
    expect(() => parsePeriod({ from: String(T + 1), to: String(T) })).toThrow(/before/);
  });

  it('is rejected at the routes with a 400', async () => {
    expect((await call('GET', '/apps/shop/promoters/me/contributions?from=nope', PAT)).status).toBe(400);
    expect((await call('GET', `/apps/shop/promoters/contributions?${range(T + 1, T)}`, OWNER)).status).toBe(400);
  });
});

describe('own contribution: exact totals and share (#551)', () => {
  it('counts each state exactly, and the share is this promoter\'s confirmed over all promoters\' confirmed', async () => {
    for (let i = 0; i < 3; i++) credit(pat.id, 'confirmed', T + i);
    credit(pat.id, 'pending', T + 5); credit(pat.id, 'expired', T + 6); credit(pat.id, 'reversed', T + 7);
    for (let i = 0; i < 6; i++) credit(pru.id, 'confirmed', T + 10 + i);
    credit(car.id, 'confirmed', T + 20); credit(car.id, 'reversed', T + 21);
    const out = await mine(PAT);
    expect(out.version).toBe(1);
    expect(out.contributions.promotion).toMatchObject({
      type: 'promotion_marketing', recorded: true, first_confirmed_at: T, promoter_status: 'active',
      counts: { pending: 1, confirmed: 3, reversed: 1, expired: 1 },
      share_of_referred_users: { numerator: 3, denominator: 10, ratio: 0.3, percent: 30 },
      standing: { rank: 2, ranked_promoters: 3, tied_on_count: false },
    });
    expect(out.contributions.promotion.share_of_referred_users.basis).toMatch(/not a share of all users/);
    expect((await mine(PRU)).contributions.promotion.share_of_referred_users).toMatchObject({ numerator: 6, denominator: 10, percent: 60 });
    expect((await mine(CAR)).contributions.promotion.share_of_referred_users).toMatchObject({ numerator: 1, denominator: 10, percent: 10 });
  });

  it('uses a half-open period: from is included, to is excluded, in epoch ms and in ISO dates alike', async () => {
    const F = T, E = T + DAY;
    credit(pat.id, 'confirmed', F - 1); credit(pat.id, 'confirmed', F); credit(pat.id, 'confirmed', E - 1); credit(pat.id, 'confirmed', E);
    credit(pru.id, 'confirmed', F); credit(pru.id, 'confirmed', E);
    for (const query of [range(F, E), 'from=2026-10-01&to=2026-10-02']) {
      expect((await mine(PAT, query)).contributions.promotion).toMatchObject({ counts: { confirmed: 2 }, share_of_referred_users: { numerator: 2, denominator: 3 } });
    }
    expect((await mine(PAT, `from=${F}`)).contributions.promotion.counts.confirmed).toBe(3);
    expect((await mine(PAT, `to=${E}`)).contributions.promotion.counts.confirmed).toBe(3);
    expect((await mine(PAT)).contributions.promotion.counts.confirmed).toBe(4);
    expect((await mine(PAT, range(E + 5, E + DAY))).contributions.promotion.counts.confirmed).toBe(0);
  });

  it('places pending and expired credits by capture time, confirmed and reversed by confirmation time', async () => {
    credit(pat.id, 'pending', T - 5); credit(pat.id, 'expired', T - 5); credit(pat.id, 'pending', T + 5);
    db.sql.exec(`INSERT INTO app_referral_attributions (id, app_id, referred_user_id, promoter_id, code, status, captured_at, expires_at, activated_at, confirmed_at, created_at, updated_at)
      VALUES ('late','shop','gh:9001','${pat.id}','C','confirmed',${T - 100},${T + 1e10},${T + 50},${T + 50},1,1)`);
    const counts = (await mine(PAT, range(T, T + DAY))).contributions.promotion.counts;
    expect(counts).toEqual({ pending: 1, confirmed: 1, reversed: 0, expired: 0 }); // captured before the period, but confirmed in it
  });

  it('is empty, not an error, for a promoter with no referrals: zeros, a 0% share, no rank', async () => {
    const out = await mine(CAR);
    expect(out.contributions.promotion).toMatchObject({
      recorded: false, first_confirmed_at: null, counts: { pending: 0, confirmed: 0, reversed: 0, expired: 0 },
      share_of_referred_users: { numerator: 0, denominator: 0, ratio: 0, percent: 0 }, standing: { rank: null, ranked_promoters: 0 },
    });
    expect(JSON.stringify(out)).not.toMatch(/NaN|Infinity|null,"ratio"/);
    expect(await getShareAmongPromoters(db as unknown as D1Database, 'shop', CAR, { from: null, to: null })).toMatchObject({ ratio: 0, percent: 0, denominator: 0 });
  });

  it('shares of all promoters sum to the whole, and a lone promoter holds all of it', async () => {
    for (let i = 0; i < 7; i++) credit(pat.id, 'confirmed', T + i);
    expect((await mine(PAT)).contributions.promotion.share_of_referred_users).toMatchObject({ ratio: 1, percent: 100 });
    credit(pru.id, 'confirmed', T + 50); credit(pru.id, 'confirmed', T + 51); credit(car.id, 'confirmed', T + 52);
    const percents = await Promise.all([PAT, PRU, CAR].map(async (u) => (await mine(u)).contributions.promotion.share_of_referred_users.ratio));
    expect(percents.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 5);
  });

  it('reports Code as not available and never combines it with promotion into one figure', async () => {
    credit(pat.id, 'confirmed', T);
    const out = await mine(PAT);
    expect(out.contributions.code).toEqual({ type: 'code', label: 'Code', available: false, reason: expect.stringContaining('#547') });
    const text = JSON.stringify(out);
    expect(text).not.toMatch(/"score"|"overall"|"combined"|"total_percent"|"lines"|"loc"/i);
    expect(Object.keys(out.contributions).sort()).toEqual(['code', 'promotion']);
    expect(out.freshness).toMatchObject({ as_of: expect.any(Number), note: expect.stringContaining('not reconstructed') });
  });
});

describe('owner standings: ranks, ties, cursors, organic bucket', () => {
  it('ranks by confirmed, then earliest first confirmation, then promoter id, and flags ties', async () => {
    credit(pat.id, 'confirmed', T + 100); credit(pat.id, 'confirmed', T + 200);
    credit(pru.id, 'confirmed', T + 50); credit(pru.id, 'confirmed', T + 300);
    credit(car.id, 'confirmed', T + 400);
    const out = await standings();
    expect(out.standings.map((s: { promoter_id: string; rank: number }) => [s.promoter_id, s.rank])).toEqual([[pru.id, 1], [pat.id, 2], [car.id, 3]]);
    expect(out.standings.map((s: { tied_on_count: boolean }) => s.tied_on_count)).toEqual([true, true, false]);
    expect(out.totals).toMatchObject({ confirmed: 5, promoters: 3, ranked_promoters: 3 });
  });

  it('breaks an exact tie by promoter id, and lists unranked (zero) promoters last with no rank', async () => {
    credit(pat.id, 'confirmed', T); credit(pru.id, 'confirmed', T);
    const out = await standings();
    const ids = out.standings.map((s: { promoter_id: string }) => s.promoter_id);
    const tied = [pat.id, pru.id].sort();
    expect(ids.slice(0, 2)).toEqual(tied);
    expect(out.standings.map((s: { rank: number | null }) => s.rank)).toEqual([1, 2, null]);
    expect(ids[2]).toBe(car.id);
    expect(out.standings[2].share_of_referred_users).toMatchObject({ numerator: 0, denominator: 2, percent: 0 });
  });

  it('pages through ties and unranked promoters with a stable cursor: no skip, no repeat', async () => {
    for (const p of [pat, pru, car]) { credit(p.id, 'confirmed', T); }
    for (let i = 0; i < 4; i++) { const extra = await enroll(db, 'shop', `gh:${200 + i}`, { consent: true, display_name: null }).catch(() => null); void extra; }
    const full = (await standings('limit=100')).standings.map((s: { promoter_id: string }) => s.promoter_id);
    const seen: string[] = []; let after = '';
    for (let guard = 0; guard < 10; guard++) {
      const page = await standings(`limit=1${after}`);
      seen.push(...page.standings.map((s: { promoter_id: string }) => s.promoter_id));
      if (!page.next) break;
      after = `&after_id=${page.next.after_id}`;
    }
    expect(seen).toEqual(full);
    expect(new Set(seen).size).toBe(seen.length);
    expect((await call('GET', '/apps/shop/promoters/contributions?after_id=nope', OWNER)).status).toBe(400);
  });

  it('keeps organic users in their own bucket, never in a promoter\'s number', async () => {
    db.sql.exec("INSERT INTO users (id, provider, provider_id, login, created_at, last_login_at) VALUES ('gh:20','google','20','a',0,0),('gh:21','google','21','b',0,0),('gh:22','google','22','c',0,0),('gh:23','google','23','d',0,0)");
    const act = (uid: string, at: number) => db.sql.prepare("INSERT INTO app_user_activations (app_id, user_id, first_activated_at) VALUES ('shop', ?, ?)").run(uid, at);
    act('gh:20', T + 1); act('gh:21', T + 2); act('gh:22', T + 3); act('gh:23', T + 4);
    db.sql.exec(`INSERT INTO app_referral_attributions (id, app_id, referred_user_id, promoter_id, code, status, captured_at, expires_at, activated_at, confirmed_at, created_at, updated_at) VALUES
      ('a1','shop','gh:20','${pat.id}','C','confirmed',1,9e15,${T + 1},${T + 1},1,1),('a2','shop','gh:21','${pru.id}','C','reversed',1,9e15,${T + 2},${T + 2},1,1),('a3','shop','gh:22','${pat.id}','C','pending',1,9e15,NULL,NULL,1,1)`);
    const out = await standings();
    expect(out.acquisition).toMatchObject({ activations_recorded: 4, referred_confirmed: 1, referred_reversed: 1, organic: 2 });
    expect(out.totals.confirmed).toBe(1);
    expect(out.freshness.referrals_recorded_since).toBe(T + 1);
    // Promoters never see the organic bucket or app-wide acquisition.
    expect(JSON.stringify(await mine(PAT))).not.toMatch(/organic|acquisition|activations_recorded/);
  });

  it('is all-organic safe: no promoter credits means zero totals, zero shares and no division error', async () => {
    db.sql.exec("INSERT INTO users (id, provider, provider_id, login, created_at, last_login_at) VALUES ('gh:20','google','20','a',0,0)");
    db.sql.exec(`INSERT INTO app_user_activations (app_id, user_id, first_activated_at) VALUES ('shop','gh:20',${T})`);
    const out = await standings();
    expect(out.totals).toMatchObject({ confirmed: 0, pending: 0, reversed: 0, ranked_promoters: 0 });
    expect(out.acquisition).toMatchObject({ activations_recorded: 1, organic: 1, referred_confirmed: 0 });
    for (const s of out.standings) expect(s.share_of_referred_users).toMatchObject({ ratio: 0, percent: 0 });
    expect(JSON.stringify(out)).not.toMatch(/NaN|Infinity/);
  });

  it('works for an app with no promoters at all', async () => {
    const out = await standings('', BOB, 'other');
    expect(out.standings).toEqual([]);
    expect(out.totals).toMatchObject({ confirmed: 0, promoters: 0 });
    expect(out.next).toBeNull();
  });
});

describe('reversals and corrections refresh every view consistently', () => {
  it('a reversal moves one credit from confirmed to reversed everywhere, and a restore puts it back', async () => {
    const ids = [credit(pat.id, 'confirmed', T), credit(pat.id, 'confirmed', T + 1), credit(pru.id, 'confirmed', T + 2), credit(pru.id, 'confirmed', T + 3)];
    expect((await mine(PAT)).contributions.promotion.share_of_referred_users).toMatchObject({ numerator: 2, denominator: 4, percent: 50 });
    const reversed = await call('POST', `/apps/shop/referrals/${ids[0]}/reverse`, OWNER, { kind: 'fraud_invalid', reason: 'bought' });
    expect(reversed.status).toBe(200);
    expect((await call('POST', `/apps/shop/referrals/${ids[0]}/reverse`, OWNER, { kind: 'fraud_invalid' })).status).toBe(200); // idempotent
    let own = (await mine(PAT)).contributions.promotion;
    expect(own.counts).toMatchObject({ confirmed: 1, reversed: 1 });
    expect(own.share_of_referred_users).toMatchObject({ numerator: 1, denominator: 3 });
    expect((await mine(PRU)).contributions.promotion.share_of_referred_users).toMatchObject({ numerator: 2, denominator: 3 });
    const owner = await standings();
    expect(owner.totals).toMatchObject({ confirmed: 3, reversed: 1 });
    expect(rows("SELECT * FROM app_referral_events WHERE action LIKE 'reversed:%'")).toHaveLength(1); // auditable, once
    await call('POST', `/apps/shop/referrals/${ids[0]}/restore`, OWNER, {});
    own = (await mine(PAT)).contributions.promotion;
    expect(own.counts).toMatchObject({ confirmed: 2, reversed: 0 });
    expect(own.share_of_referred_users).toMatchObject({ numerator: 2, denominator: 4 });
  });

  it('reversing someone\'s only credit removes their recorded contribution and rank', async () => {
    const id = credit(car.id, 'confirmed', T);
    expect((await mine(CAR)).contributions.promotion).toMatchObject({ recorded: true, standing: { rank: 1 } });
    await call('POST', `/apps/shop/referrals/${id}/reverse`, OWNER, { kind: 'correction' });
    expect((await mine(CAR)).contributions.promotion).toMatchObject({ recorded: false, first_confirmed_at: null, standing: { rank: null }, counts: { confirmed: 0, reversed: 1 } });
  });
});

describe('who can read what', () => {
  it('a promoter reads only their own record and cannot see owner standings, other promoters or acquisition', async () => {
    credit(pat.id, 'confirmed', T); credit(pru.id, 'confirmed', T + 1);
    const out = await mine(PAT);
    const text = JSON.stringify(out);
    expect(text).not.toContain(pru.id);
    expect(text).not.toMatch(/gh:|referred_user_id|"display_name"|"standings"|"promoters"/);
    expect((await call('GET', '/apps/shop/promoters/contributions', PAT)).status).toBe(403);
    expect((await call('GET', '/apps/shop/promoters/contributions', PRU)).status).toBe(403);
  });

  it('refuses anyone who is not the person: no promoter, no session, an app-bound or unproven credential, or another app\'s owner', async () => {
    credit(pat.id, 'confirmed', T);
    expect((await call('GET', '/apps/shop/promoters/me/contributions', BOB)).status).toBe(404); // not a promoter here
    expect((await call('GET', '/apps/shop/promoters/me/contributions', null)).status).toBe(401);
    expect((await call('GET', '/apps/shop/promoters/me/contributions', PAT, undefined, credentialContext('app_bound', 'shop'))).status).toBe(403);
    expect((await call('GET', '/apps/shop/promoters/me/contributions', PAT, undefined, null)).status).toBe(403);
    expect((await call('GET', '/apps/shop/promoters/contributions', BOB)).status).toBe(403);
    expect((await call('GET', '/apps/shop/promoters/contributions', null)).status).toBe(401);
    expect((await call('GET', '/apps/other/promoters/contributions', OWNER)).status).toBe(403);
  });

  it('keeps apps apart: another app\'s credits and promoters never enter this app\'s numbers', async () => {
    const elsewhere = await promote(PAT, 'other');
    for (let i = 0; i < 5; i++) credit(elsewhere.id, 'confirmed', T + i, 'other');
    credit(pat.id, 'confirmed', T);
    expect((await mine(PAT)).contributions.promotion.share_of_referred_users).toMatchObject({ numerator: 1, denominator: 1 });
    expect((await mine(PAT, '', 'other')).contributions.promotion.share_of_referred_users).toMatchObject({ numerator: 5, denominator: 5 });
    expect((await standings('', BOB, 'other')).totals.confirmed).toBe(5);
    expect((await standings()).totals.confirmed).toBe(1);
  });
});

describe('suspension, withdrawal, transfer, deletion, erasure', () => {
  it('a suspended promoter still reads their record, and their valid credits still count for everyone', async () => {
    credit(pat.id, 'confirmed', T); credit(pru.id, 'confirmed', T + 1);
    db.sql.exec(`UPDATE app_promoters SET status = 'suspended' WHERE id = '${pat.id}'`);
    const out = await mine(PAT);
    expect(out.contributions.promotion).toMatchObject({ promoter_status: 'suspended', counts: { confirmed: 1 }, share_of_referred_users: { numerator: 1, denominator: 2 } });
    expect((await mine(PRU)).contributions.promotion.share_of_referred_users).toMatchObject({ numerator: 1, denominator: 2 });
    expect((await standings()).standings.find((s: { promoter_id: string }) => s.promoter_id === pat.id)).toMatchObject({ status: 'suspended', counts: { confirmed: 1 } });
  });

  it('a withdrawn promoter keeps their history and their credits remain valid provenance', async () => {
    credit(pat.id, 'confirmed', T);
    expect((await call('POST', '/apps/shop/promoters/me/withdraw', PAT, {})).status).toBe(200);
    expect((await mine(PAT)).contributions.promotion).toMatchObject({ promoter_status: 'withdrawn', counts: { confirmed: 1 }, recorded: true });
    expect((await standings()).totals.confirmed).toBe(1);
  });

  it('survives an ownership transfer, with owner reads passing to the new owner, and goes with a deleted app', async () => {
    credit(pat.id, 'confirmed', T);
    db.sql.exec("UPDATE apps SET creator_id = 'gh:5' WHERE id = 'shop'; DELETE FROM team_members WHERE app_id = 'shop' AND user_id = 'gh:1'; INSERT INTO team_members (app_id, user_id, role, created_at) VALUES ('shop','gh:5','owner',1)");
    expect((await call('GET', '/apps/shop/promoters/contributions', OWNER)).status).toBe(403);
    expect((await standings('', BOB)).totals.confirmed).toBe(1);
    expect((await mine(PAT)).contributions.promotion.counts.confirmed).toBe(1);
    db.sql.exec("DELETE FROM apps WHERE id = 'shop'");
    expect(rows('SELECT * FROM app_referral_attributions')).toEqual([]);
  });

  it('an erased referred person\'s confirmed credit stays counted, anonymously, and drops out of the activation bucket', async () => {
    db.sql.exec("INSERT INTO users (id, provider, provider_id, login, created_at, last_login_at) VALUES ('gh:20','google','20','a',0,0)");
    db.sql.exec(`INSERT INTO app_user_activations (app_id, user_id, first_activated_at) VALUES ('shop','gh:20',${T});
      INSERT INTO app_referral_attributions (id, app_id, referred_user_id, promoter_id, code, status, captured_at, expires_at, activated_at, confirmed_at, created_at, updated_at) VALUES ('e1','shop','gh:20','${pat.id}','C','confirmed',1,9e15,${T},${T},1,1)`);
    db.sql.exec("INSERT INTO per_app_deleted_users (app_id, user_id, deleted_by, deleted_at) VALUES ('shop','gh:20','gh:20',99)");
    const out = await standings();
    expect(out.totals.confirmed).toBe(1);
    expect(out.acquisition).toMatchObject({ activations_recorded: 0, organic: 0 });
    expect(JSON.stringify(out)).not.toContain('gh:20');
  });
});

describe('public contributor cards (#541/#542 opt-in)', () => {
  const optIn = (uid: string, extra: Record<string, unknown> = {}) => call('PUT', '/apps/shop/team/public/me', uid, { display_name: 'Pat P.', label: 'Promoter', visible: true, show_promotion: true, ...extra });
  const card = (id: string, query = '', appId = 'shop') => app.request(`/v1/apps/${appId}/promoters/${id}/public-card${query ? `?${query}` : ''}`, {}, env);
  const list = async (appId = 'shop') => app.request(`/v1/storefront/apps/${appId}/contributors`, {}, env);

  it('shows an opted-in active promoter with a confirmed referral, and only the public-safe fields', async () => {
    expect((await optIn(PAT)).status).toBe(200); // a promoter who is not on the team can opt in
    expect((await card(pat.id)).status).toBe(404); // no confirmed referral yet: nothing recorded to recognise
    credit(pat.id, 'confirmed', T); credit(pat.id, 'confirmed', T + 1); credit(pru.id, 'confirmed', T + 2);
    credit(pat.id, 'pending', T + 3); credit(pat.id, 'reversed', T + 4);
    const res = await card(pat.id);
    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe('public, max-age=60');
    const out = await json(res);
    expect(out).toMatchObject({
      display_name: 'Pat P.', label: 'Promoter',
      contributions: { promotion: { type: 'promotion_marketing', recorded: true, confirmed_referrals: 2, share_of_referred_users: { numerator: 2, denominator: 3, percent: 66.67 } }, code: { available: false } },
    });
    const text = JSON.stringify(out);
    expect(text).not.toMatch(/gh:|@|pending|reversed|expired|"user_id"|promoter_id|invitee|referred_user_id|"code":"/);
    expect(Object.keys(out.contributions.promotion).sort()).toEqual(['confirmed_referrals', 'label', 'recorded', 'share_of_referred_users', 'type']);
    expect((await json(await app.request('/v1/storefront/apps/shop/team', {}, env))).members).toEqual([]); // the team list is unchanged
  });

  it('applies the period to the card', async () => {
    await optIn(PAT);
    credit(pat.id, 'confirmed', T); credit(pat.id, 'confirmed', T + DAY * 2); credit(pru.id, 'confirmed', T + 5);
    expect((await json(await card(pat.id, range(T, T + DAY)))).contributions.promotion).toMatchObject({ confirmed_referrals: 1, share_of_referred_users: { numerator: 1, denominator: 2 } });
    expect((await card(pat.id, 'from=nope')).status).toBe(400);
  });

  it('is off until the person opts in, and every way of opting out removes it', async () => {
    credit(pat.id, 'confirmed', T);
    expect((await card(pat.id)).status).toBe(404);
    await call('PUT', '/apps/shop/team/public/me', PAT, { display_name: 'Pat P.', visible: true }); // a name, but no promotion
    expect((await card(pat.id)).status).toBe(404);
    await optIn(PAT); expect((await card(pat.id)).status).toBe(200);
    await optIn(PAT, { show_promotion: false }); expect((await card(pat.id)).status).toBe(404);
    await optIn(PAT); expect((await card(pat.id)).status).toBe(200);
    await optIn(PAT, { visible: false, show_promotion: false }); expect((await card(pat.id)).status).toBe(404);
    await optIn(PAT); expect((await card(pat.id)).status).toBe(200);
    expect((await call('DELETE', '/apps/shop/team/public/me', PAT)).status).toBe(200); // withdrawal
    expect((await card(pat.id)).status).toBe(404);
    expect(rows("SELECT show_promotion FROM app_team_public_profiles WHERE user_id = 'gh:2'")).toEqual([{ show_promotion: 0 }]);
  });

  it('only an active promoter can show a promotion, and it needs a visible profile', async () => {
    const stranger = await call('PUT', '/apps/shop/team/public/me', BOB, { display_name: 'Bob', visible: true, show_promotion: true });
    expect([stranger.status, await stranger.text()]).toEqual([400, 'not_an_active_promoter']); // not a promoter, so there is no promotion to show
    expect((await call('PUT', '/apps/shop/team/public/me', BOB, { display_name: 'Bob', visible: true })).status).toBe(403); // and not on the team either
    db.sql.exec("INSERT INTO team_members (app_id, user_id, role, created_at) VALUES ('shop','gh:5','developer',1)");
    const member = await call('PUT', '/apps/shop/team/public/me', BOB, { display_name: 'Bob', visible: true, show_promotion: true });
    expect([member.status, await member.text()]).toEqual([400, 'not_an_active_promoter']);
    expect((await optIn(PAT, { visible: false })).status).toBe(400);
    expect((await optIn(PAT, { show_promotion: 'yes' })).status).toBe(400);
    expect((await call('PUT', '/apps/shop/team/public/me', BOB, { display_name: 'Bob', visible: true })).status).toBe(200); // a plain team profile still works
  });

  it('hides while suspended and returns when lifted; withdrawal removes it for good, re-enrolling does not revive it', async () => {
    credit(pat.id, 'confirmed', T); await optIn(PAT);
    expect((await card(pat.id)).status).toBe(200);
    db.sql.exec(`UPDATE app_promoters SET status = 'suspended' WHERE id = '${pat.id}'`);
    expect((await card(pat.id)).status).toBe(404);
    db.sql.exec(`UPDATE app_promoters SET status = 'active' WHERE id = '${pat.id}'`);
    expect((await card(pat.id)).status).toBe(200);
    expect((await call('POST', '/apps/shop/promoters/me/withdraw', PAT, {})).status).toBe(200);
    expect((await card(pat.id)).status).toBe(404);
    expect((await call('POST', '/apps/shop/promoters/enroll', PAT, { consent: true })).status).toBe(200); // back as a promoter
    expect((await card(pat.id)).status).toBe(404); // but the card is not revived
    await optIn(PAT);
    expect((await card(pat.id)).status).toBe(200); // only a fresh choice brings it back
  });

  it('is the same 404 for a private or missing app, an unknown, other-app or non-active promoter', async () => {
    credit(pat.id, 'confirmed', T); await optIn(PAT);
    const elsewhere = await promote(PAT, 'other');
    const bodies = await Promise.all([card('nope'), card(elsewhere.id), card(pat.id, '', 'other'), card(pat.id, '', 'nope'), card(pat.id, '', 'quiet')].map(async (p) => { const r = await p; return [r.status, await r.text()]; }));
    expect(new Set(bodies.map((b) => JSON.stringify(b)))).toEqual(new Set([JSON.stringify([404, 'not found'])]));
    db.sql.exec("INSERT INTO app_visibility (app_id, mode, roles, created_at) VALUES ('shop','private','[]',0)");
    expect((await card(pat.id)).status).toBe(404);
    expect((await list()).status).toBe(404);
  });

  it('a publisher transfer withdraws the old and new publisher\'s card until they choose again', async () => {
    const owner = await promote(OWNER);
    credit(owner.id, 'confirmed', T); await optIn(OWNER);
    expect((await card(owner.id)).status).toBe(200);
    db.sql.exec("UPDATE apps SET creator_id = 'gh:5' WHERE id = 'shop'");
    expect((await card(owner.id)).status).toBe(404);
  });

  it('lists the opted-in contributors in standings order, and nobody else', async () => {
    for (let i = 0; i < 3; i++) credit(pru.id, 'confirmed', T + i);
    credit(pat.id, 'confirmed', T + 10);
    credit(car.id, 'confirmed', T + 11);
    await optIn(PAT); await optIn(PRU, { display_name: 'Pru R.' });
    const out = await json(await list());
    expect(out.contributors.map((c: { display_name: string }) => c.display_name)).toEqual(['Pru R.', 'Pat P.']); // Carol did not opt in
    expect(out.contributors[0].contributions.promotion).toMatchObject({ confirmed_referrals: 3, share_of_referred_users: { numerator: 3, denominator: 5 } });
    expect(JSON.stringify(out)).not.toMatch(/gh:|@|promoter_id|user_id/);
  });

  it('gives a shared person a promotion section and no invented code section', async () => {
    const owner = await promote(OWNER); credit(owner.id, 'confirmed', T); await optIn(OWNER);
    const out = await json(await card(owner.id));
    expect(out.contributions.code).toEqual({ type: 'code', available: false });
    expect(out.contributions.promotion.confirmed_referrals).toBe(1);
    expect(JSON.stringify(out)).not.toMatch(/"lines|"loc"|score|combined/i);
  });
});
