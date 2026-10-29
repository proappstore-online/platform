import { env as providedEnv, fetchMock } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Env } from '../../../backend/src/types';
import { handleAppBillingEvent } from '../../../backend/src/lib/app-billing-handler';
import { ensureMirrorTable, mirrorApp, mirrorStatements, type MirrorRow } from '../../../backend/src/lib/entitlement-mirror';
import { sweepEntitlements } from '../../../backend/src/lib/entitlement-sweep';
import { mockNetwork } from './helpers';

const env = providedEnv as unknown as Env;

// #508 on real D1: entitlements are pushed into the app's own D1 as `_pas_entitlements`, and the clock moves them on without a Stripe
// event. The app's data worker is intercepted; the generated SQL is also run on a real D1 to prove it.

const at = (iso: string) => Date.parse(iso);
const sec = (iso: string) => Math.floor(at(iso) / 1000);
const T0 = '2026-01-10T00:00:00Z';
const OURS = { app_id: 'club', user_id: 'gh:2', purchase_id: 'pur_1' };
let n = 0;
const evt = (type: string, created: string, object: Record<string, unknown>) => ({ id: `evt_${++n}`, type, created: sec(created), data: { object } });
const oneOff = (created = T0) => evt('checkout.session.completed', created, { id: 'cs_1', mode: 'payment', payment_status: 'paid', amount_total: 3000, currency: 'aud', payment_intent: 'pi_1', metadata: OURS });
const invoice = (id = 'in_1') => ({ id, amount_paid: 3000, currency: 'aud', subscription: 'sub_1', subscription_details: { metadata: OURS } });

async function seedPurchase(mode: 'one_time' | 'recurring', subjects = ['kid-a', 'kid-b', 'kid-c']) {
  await env.DB.prepare(
    `INSERT INTO app_purchases (id, app_id, product_key, buyer_user_id, subjects, quantity, mode, status, interval_unit, interval_count, grace_days, created_at, updated_at)
     VALUES ('pur_1', 'club', 'child_term', 'gh:2', ?, ?, ?, 'pending', 'month', 3, 5, 1, 1)`,
  ).bind(JSON.stringify(subjects), subjects.length, mode).run();
}
const rows = async () => (await env.DB.prepare("SELECT subject, status, version, mirrored_version FROM app_entitlements WHERE app_id = 'club' ORDER BY subject").all<Record<string, unknown>>()).results ?? [];

interface Push { statements: { sql: string; params?: unknown[] }[]; token: string | null }
let pushes: Push[] = [];
const dataWorker = () => fetchMock.get(`https://pas-data-club.${env.DATA_WORKER_HOST}`);
/** The app's data worker accepts one push and records it. Each push first asks which columns the app's `_pas_entitlements` has (#508). */
const accepts = (status = 200, columns: string[] = []) => {
  dataWorker().intercept({ path: '/query', method: 'POST' }).reply(200, { rows: columns.map((name) => ({ name })) });
  return acceptsBatch(status);
};
const acceptsBatch = (status: number) => dataWorker().intercept({ path: '/batch', method: 'POST' }).reply(status, (req) => {
  const headers = Object.fromEntries(Object.entries((req.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v]));
  pushes.push({ ...(JSON.parse(String(req.body)) as { statements: Push['statements'] }), token: headers['x-internal-token'] ?? null });
  return status === 200 ? { results: [] } : { error: 'internal server error' };
});
const statuses = (p: Push) => p.statements.slice(1).map((s) => s.params![2]);

afterEach(() => fetchMock.assertNoPendingInterceptors());
beforeEach(async () => {
  pushes = [];
  mockNetwork();
  for (const t of ['app_billing_events', 'app_billing_payments', 'app_billing_payment_refs', 'app_entitlements', 'app_purchases']) await env.DB.prepare(`DELETE FROM ${t}`).run();
  await env.DB.prepare('DROP TABLE IF EXISTS _pas_entitlements').run();
});

describe('the mirror statements, run on a real D1 (#508)', () => {
  const row = (over: Partial<MirrorRow> = {}): MirrorRow => ({ product_key: 'child_term', subject: 'kid-a', status: 'active', period_end: 100, grace_until: null, renews: 0, buyer_user_id: 'gh:2', version: 1, updated_at: 1, ...over });
  const push = async (rs: MirrorRow[]) => { for (const s of mirrorStatements(rs)) await env.DB.prepare(s.sql).bind(...(s.params ?? [])).run(); };
  const mirrored = async () => (await env.DB.prepare('SELECT product, subject, status, version FROM _pas_entitlements ORDER BY product, subject').all<Record<string, unknown>>()).results;

  it('creates the table on first use and upserts: one row per (product, subject)', async () => {
    await push([row(), row({ subject: 'kid-b' }), row({ product_key: 'other', subject: 'kid-a' })]);
    expect(await mirrored()).toHaveLength(3);
    await push([row({ status: 'expired', version: 2 })]);
    expect((await mirrored()).find((r) => r.product === 'child_term' && r.subject === 'kid-a')).toMatchObject({ status: 'expired', version: 2 });
    expect(await mirrored()).toHaveLength(3);
  });

  it('a late or repeated push never overwrites newer state, and the same version is idempotent', async () => {
    await push([row({ status: 'expired', version: 3 })]);
    await push([row({ status: 'active', version: 2 })]); // an older push arriving late
    expect((await mirrored())[0]).toMatchObject({ status: 'expired', version: 3 });
    await push([row({ status: 'expired', version: 3 })]); // a retry of the same push
    expect(await mirrored()).toHaveLength(1);
    expect((await mirrored())[0]).toMatchObject({ status: 'expired', version: 3 });
  });

  it('carries the empty subject and NULLs', async () => {
    await push([row({ subject: '', period_end: null, buyer_user_id: null })]);
    expect((await env.DB.prepare("SELECT period_end, buyer_user_id FROM _pas_entitlements WHERE subject = ''").first())).toEqual({ period_end: null, buyer_user_id: null });
  });
});

describe('adopting a _pas_entitlements the app already created, on a real D1 (#508)', () => {
  const row = (over: Partial<MirrorRow> = {}): MirrorRow => ({ product_key: 'child_term', subject: 'kid-a', status: 'active', period_end: 100, grace_until: null, renews: 0, buyer_user_id: 'gh:2', version: 1, updated_at: 1, ...over });
  // chess-academy's migration 0061 shape: the contract columns, no `version`.
  const LEGACY = `CREATE TABLE _pas_entitlements (product TEXT NOT NULL, subject TEXT NOT NULL, status TEXT NOT NULL, period_end INTEGER, grace_until INTEGER,
    renews INTEGER NOT NULL DEFAULT 0, buyer_user_id TEXT, updated_at INTEGER NOT NULL, PRIMARY KEY (product, subject))`;
  const columns = async () => ((await env.DB.prepare('PRAGMA table_info(_pas_entitlements)').all<{ name: string }>()).results ?? []).map((c) => c.name);
  const push = async (rs: MirrorRow[]) => { for (const st of mirrorStatements(rs, await columns())) await env.DB.prepare(st.sql).bind(...(st.params ?? [])).run(); };

  it('adds the missing column, keeps the app\'s rows and key, and the platform\'s row wins for the same (product, subject)', async () => {
    await env.DB.prepare(LEGACY).run();
    await env.DB.prepare("INSERT INTO _pas_entitlements VALUES ('child_term', 'kid-old', 'active', 5, NULL, 0, 'gh:9', 5)").run();
    await env.DB.prepare("INSERT INTO _pas_entitlements VALUES ('child_term', 'kid-a', 'expired', 1, NULL, 0, 'gh:9', 5)").run();
    await push([row()]);
    expect(await columns()).toContain('version');
    const all = (await env.DB.prepare('SELECT subject, status, version FROM _pas_entitlements ORDER BY subject').all<Record<string, unknown>>()).results;
    expect(all).toEqual([{ subject: 'kid-a', status: 'active', version: 1 }, { subject: 'kid-old', status: 'active', version: 0 }]);
    await push([row({ status: 'expired', version: 0 })]); // an older push cannot undo it
    expect((await env.DB.prepare("SELECT status FROM _pas_entitlements WHERE subject = 'kid-a'").first())).toEqual({ status: 'active' });
  });

  it('a push through the app\'s data worker carries the ALTER and the key before the rows, and they apply on the legacy table', async () => {
    await env.DB.prepare(LEGACY).run();
    await seedPurchase('one_time');
    accepts(200, ['product', 'subject', 'status', 'period_end', 'grace_until', 'renews', 'buyer_user_id', 'updated_at']);
    await handleAppBillingEvent(env.DB, oneOff(), at('2026-01-11T00:00:00Z'), async (appId) => { await mirrorApp(env, appId); });
    const [p] = pushes;
    expect(p!.statements[0]!.sql).toBe('ALTER TABLE _pas_entitlements ADD COLUMN version INTEGER NOT NULL DEFAULT 0');
    expect(p!.statements[1]!.sql).toMatch(/^CREATE UNIQUE INDEX IF NOT EXISTS/);
    expect(p!.statements.map((st) => st.sql).join(' ')).not.toMatch(/DROP|CREATE TABLE/);
    for (const st of p!.statements) await env.DB.prepare(st.sql).bind(...(st.params ?? [])).run();
    expect((await env.DB.prepare('SELECT subject, status, version FROM _pas_entitlements ORDER BY subject').all()).results).toHaveLength(3);
  });
});

describe('ensureMirrorTable at deploy, on a real D1 (#510)', () => {
  const columns = async () => ((await env.DB.prepare('PRAGMA table_info(_pas_entitlements)').all<{ name: string }>()).results ?? []).map((c) => c.name);
  // chess-academy's migration 0061 shape: the contract columns, no `version`.
  const LEGACY = `CREATE TABLE _pas_entitlements (product TEXT NOT NULL, subject TEXT NOT NULL, status TEXT NOT NULL, period_end INTEGER, grace_until INTEGER,
    renews INTEGER NOT NULL DEFAULT 0, buyer_user_id TEXT, updated_at INTEGER NOT NULL, PRIMARY KEY (product, subject))`;

  it('no table yet: the deploy path creates it empty, before any entitlement event ever reaches mirrorApp', async () => {
    accepts();
    await ensureMirrorTable(env, 'club');
    for (const st of pushes[0]!.statements) await env.DB.prepare(st.sql).bind(...(st.params ?? [])).run();
    expect(await columns()).toEqual(['product', 'subject', 'status', 'period_end', 'grace_until', 'renews', 'buyer_user_id', 'version', 'updated_at']);
    expect((await env.DB.prepare('SELECT * FROM _pas_entitlements').all()).results).toEqual([]);
  });

  it('a pre-existing legacy table (the chess-academy 0061 placeholder): adopted, not dropped, and a re-deploy is a no-op on its shape', async () => {
    await env.DB.prepare(LEGACY).run();
    await env.DB.prepare("INSERT INTO _pas_entitlements VALUES ('child_term', 'kid-a', 'active', 100, NULL, 0, 'gh:9', 5)").run();
    accepts(200, await columns());
    await ensureMirrorTable(env, 'club');
    for (const st of pushes[0]!.statements) await env.DB.prepare(st.sql).bind(...(st.params ?? [])).run();
    expect(await columns()).toEqual(['product', 'subject', 'status', 'period_end', 'grace_until', 'renews', 'buyer_user_id', 'updated_at', 'version']);
    // the app's row survives, untouched — only platform pushes ever write a row
    expect((await env.DB.prepare('SELECT subject, status, version FROM _pas_entitlements').first())).toEqual({ subject: 'kid-a', status: 'active', version: 0 });

    const shape = await columns();
    accepts(200, shape);
    await ensureMirrorTable(env, 'club');
    for (const st of pushes[1]!.statements) await env.DB.prepare(st.sql).bind(...(st.params ?? [])).run();
    expect(await columns()).toEqual(shape);
    expect(pushes[1]!.statements).toHaveLength(1); // only the already-present index — no ALTER left to run
  });
});

describe('pushing to the app (#508)', () => {
  it('after an event is applied: the table is created first, then one upsert per subject, with the trusted token, and the rows are marked mirrored', async () => {
    await seedPurchase('one_time');
    accepts();
    await handleAppBillingEvent(env.DB, oneOff(), at('2026-01-11T00:00:00Z'), async (appId) => { await mirrorApp(env, appId); });
    expect(pushes).toHaveLength(1);
    const [p] = pushes;
    expect(p!.token).toBe('runtime-test-internal-token');
    expect(p!.statements[0]!.sql).toMatch(/^CREATE TABLE IF NOT EXISTS _pas_entitlements/);
    expect(p!.statements).toHaveLength(4);
    expect(p!.statements.slice(1).map((s) => s.params![1])).toEqual(['kid-a', 'kid-b', 'kid-c']);
    expect(p!.statements[1]!.sql).toMatch(/WHERE excluded\.version >= _pas_entitlements\.version/);
    expect(statuses(p!)).toEqual(['active', 'active', 'active']);
    expect(await rows()).toEqual([1, 2, 3].map((_, i) => ({ subject: ['kid-a', 'kid-b', 'kid-c'][i], status: 'active', version: 1, mirrored_version: 1 })));
  });

  it('a push the app refuses leaves the rows dirty, and the sweep retries them', async () => {
    await seedPurchase('one_time');
    accepts(500);
    await handleAppBillingEvent(env.DB, oneOff(), at('2026-01-11T00:00:00Z'), async (appId) => { await mirrorApp(env, appId); });
    expect((await rows()).every((r) => r.mirrored_version === 0)).toBe(true);
    accepts();
    const report = await sweepEntitlements(env, at('2026-01-11T00:00:00Z'));
    expect(report).toMatchObject({ due: 0, changed: 0, mirroredApps: 1, mirroredRows: 3 });
    expect((await rows()).every((r) => r.mirrored_version === 1)).toBe(true);
  });

  it('an unreachable app is a failed push too, not an error', async () => {
    await seedPurchase('one_time');
    // no interceptor: the network is shut, so the push throws
    await handleAppBillingEvent(env.DB, oneOff(), at('2026-01-11T00:00:00Z'), async (appId) => { expect(await mirrorApp(env, appId)).toBe(0); });
    expect((await rows()).every((r) => r.mirrored_version === 0)).toBe(true);
  });

  it('with nothing dirty makes no request', async () => {
    await seedPurchase('one_time');
    accepts();
    await handleAppBillingEvent(env.DB, oneOff(), at('2026-01-11T00:00:00Z'), async (appId) => { await mirrorApp(env, appId); });
    expect(await mirrorApp(env, 'club')).toBe(0);
    expect(await sweepEntitlements(env, at('2026-01-12T00:00:00Z'))).toEqual({ due: 0, changed: 0, mirroredApps: 0, mirroredRows: 0 });
    expect(pushes).toHaveLength(1);
  });

  it('a hook that throws can never fail the event', async () => {
    await seedPurchase('one_time');
    const r = await handleAppBillingEvent(env.DB, oneOff(), at('2026-01-11T00:00:00Z'), async () => { throw new Error('boom'); });
    expect(r).toEqual({ handled: true, purchaseId: 'pur_1' });
    expect(await rows()).toHaveLength(3);
  });
});

describe('the sweep moves entitlements by the clock (#508)', () => {
  /** Apply an event with no push, then let the sweep push the first copy, so each test starts from a mirrored row. */
  async function start(mode: 'one_time' | 'recurring', events: unknown[], nowAt: string) {
    await seedPurchase(mode);
    for (const e of events) await handleAppBillingEvent(env.DB, e, at(nowAt));
    accepts();
    await sweepEntitlements(env, at(nowAt));
    pushes = [];
  }

  it('a one-off term becomes expired at period_end, and the app is told', async () => {
    await start('one_time', [oneOff()], '2026-01-11T00:00:00Z');
    expect(await sweepEntitlements(env, at('2026-04-09T23:59:59Z'))).toMatchObject({ due: 0 });
    accepts();
    const report = await sweepEntitlements(env, at('2026-04-10T00:00:00Z'));
    expect(report).toMatchObject({ due: 3, changed: 3, mirroredApps: 1, mirroredRows: 3 });
    expect(statuses(pushes[0]!)).toEqual(['expired', 'expired', 'expired']);
    expect((await rows()).every((r) => r.status === 'expired' && r.version === 2 && r.mirrored_version === 2)).toBe(true);
  });

  it('a second sweep after that does nothing', async () => {
    await start('one_time', [oneOff()], '2026-01-11T00:00:00Z');
    accepts();
    await sweepEntitlements(env, at('2026-04-10T00:00:00Z'));
    expect(await sweepEntitlements(env, at('2026-04-11T00:00:00Z'))).toEqual({ due: 0, changed: 0, mirroredApps: 0, mirroredRows: 0 });
  });

  it('grace becomes expired at grace_until', async () => {
    await start('recurring', [evt('invoice.paid', T0, invoice()), evt('invoice.payment_failed', '2026-04-10T01:00:00Z', invoice('in_2'))], '2026-04-11T00:00:00Z');
    expect((await rows()).every((r) => r.status === 'grace')).toBe(true);
    expect(await sweepEntitlements(env, at('2026-04-14T23:59:59Z'))).toMatchObject({ due: 0 });
    accepts();
    expect(await sweepEntitlements(env, at('2026-04-15T00:00:00Z'))).toMatchObject({ due: 3, changed: 3 });
    expect((await rows()).every((r) => r.status === 'expired')).toBe(true);
  });

  it('a renewing subscription past period_end waits for Stripe, then expires after the slack', async () => {
    await start('recurring', [evt('invoice.paid', T0, invoice())], '2026-01-11T00:00:00Z');
    expect(await sweepEntitlements(env, at('2026-04-11T00:00:00Z'))).toMatchObject({ due: 0 }); // one day past period_end: still awaiting the renewal
    accepts();
    expect(await sweepEntitlements(env, at('2026-04-13T00:00:00Z'))).toMatchObject({ due: 3, changed: 3 }); // three days past
    expect((await rows()).every((r) => r.status === 'expired')).toBe(true);
  });

  it('cancel at period end expires at period_end, with no slack', async () => {
    const cancel = evt('customer.subscription.updated', '2026-02-01T00:00:00Z', { id: 'sub_1', status: 'active', cancel_at_period_end: true, metadata: OURS });
    await start('recurring', [evt('invoice.paid', T0, invoice()), cancel], '2026-02-02T00:00:00Z');
    expect((await rows()).every((r) => r.status === 'active')).toBe(true);
    accepts();
    expect(await sweepEntitlements(env, at('2026-04-10T00:00:00Z'))).toMatchObject({ due: 3, changed: 3 });
    expect((await rows()).every((r) => r.status === 'expired')).toBe(true);
  });

  it('a renewal after expiry brings the subject back and pushes it again', async () => {
    await start('recurring', [evt('invoice.paid', T0, invoice())], '2026-01-11T00:00:00Z');
    accepts();
    await sweepEntitlements(env, at('2026-04-13T00:00:00Z'));
    pushes = [];
    accepts();
    await handleAppBillingEvent(env.DB, evt('invoice.paid', '2026-04-20T00:00:00Z', invoice('in_2')), at('2026-04-20T01:00:00Z'), async (appId) => { await mirrorApp(env, appId); });
    expect(statuses(pushes[0]!)).toEqual(['active', 'active', 'active']);
    expect((await rows()).every((r) => r.status === 'active' && r.version === 3 && r.mirrored_version === 3)).toBe(true);
  });
});
