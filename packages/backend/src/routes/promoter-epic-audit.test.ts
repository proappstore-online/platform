import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { credentialContext, mintSession } from '@proappstore/build-core';
import { app } from '../index.js';
import { sqliteD1 } from '../sqlite-d1.js';
import { makeEnv } from '../test-helpers.js';
import type { Env } from '../types.js';
import { enroll } from '../lib/promoters/service.js';
import { claim, recordActivation } from '../lib/referrals/service.js';
import { commit, FakeGitHub } from '../lib/contributions/fake-github.js';
import { refreshProject } from '../lib/contributions/ingest.js';

// Audit of the platform contracts (#549, #550, #551) against the nine points of the product contract in epic #548.
// These tests pin what the earlier per-issue suites do not: no money anywhere (point 9), no backfill (5), invitee
// privacy and code/referral separation across every view (7), and two lifecycle edges of capture (5).

let db: ReturnType<typeof sqliteD1>;
let env: Env;
const OWNER = 'gh:1', PAT = 'gh:2', PRU = 'gh:3', NEW1 = 'gh:10', NEW2 = 'gh:11';
const INVITEE_LOGIN = 'invitee-secret-login', INVITEE_EMAIL = 'invitee-secret@example.invalid';
const root = join(import.meta.dirname, '../../../..');

const sign = (uid: string, cred: ReturnType<typeof credentialContext>) =>
  mintSession({ uid, roles: ['user'], auth_time: Math.floor(Date.now() / 1000), auth_method: 'google', cred }, env.SESSION_SIGNING_KEY);
const person = async (method: string, path: string, uid: string, body?: unknown) => app.request(`/v1${path}`, {
  method, headers: { Authorization: `Bearer ${await sign(uid, credentialContext('first_party_session'))}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
}, env);
/** A request as the host sends it from inside the app: mediated, with an app-bound session. */
const inApp = async (method: string, path: string, uid: string, body?: unknown) => app.request(`/v1${path}`, {
  method, headers: { Authorization: `Bearer ${await sign(uid, credentialContext('app_bound', 'shop'))}`, 'X-PAS-App': 'shop', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
}, env);
const json = async (r: Response) => (await r.json()) as any;
const rows = (sql: string, ...args: unknown[]) => db.sql.prepare(sql).all(...(args as never[])) as any[];
const promote = async (uid: string, appId = 'shop') => (await enroll(db, appId, uid, { consent: true, display_name: null })).promoter;
const attribution = (uid: string) => rows('SELECT * FROM app_referral_attributions WHERE app_id = ? AND referred_user_id = ?', 'shop', uid)[0];
let pat: Awaited<ReturnType<typeof promote>>, pru: Awaited<ReturnType<typeof promote>>;

beforeEach(async () => {
  db = sqliteD1();
  db.sql.exec(`PRAGMA foreign_keys = ON;
    INSERT INTO users (id, provider, provider_id, login, email, created_at, last_login_at) VALUES
      ('gh:1','github','1','owner',NULL,0,0),('gh:2','google','2','pat',NULL,0,0),('gh:3','google','3','pru',NULL,0,0),
      ('gh:10','google','10','${INVITEE_LOGIN}','${INVITEE_EMAIL}',0,0),('gh:11','google','11','second-invitee','second@example.invalid',0,0);
    INSERT INTO apps (id, creator_id, created_at) VALUES ('shop','gh:1',1),('other','gh:1',2);
    INSERT INTO team_members (app_id, user_id, role, created_at) VALUES ('shop','gh:1','owner',0),('other','gh:1','owner',0);`);
  env = makeEnv({ DB: db }) as Env;
  pat = await promote(PAT); pru = await promote(PRU);
});

/** The whole story once: capture, activation, confirmation, a reversal, a restore, and an opted-in public card. */
async function fullFlow() {
  await inApp('POST', '/apps/shop/referrals/claim', NEW1, { code: pat.code });
  await inApp('GET', '/auth/me', NEW1);
  await inApp('POST', '/apps/shop/referrals/claim', NEW2, { code: pru.code });
  await inApp('GET', '/auth/me', NEW2);
  const id = attribution(NEW2).id as string;
  await person('POST', `/apps/shop/referrals/${id}/reverse`, OWNER, { kind: 'correction', reason: 'test' });
  await person('POST', `/apps/shop/referrals/${id}/restore`, OWNER, {});
  await person('PUT', '/apps/shop/team/public/me', PAT, { display_name: 'Pat P.', visible: true, show_promotion: true });
}

describe('point 9: recognition only, never money', () => {
  const MONEY = ['amount', 'cents', 'price', 'currency', 'payout', 'commission', 'rate', 'fee', 'earning', 'earnings', 'reward', 'revenue', 'bonus', 'tariff', 'balance', 'iban', 'stripe', 'payment', 'pool'];

  it('has no money column in any promoter or referral table', () => {
    const tables = ['app_promoters', 'app_promoter_events', 'app_promoter_settings', 'app_user_activations', 'app_referral_attributions', 'app_referral_events'];
    for (const t of tables) {
      for (const col of rows(`PRAGMA table_info(${t})`)) {
        const tokens = String(col.name).split('_');
        expect([t, col.name, tokens.filter((x) => MONEY.includes(x))]).toEqual([t, col.name, []]);
      }
    }
  });

  it('writes nothing to subscriptions, licenses, billing, payouts or any pool/revenue table', async () => {
    const watched = rows(`SELECT name FROM sqlite_master WHERE type = 'table' AND (name IN ('subscriptions', 'licenses') OR name LIKE 'app_billing%' OR name LIKE '%payout%' OR name LIKE '%pool%' OR name LIKE '%commission%' OR name LIKE '%earning%' OR name LIKE '%revenue%' OR name LIKE 'app_entitlement%') ORDER BY name`).map((r) => r.name as string);
    expect(watched).toEqual(expect.arrayContaining(['subscriptions', 'licenses', 'creator_payouts', 'service_payouts']));
    const snapshot = () => Object.fromEntries(watched.map((t) => [t, JSON.stringify(rows(`SELECT * FROM ${t} ORDER BY rowid`))]));
    const before = snapshot();
    await fullFlow();
    expect(rows("SELECT status FROM app_referral_attributions WHERE status = 'confirmed'").length).toBe(2); // the flow really ran
    expect(snapshot()).toEqual(before);
  });

  it('exposes no money field or word in any view of the flow', async () => {
    await fullFlow();
    const views = await Promise.all([
      person('GET', '/apps/shop/promoters/me', PAT), person('GET', '/apps/shop/promoters/me/referrals', PAT), person('GET', '/apps/shop/promoters/me/contributions', PAT),
      person('GET', '/apps/shop/promoters', OWNER), person('GET', '/apps/shop/promoters/contributions', OWNER), person('GET', '/apps/shop/referrals', OWNER),
      person('GET', '/apps/shop/referrals/events', OWNER), person('GET', '/apps/shop/promoters/events', OWNER), person('GET', '/storefront/apps/shop/contributors', PAT),
    ].map(async (p) => { const r = await p; return { status: r.status, text: await r.text() }; }));
    for (const v of views) expect(v.status).toBe(200);
    const text = views.map((v) => v.text).join('\n');
    expect(text).not.toMatch(/"(amount|cents|price|currency|payout|commission|rate|fee|earnings?|reward|revenue|bonus|tariff|balance)[a-z_]*"\s*:/i);
    expect(text).not.toMatch(/\b(commission|payout|cash|revenue share|per referral|tariff)\b/i);
  });

  it('no promoter or referral source file imports billing or Stripe, or writes to a money table (reading "already a user" evidence is allowed)', () => {
    const files = [
      ...readdirSync(join(root, 'packages/backend/src/lib/promoters')).map((f) => `lib/promoters/${f}`),
      ...readdirSync(join(root, 'packages/backend/src/lib/referrals')).map((f) => `lib/referrals/${f}`),
      'routes/promoters.ts', 'routes/referrals.ts',
    ].filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'));
    expect(files.length).toBeGreaterThan(4);
    for (const f of files) {
      const code = readFileSync(join(root, 'packages/backend/src', f), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
      const imports = code.match(/from\s+['"][^'"]*(billing|stripe|payout|entitlement|ledger)[^'"]*['"]/gi) ?? [];
      const writes = code.match(/(INSERT\s+(OR\s+\w+\s+)?INTO|UPDATE|DELETE\s+FROM|REPLACE\s+INTO)\s+(subscriptions|licenses|creator_payouts|service_payouts|app_billing\w*|app_entitlement\w*|\w*payout\w*|\w*pool\w*)\b/gi) ?? [];
      expect([f, imports, writes]).toEqual([f, [], []]);
    }
  });
});

describe('point 5: no backfill, no silent reassignment', () => {
  it('no promoter or referral migration inserts attributions or activations from existing data', () => {
    for (const file of ['0129_app_promoters.sql', '0130_app_referrals.sql', '0131_promoter_contributions.sql']) {
      const sql = readFileSync(join(root, 'migrations', file), 'utf8').replace(/--.*$/gm, '');
      expect([file, /INSERT\s+(OR\s+\w+\s+)?INTO\s+app_(user_activations|referral_attributions)/i.test(sql)]).toEqual([file, false]);
    }
    expect(rows('SELECT COUNT(*) AS n FROM app_user_activations')[0].n).toBe(0);
    expect(rows('SELECT COUNT(*) AS n FROM app_referral_attributions')[0].n).toBe(0);
  });

  it('a person already using the app before the link is never credited, however old the evidence', async () => {
    db.sql.exec("INSERT INTO kv (app_id, user_id, key, value, value_size_bytes, updated_at) VALUES ('shop','gh:10','k','v',1,1)");
    expect(await claim(db, 'shop', NEW1, pat.code, Date.now())).toEqual({ credited: false, state: 'not_eligible' });
    await recordActivation(db, 'shop', NEW1, Date.now());
    expect(attribution(NEW1)).toBeUndefined();
  });

  it('a reversed credit stays with its promoter: another promoter claiming the same person changes nothing', async () => {
    await claim(db, 'shop', NEW1, pat.code); await recordActivation(db, 'shop', NEW1);
    const id = attribution(NEW1).id as string;
    expect((await person('POST', `/apps/shop/referrals/${id}/reverse`, OWNER, { kind: 'fraud_invalid' })).status).toBe(200);
    expect(await claim(db, 'shop', NEW1, pru.code)).toEqual({ credited: false, state: 'already_attributed' });
    expect(attribution(NEW1)).toMatchObject({ promoter_id: pat.id, status: 'reversed' });
    expect(rows("SELECT COUNT(*) AS n FROM app_referral_attributions WHERE promoter_id = ? AND status = 'confirmed'", pru.id)[0].n).toBe(0);
  });

  it('a promoter suspended and then reinstated before the activation still confirms the claim; a lapse during suspension does not', async () => {
    await claim(db, 'shop', NEW1, pat.code);
    expect((await person('POST', `/apps/shop/promoters/${pat.id}/status`, OWNER, { status: 'suspended', reason: 'check' })).status).toBe(200);
    expect((await person('POST', `/apps/shop/promoters/${pat.id}/status`, OWNER, { status: 'active' })).status).toBe(200);
    await recordActivation(db, 'shop', NEW1);
    expect(attribution(NEW1).status).toBe('confirmed');

    await claim(db, 'shop', NEW2, pat.code);
    await person('POST', `/apps/shop/promoters/${pat.id}/status`, OWNER, { status: 'suspended' });
    await recordActivation(db, 'shop', NEW2);
    await person('POST', `/apps/shop/promoters/${pat.id}/status`, OWNER, { status: 'active' });
    expect(attribution(NEW2).status).toBe('expired'); // the activation passed while suspended: the person is organic, not credited later
  });
});

describe('point 7: invitee privacy, no access, code and referral kept apart', () => {
  it('no view of the flow, to a promoter, the owner or the public, contains an invitee id, login or email', async () => {
    await fullFlow();
    const paths: Array<[string, string]> = [
      [PAT, '/apps/shop/promoters/me/referrals'], [PAT, '/apps/shop/promoters/me/contributions'], [PAT, '/apps/shop/promoters/me'],
      [OWNER, '/apps/shop/referrals'], [OWNER, '/apps/shop/referrals/events'], [OWNER, '/apps/shop/promoters/contributions'], [OWNER, '/apps/shop/promoters'], [OWNER, '/apps/shop/promoters/events'],
      [PAT, '/storefront/apps/shop/contributors'],
    ];
    for (const [uid, path] of paths) {
      const r = await person('GET', path, uid);
      const text = await r.text();
      expect([path, r.status]).toEqual([path, 200]);
      for (const secret of [INVITEE_LOGIN, INVITEE_EMAIL, 'second-invitee', 'second@example.invalid', NEW1, NEW2]) expect([path, text.includes(secret)]).toEqual([path, false]);
    }
  });

  it('a confirmed referral grants nobody any access: users, team, roles, licenses and tokens are untouched', async () => {
    const tables = ['users', 'team_members', 'app_roles', 'licenses', 'user_app_tokens', 'apps', 'app_visibility'];
    const snap = () => JSON.stringify(tables.map((t) => rows(`SELECT * FROM ${t} ORDER BY rowid`).map((r) => (t === 'users' ? { ...r, last_login_at: 0 } : r))));
    const before = snap();
    await inApp('POST', '/apps/shop/referrals/claim', NEW1, { code: pat.code });
    await inApp('GET', '/auth/me', NEW1);
    expect(attribution(NEW1).status).toBe('confirmed');
    expect(snap()).toBe(before);
    // and the promoter cannot use the credit as a key into owner routes
    expect((await person('GET', '/apps/shop/referrals', PAT)).status).toBe(403);
    expect((await person('GET', '/apps/shop/promoters', PAT)).status).toBe(403);
    expect((await person('GET', '/apps/shop/contributions', PAT)).status).toBe(403);
  });

  it('keeps the code-line contribution and the referral contribution in separate endpoints and fields, never one figure', async () => {
    const gh = new FakeGitHub({ fullName: 'proappstore-online/shop' });
    gh.history = [commit({ authorId: 2, authorLogin: 'pat', adds: 40 })];
    await refreshProject(db, gh, 'shop', { now: Date.now() });
    await fullFlow();

    const code = await (await person('GET', '/apps/shop/contributions', OWNER)).text();
    const codePeople = await (await person('GET', '/apps/shop/contributions/people', OWNER)).text();
    expect(code + codePeople).toContain('"additions"');
    expect(code + codePeople).not.toMatch(/referr|promoter|attribution|promotion/i);

    const promo = await (await person('GET', '/apps/shop/promoters/me/contributions', PAT)).text();
    const standings = await (await person('GET', '/apps/shop/promoters/contributions', OWNER)).text();
    expect(promo + standings).toContain('confirmed');
    expect(promo + standings).not.toMatch(/"additions"|"deletions"|github_account_id|"lines/i);
    // the promoter's own record says code is reported elsewhere; it never carries a number for it
    expect(JSON.parse(promo)).toMatchObject({ contributions: { code: { available: false } } });
    expect(promo + standings).not.toMatch(/"(score|overall|combined|blended|weighted|total_score)"/i);
  });

  it('public recognition shows nobody until they opt in, and only the safe fields once they do', async () => {
    await inApp('POST', '/apps/shop/referrals/claim', NEW1, { code: pat.code });
    await inApp('GET', '/auth/me', NEW1);
    const before = await json(await person('GET', '/storefront/apps/shop/contributors', NEW2));
    expect(JSON.stringify(before)).not.toContain('Pat');
    await person('PUT', '/apps/shop/team/public/me', PAT, { display_name: 'Pat P.', visible: true, show_promotion: true });
    const after = await json(await person('GET', '/storefront/apps/shop/contributors', NEW2));
    const card = JSON.stringify(after);
    expect(card).toContain('Pat P.');
    expect(card).not.toContain(pat.code); // the promoter's public referral code is not part of the card
    expect(card).not.toMatch(/gh:|"user_id"|email|login|referral_id|promoter_id/i);
  });
});

describe('point 3: the link a QR encodes', () => {
  it('is one stable, per-app, PII-free URL: the same after replay and rename, different per app', async () => {
    const first = (await enroll(db, 'shop', 'gh:3', { consent: true, display_name: 'A' })).promoter;
    const again = (await enroll(db, 'shop', 'gh:3', { consent: true, display_name: 'B' })).promoter;
    const elsewhere = (await enroll(db, 'other', 'gh:3', { consent: true, display_name: null })).promoter;
    expect(again.code).toBe(first.code);
    const view = async (appId: string) => json(await person('GET', `/apps/${appId}/promoters/me`, PRU));
    const a = (await view('shop')).promoter ?? (await view('shop'));
    const b = (await view('other')).promoter ?? (await view('other'));
    expect(a.share_url).toBe(`https://proappstore.online/apps/shop?ref=${first.code}`);
    expect(b.share_url).toBe(`https://proappstore.online/apps/other?ref=${elsewhere.code}`);
    expect(a.share_url).not.toBe(b.share_url);
    expect(a.share_url).not.toMatch(/gh:|@|pru|user/i);
  });
});
