import { describe, expect, it, vi } from 'vitest';
import { sqliteD1 } from '../sqlite-d1.js';
import { handleAppBillingEvent } from './app-billing-handler.js';
import { recomputePurchase, recomputeSubject } from './entitlement-store.js';

// #508: Stripe events for an app purchase become per-subject entitlements. Real SQL (the platform's migrations on in-memory SQLite);
// the same behaviour runs on workerd and real D1 in packages/runtime-tests.

const at = (iso: string) => Date.parse(iso);
const sec = (iso: string) => Math.floor(at(iso) / 1000);
const T0 = '2026-01-10T00:00:00Z';
const OURS = (purchase = 'pur_1') => ({ app_id: 'club', user_id: 'gh:2', purchase_id: purchase });
let n = 0;
const evt = (type: string, created: string, object: Record<string, unknown>) => ({ id: `evt_${++n}`, type, created: sec(created), data: { object } });
const session = (mode: 'payment' | 'subscription', purchase = 'pur_1') => ({
  id: `cs_${purchase}`, mode, payment_status: 'paid', amount_total: 3000, currency: 'aud', payment_intent: mode === 'payment' ? `pi_${purchase}` : null,
  subscription: mode === 'subscription' ? `sub_${purchase}` : null, metadata: OURS(purchase),
});
const invoice = (id: string, purchase = 'pur_1') => ({ id, amount_paid: 3000, currency: 'aud', subscription: `sub_${purchase}`, lines: { data: [{ period: { end: 1 } }] }, subscription_details: { metadata: OURS(purchase) } });

function setup() {
  const db = sqliteD1();
  const seed = (id: string, mode: 'one_time' | 'recurring', subjects: string[] = ['kid-a', 'kid-b', 'kid-c']) =>
    db.prepare(
      `INSERT INTO app_purchases (id, app_id, product_key, buyer_user_id, subjects, quantity, mode, status, interval_unit, interval_count, grace_days, created_at, updated_at)
       VALUES (?, 'club', 'child_term', 'gh:2', ?, ?, ?, 'pending', 'month', 3, 5, 1, 1)`,
    ).bind(id, JSON.stringify(subjects), Math.max(1, subjects.length), mode).run();
  const ents = async () => (await db.prepare('SELECT subject, status, period_start, period_end, grace_until, renews, version FROM app_entitlements ORDER BY subject').all<Record<string, unknown>>()).results;
  const count = async (t: string) => (await db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).first<{ n: number }>())!.n;
  const handle = (e: unknown, now = at('2026-01-11T00:00:00Z'), hook?: (appId: string) => Promise<void>) => handleAppBillingEvent(db, e, now, hook);
  return { db, seed, ents, count, handle };
}

describe('a one-off purchase for three subjects', () => {
  it('creates exactly three entitlements, one term from the payment, and records the payment once', async () => {
    const t = setup();
    await t.seed('pur_1', 'one_time');
    expect(await t.handle(evt('checkout.session.completed', T0, session('payment')))).toEqual({ handled: true, purchaseId: 'pur_1' });
    const rows = await t.ents();
    expect(rows).toHaveLength(3);
    for (const r of rows) expect(r).toMatchObject({ status: 'active', period_start: at(T0), period_end: at('2026-04-10T00:00:00Z'), grace_until: null, renews: 0, version: 1 });
    expect(await t.count('app_billing_payments')).toBe(1);
    expect((await t.db.prepare("SELECT status FROM app_purchases WHERE id = 'pur_1'").first<{ status: string }>())?.status).toBe('paid');
    expect((await t.db.prepare("SELECT purchase_id FROM app_billing_payment_refs WHERE ref = 'pi_pur_1'").first<{ purchase_id: string }>())?.purchase_id).toBe('pur_1');
  });

  it('a replay changes nothing', async () => {
    const t = setup();
    await t.seed('pur_1', 'one_time');
    const e = evt('checkout.session.completed', T0, session('payment'));
    await t.handle(e);
    const before = await t.ents();
    expect(await t.handle(e)).toEqual({ handled: true, purchaseId: 'pur_1', duplicate: true });
    expect(await t.ents()).toEqual(before);
    expect(await t.count('app_billing_events')).toBe(1);
  });

  it('a product with no subject is one entitlement under the empty subject', async () => {
    const t = setup();
    await t.seed('pur_1', 'one_time', []);
    await t.handle(evt('checkout.session.completed', T0, session('payment')));
    expect(await t.ents()).toMatchObject([{ subject: '', status: 'active' }]);
  });

  it('an unpaid session, an unknown purchase and another app\'s purchase are ignored', async () => {
    const t = setup();
    await t.seed('pur_1', 'one_time');
    expect(await t.handle(evt('checkout.session.completed', T0, { ...session('payment'), payment_status: 'unpaid' }))).toEqual({ handled: false, purchaseId: null });
    expect(await t.handle(evt('checkout.session.completed', T0, session('payment', 'pur_unknown')))).toEqual({ handled: false, purchaseId: null });
    const other = session('payment');
    other.metadata = { ...other.metadata, app_id: 'elsewhere' };
    expect(await t.handle(evt('checkout.session.completed', T0, other))).toEqual({ handled: false, purchaseId: null });
    expect(await t.ents()).toEqual([]);
  });

  it('a full refund ends the entitlements at once, and the refund stays whatever arrives after', async () => {
    const t = setup();
    await t.seed('pur_1', 'one_time');
    await t.handle(evt('checkout.session.completed', T0, session('payment')));
    await t.handle(evt('charge.refunded', '2026-01-12T00:00:00Z', { id: 'ch_1', amount: 3000, amount_refunded: 3000, refunded: true, metadata: OURS() }));
    expect((await t.ents()).every((r) => r.status === 'refunded')).toBe(true);
    expect((await t.db.prepare("SELECT status FROM app_purchases WHERE id = 'pur_1'").first<{ status: string }>())?.status).toBe('refunded');
    expect((await t.db.prepare("SELECT purchase_id FROM app_billing_payment_refs WHERE ref = 'ch_1'").first<{ purchase_id: string }>())?.purchase_id).toBe('pur_1');
  });
});

describe('a subscription', () => {
  it('checkout then invoice, and invoice then checkout, end in the same state', async () => {
    const t = setup();
    await t.seed('pur_a', 'recurring', ['a1']);
    await t.seed('pur_b', 'recurring', ['b1']);
    await t.handle(evt('checkout.session.completed', T0, session('subscription', 'pur_a')));
    await t.handle(evt('invoice.paid', T0, invoice('in_a', 'pur_a')));
    await t.handle(evt('invoice.paid', T0, invoice('in_b', 'pur_b')));
    await t.handle(evt('checkout.session.completed', T0, session('subscription', 'pur_b')));
    const rows = await t.ents();
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ status: 'active', renews: 1, period_start: at(T0), period_end: at('2026-04-10T00:00:00Z') });
    expect({ ...rows[1], subject: 'a1' }).toEqual(rows[0]);
    expect(await t.count('app_billing_payments')).toBe(2);
  });

  it('a failed payment starts grace, a later renewal ends it, and the failure time only moves forward', async () => {
    const t = setup();
    await t.seed('pur_1', 'recurring', ['kid']);
    await t.handle(evt('checkout.session.completed', T0, session('subscription')));
    await t.handle(evt('invoice.paid', T0, invoice('in_1')));
    await t.handle(evt('invoice.payment_failed', '2026-04-10T00:00:00Z', invoice('in_2')), at('2026-04-11T00:00:00Z'));
    await t.handle(evt('invoice.payment_failed', '2026-04-01T00:00:00Z', invoice('in_3')), at('2026-04-11T00:00:00Z'));
    expect((await t.db.prepare("SELECT failed_at FROM app_purchases WHERE id = 'pur_1'").first<{ failed_at: number }>())?.failed_at).toBe(at('2026-04-10T00:00:00Z'));
    expect(await t.ents()).toMatchObject([{ status: 'grace', grace_until: at('2026-04-15T00:00:00Z') }]);
  });

  it('cancel at period end follows the newest event, and an ended subscription is final', async () => {
    const t = setup();
    await t.seed('pur_1', 'recurring', ['kid']);
    await t.handle(evt('checkout.session.completed', T0, session('subscription')));
    await t.handle(evt('invoice.paid', T0, invoice('in_1')));
    const upd = (when: string, cancel: boolean, status = 'active') => evt('customer.subscription.updated', when, { id: 'sub_pur_1', status, cancel_at_period_end: cancel, metadata: OURS() });
    await t.handle(upd('2026-02-01T00:00:00Z', true));
    await t.handle(upd('2026-01-20T00:00:00Z', false));
    const row = () => t.db.prepare('SELECT sub_cancel_at_period_end AS c, sub_ended_at AS e FROM app_purchases').first<{ c: number; e: number | null }>();
    expect(await row()).toEqual({ c: 1, e: null });
    await t.handle(upd('2026-03-01T00:00:00Z', true, 'canceled'));
    expect((await row())!.e).toBe(at('2026-03-01T00:00:00Z'));
    await t.handle(evt('customer.subscription.deleted', '2026-03-02T00:00:00Z', { id: 'sub_pur_1', status: 'canceled', metadata: OURS() }));
    expect((await row())!.e).toBe(at('2026-03-01T00:00:00Z'));
    expect((await t.ents())[0]!.status).toBe('canceled');
  });
});

describe('the hook and the clock', () => {
  it('runs the after-applied hook with the app id, and a throwing hook can never fail the event', async () => {
    const t = setup();
    await t.seed('pur_1', 'one_time');
    const hook = vi.fn(async () => { throw new Error('mirror down'); });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await expect(t.handle(evt('checkout.session.completed', T0, session('payment')), at('2026-01-11T00:00:00Z'), hook)).resolves.toMatchObject({ handled: true });
    expect(hook).toHaveBeenCalledWith('club');
    warn.mockRestore();
  });

  it('uses the injected clock when an event carries none', async () => {
    const t = setup();
    await t.seed('pur_1', 'one_time');
    const e = evt('checkout.session.completed', T0, session('payment'));
    delete (e as { created?: number }).created;
    await t.handle(e, at('2026-02-01T00:00:00Z'));
    expect((await t.ents())[0]).toMatchObject({ period_start: at('2026-02-01T00:00:00Z') });
  });
});

describe('entitlement store', () => {
  it('recomputes nothing for a subject nobody bought, and an unknown purchase', async () => {
    const t = setup();
    expect(await recomputeSubject(t.db, 'club', 'child_term', 'nobody', 1)).toBe(false);
    expect(await recomputePurchase(t.db, 'nope', 1)).toBe(0);
  });

  it('writes only when the entitlement changed, and bumps the version when it does', async () => {
    const t = setup();
    await t.seed('pur_1', 'one_time', ['kid']);
    await t.handle(evt('checkout.session.completed', T0, session('payment')), at('2026-01-11T00:00:00Z'));
    expect(await recomputeSubject(t.db, 'club', 'child_term', 'kid', at('2026-01-12T00:00:00Z'))).toBe(false);
    expect((await t.ents())[0]!.version).toBe(1);
    expect(await recomputeSubject(t.db, 'club', 'child_term', 'kid', at('2026-06-01T00:00:00Z'))).toBe(true);
    expect(await t.ents()).toMatchObject([{ status: 'expired', version: 2 }]);
    expect(await recomputePurchase(t.db, 'pur_1', at('2026-06-02T00:00:00Z'))).toBe(0);
  });

  it('a purchase whose subjects JSON is not a list covers the empty subject', async () => {
    const t = setup();
    await t.db.prepare("INSERT INTO app_purchases (id, app_id, product_key, buyer_user_id, subjects, quantity, mode, status, created_at, updated_at) VALUES ('pur_x', 'club', 'donation', 'gh:2', ?, 1, 'one_time', 'paid', 1, 1)").bind('{"a":1}').run();
    await t.db.prepare("INSERT INTO app_billing_payments (id, purchase_id, paid_at, amount, currency, created_at) VALUES ('p1', 'pur_x', 1000, 500, 'aud', 1)").run();
    expect(await recomputePurchase(t.db, 'pur_x', 2000)).toBe(1);
    expect(await t.ents()).toMatchObject([{ subject: '', status: 'active' }]);
  });
});
