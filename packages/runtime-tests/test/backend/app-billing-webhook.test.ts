import { SELF, env as providedEnv } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import type { Env } from '../../../backend/src/types';
import { handleAppBillingEvent } from '../../../backend/src/lib/app-billing-handler';

const env = providedEnv as unknown as Env;

// #508 on real D1 and the real migrations: Stripe events for an app purchase become per-subject entitlements. Verified events go
// through the signed webhook route; time-sensitive transitions call the handler with an explicit clock.

const at = (iso: string) => Date.parse(iso);
const sec = (iso: string) => Math.floor(at(iso) / 1000);
const T0 = '2026-01-10T00:00:00Z';
const OURS = (purchase = 'pur_1') => ({ app_id: 'club', user_id: 'gh:2', purchase_id: purchase });

let n = 0;
const evt = (type: string, created: string, object: Record<string, unknown>) => ({ id: `evt_${++n}`, type, created: sec(created), data: { object } });
const session = (mode: 'payment' | 'subscription', over: Record<string, unknown> = {}, purchase = 'pur_1') => ({
  id: `cs_${purchase}`, mode, payment_status: 'paid', amount_total: 3000, currency: 'aud', payment_intent: mode === 'payment' ? `pi_${purchase}` : null,
  subscription: mode === 'subscription' ? `sub_${purchase}` : null, metadata: OURS(purchase), ...over,
});
const invoice = (id: string, purchase = 'pur_1', over: Record<string, unknown> = {}) => ({
  id, amount_paid: 3000, currency: 'aud', subscription: `sub_${purchase}`, lines: { data: [{ period: { end: 1 } }] }, subscription_details: { metadata: OURS(purchase) }, ...over,
});
const charge = (purchase = 'pur_1') => ({ id: `ch_${purchase}`, amount: 3000, amount_refunded: 3000, refunded: true, metadata: OURS(purchase) });

async function seedPurchase(id: string, mode: 'one_time' | 'recurring', subjects: string[] = ['kid-a', 'kid-b', 'kid-c'], over: Record<string, unknown> = {}) {
  await env.DB.prepare(
    `INSERT INTO app_purchases (id, app_id, product_key, buyer_user_id, subjects, quantity, mode, status, interval_unit, interval_count, grace_days, created_at, updated_at)
     VALUES (?, 'club', 'child_term', 'gh:2', ?, ?, ?, 'pending', 'month', 3, 5, 1, 1)`,
  ).bind(id, JSON.stringify(subjects), Math.max(1, subjects.length), mode).run();
  void over;
}
const entitlements = async () => (await env.DB.prepare("SELECT subject, status, period_start, period_end, grace_until, renews, version, purchase_id FROM app_entitlements WHERE app_id = 'club' ORDER BY subject").all<Record<string, unknown>>()).results ?? [];
const count = async (table: string) => (await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first<{ n: number }>())!.n;
const handle = (e: unknown, now = at('2026-01-11T00:00:00Z')) => handleAppBillingEvent(env.DB, e, now);

async function signedPost(payload: string, secret = 'whsec_runtime'): Promise<Response> {
  const t = Math.floor(Date.now() / 1000);
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${t}.${payload}`)));
  const v1 = [...mac].map((b) => b.toString(16).padStart(2, '0')).join('');
  return SELF.fetch('https://api.test/webhooks/stripe', { method: 'POST', headers: { 'stripe-signature': `t=${t},v1=${v1}`, 'Content-Type': 'application/json' }, body: payload });
}

beforeEach(async () => {
  for (const t of ['app_billing_events', 'app_billing_payments', 'app_billing_payment_refs', 'app_entitlements', 'app_purchases', 'subscriptions']) await env.DB.prepare(`DELETE FROM ${t}`).run();
});

describe('a one-off purchase for three subjects', () => {
  it('creates exactly three entitlements, each one term from the payment, and records the payment once', async () => {
    await seedPurchase('pur_1', 'one_time');
    expect(await handle(evt('checkout.session.completed', T0, session('payment')))).toEqual({ handled: true, purchaseId: 'pur_1' });
    const rows = await entitlements();
    expect(rows).toHaveLength(3);
    for (const r of rows) expect(r).toMatchObject({ status: 'active', period_start: at(T0), period_end: at('2026-04-10T00:00:00Z'), grace_until: null, renews: 0, purchase_id: 'pur_1', version: 1 });
    expect(rows.map((r) => r.subject)).toEqual(['kid-a', 'kid-b', 'kid-c']);
    expect(await count('app_billing_payments')).toBe(1);
    expect((await env.DB.prepare("SELECT status FROM app_purchases WHERE id = 'pur_1'").first<{ status: string }>())?.status).toBe('paid');
    expect((await env.DB.prepare("SELECT purchase_id FROM app_billing_payment_refs WHERE ref = 'pi_pur_1'").first<{ purchase_id: string }>())?.purchase_id).toBe('pur_1');
  });

  it('replaying the event changes nothing', async () => {
    await seedPurchase('pur_1', 'one_time');
    const e = evt('checkout.session.completed', T0, session('payment'));
    await handle(e);
    const before = await entitlements();
    expect(await handle(e)).toEqual({ handled: true, purchaseId: 'pur_1', duplicate: true });
    expect(await entitlements()).toEqual(before);
    expect(await count('app_billing_payments')).toBe(1);
    expect(await count('app_billing_events')).toBe(1);
  });

  it('a product with no subject is one entitlement under the empty subject', async () => {
    await seedPurchase('pur_1', 'one_time', []);
    await handle(evt('checkout.session.completed', T0, session('payment')));
    expect(await entitlements()).toMatchObject([{ subject: '', status: 'active' }]);
  });

  it('an unpaid session records nothing', async () => {
    await seedPurchase('pur_1', 'one_time');
    expect(await handle(evt('checkout.session.completed', T0, session('payment', { payment_status: 'unpaid' })))).toEqual({ handled: false, purchaseId: null });
    expect(await entitlements()).toEqual([]);
  });
});

describe('a subscription', () => {
  it('is entitled by its paid invoices, and the order of checkout and first invoice does not matter', async () => {
    // Two purchases on different subjects, so neither buys time for the other. A: checkout, then invoice. B: invoice, then checkout.
    await seedPurchase('pur_a', 'recurring', ['a1', 'a2', 'a3']);
    await seedPurchase('pur_b', 'recurring', ['b1', 'b2', 'b3']);
    await handle(evt('checkout.session.completed', T0, session('subscription', {}, 'pur_a')));
    expect(await entitlements()).toEqual([]); // a subscription is entitled by its invoices, not by the session
    await handle(evt('invoice.paid', T0, invoice('in_a1', 'pur_a')));
    await handle(evt('invoice.paid', T0, invoice('in_b1', 'pur_b')));
    await handle(evt('checkout.session.completed', T0, session('subscription', {}, 'pur_b')));

    const rows = await entitlements();
    expect(rows).toHaveLength(6);
    const shape = (prefix: string) => rows.filter((r) => String(r.subject).startsWith(prefix)).map(({ subject: _s, purchase_id: _p, ...r }) => r);
    expect(shape('b')).toEqual(shape('a'));
    expect(shape('a')[0]).toMatchObject({ status: 'active', renews: 1, period_end: at('2026-04-10T00:00:00Z') });
  });

  it('a renewal extends all three subjects from their previous period_end, not the payment date', async () => {
    await seedPurchase('pur_1', 'recurring');
    await handle(evt('invoice.paid', T0, invoice('in_1')));
    await handle(evt('invoice.paid', '2026-04-05T00:00:00Z', invoice('in_2')), at('2026-04-06T00:00:00Z')); // five days early
    const rows = await entitlements();
    expect(rows).toHaveLength(3);
    for (const r of rows) expect(r).toMatchObject({ status: 'active', period_end: at('2026-07-10T00:00:00Z'), version: 2 });
  });

  it('the same invoice reported by invoice.paid and invoice.payment_succeeded is one payment', async () => {
    await seedPurchase('pur_1', 'recurring');
    await handle(evt('invoice.payment_succeeded', '2026-01-10T00:00:07Z', invoice('in_1')));
    await handle(evt('invoice.paid', T0, invoice('in_1')));
    expect(await count('app_billing_payments')).toBe(1);
    expect((await env.DB.prepare("SELECT paid_at FROM app_billing_payments WHERE id = 'in:in_1'").first<{ paid_at: number }>())?.paid_at).toBe(at(T0)); // the earlier event time, either order
    expect((await entitlements())[0]).toMatchObject({ period_end: at('2026-04-10T00:00:00Z') });
  });

  it('a failed renewal is grace until period_end + grace days, then expired', async () => {
    await seedPurchase('pur_1', 'recurring');
    await handle(evt('invoice.paid', T0, invoice('in_1')));
    await handle(evt('invoice.payment_failed', '2026-04-10T01:00:00Z', invoice('in_2')), at('2026-04-11T00:00:00Z'));
    for (const r of await entitlements()) expect(r).toMatchObject({ status: 'grace', grace_until: at('2026-04-15T00:00:00Z'), period_end: at('2026-04-10T00:00:00Z') });
    // The sweep (a later step) recomputes with the clock; the same facts at a later time are expired.
    const { recomputePurchase } = await import('../../../backend/src/lib/entitlement-store');
    await recomputePurchase(env.DB, 'pur_1', at('2026-04-15T00:00:00Z'));
    for (const r of await entitlements()) expect(r.status).toBe('expired');
  });

  it('a payment after the failure clears it and extends from the old period_end', async () => {
    await seedPurchase('pur_1', 'recurring');
    await handle(evt('invoice.paid', T0, invoice('in_1')));
    await handle(evt('invoice.payment_failed', '2026-04-10T01:00:00Z', invoice('in_2')), at('2026-04-11T00:00:00Z'));
    await handle(evt('invoice.paid', '2026-04-12T00:00:00Z', invoice('in_2')), at('2026-04-12T01:00:00Z'));
    for (const r of await entitlements()) expect(r).toMatchObject({ status: 'active', grace_until: null, period_start: at('2026-04-12T00:00:00Z'), period_end: at('2026-07-12T00:00:00Z') });
  });

  it('cancellation ends the subscription: canceled, and not renewing', async () => {
    await seedPurchase('pur_1', 'recurring');
    await handle(evt('invoice.paid', T0, invoice('in_1')));
    await handle(evt('customer.subscription.deleted', '2026-02-01T00:00:00Z', { id: 'sub_pur_1', status: 'canceled', metadata: OURS() }), at('2026-02-02T00:00:00Z'));
    for (const r of await entitlements()) expect(r).toMatchObject({ status: 'canceled', renews: 0 });
  });
});

describe('cancel at period end (#508)', () => {
  const updated = (created: string, cancel: boolean, status = 'active') => evt('customer.subscription.updated', created, { id: 'sub_pur_1', status, cancel_at_period_end: cancel, metadata: OURS() });

  it('stops renewal but keeps the paid period, then expires at period_end with no slack', async () => {
    await seedPurchase('pur_1', 'recurring');
    await handle(evt('invoice.paid', T0, invoice('in_1')));
    await handle(updated('2026-02-01T00:00:00Z', true), at('2026-02-02T00:00:00Z'));
    for (const r of await entitlements()) expect(r).toMatchObject({ status: 'active', renews: 0, period_end: at('2026-04-10T00:00:00Z') });
    const { recomputePurchase } = await import('../../../backend/src/lib/entitlement-store');
    await recomputePurchase(env.DB, 'pur_1', at('2026-04-10T00:00:00Z'));
    for (const r of await entitlements()) expect(r.status).toBe('expired'); // a renewing subscription would still be inside its three-day slack
  });

  it('switching it off again restores renewal', async () => {
    await seedPurchase('pur_1', 'recurring');
    await handle(evt('invoice.paid', T0, invoice('in_1')));
    await handle(updated('2026-02-01T00:00:00Z', true), at('2026-02-02T00:00:00Z'));
    await handle(updated('2026-02-03T00:00:00Z', false), at('2026-02-04T00:00:00Z'));
    for (const r of await entitlements()) expect(r).toMatchObject({ status: 'active', renews: 1 });
  });

  it('an older event never undoes a newer one, whatever order they arrive in', async () => {
    await seedPurchase('pur_1', 'recurring');
    await handle(evt('invoice.paid', T0, invoice('in_1')));
    await handle(updated('2026-02-03T00:00:00Z', true), at('2026-02-04T00:00:00Z')); // newer: cancel
    await handle(updated('2026-02-01T00:00:00Z', false), at('2026-02-05T00:00:00Z')); // older: not cancelling, arrives late
    for (const r of await entitlements()) expect(r).toMatchObject({ status: 'active', renews: 0 });
  });

  it('replaying the event changes nothing', async () => {
    await seedPurchase('pur_1', 'recurring');
    await handle(evt('invoice.paid', T0, invoice('in_1')));
    const e = updated('2026-02-01T00:00:00Z', true);
    await handle(e, at('2026-02-02T00:00:00Z'));
    const before = await entitlements();
    expect(await handle(e, at('2026-02-02T00:00:01Z'))).toMatchObject({ duplicate: true });
    expect(await entitlements()).toEqual(before);
  });

  it('an ended status is final even if it arrives before the last invoice', async () => {
    await seedPurchase('pur_1', 'recurring');
    await handle(updated('2026-02-01T00:00:00Z', false, 'canceled'), at('2026-02-02T00:00:00Z'));
    await handle(evt('invoice.paid', T0, invoice('in_1')), at('2026-02-03T00:00:00Z'));
    for (const r of await entitlements()) expect(r).toMatchObject({ status: 'canceled', renews: 0 });
  });
});

describe('refund', () => {
  it('a full refund makes every subject refunded at once, with time still on the clock', async () => {
    await seedPurchase('pur_1', 'one_time');
    await handle(evt('checkout.session.completed', T0, session('payment')));
    await handle(evt('charge.refunded', '2026-01-12T00:00:00Z', charge()), at('2026-01-12T00:00:01Z'));
    const rows = await entitlements();
    expect(rows).toHaveLength(3);
    for (const r of rows) expect(r).toMatchObject({ status: 'refunded', period_end: null });
  });

  it('a refund delivered before its payment ends in the same state', async () => {
    await seedPurchase('pur_1', 'one_time');
    await handle(evt('charge.refunded', '2026-01-12T00:00:00Z', charge()), at('2026-01-12T00:00:01Z'));
    await handle(evt('checkout.session.completed', T0, session('payment')), at('2026-01-12T00:00:02Z'));
    const rows = await entitlements();
    expect(rows).toHaveLength(3);
    for (const r of rows) expect(r.status).toBe('refunded');
  });

  it('a partial refund changes nothing', async () => {
    await seedPurchase('pur_1', 'one_time');
    await handle(evt('checkout.session.completed', T0, session('payment')));
    const before = await entitlements();
    await handle(evt('charge.refunded', '2026-01-12T00:00:00Z', { ...charge(), refunded: false, amount_refunded: 500 }));
    expect(await entitlements()).toEqual(before);
  });
});

describe('what is ignored', () => {
  it('an event for a purchase that does not exist, or that names another app, is acknowledged and writes nothing', async () => {
    await seedPurchase('pur_1', 'one_time');
    expect(await handle(evt('checkout.session.completed', T0, session('payment', {}, 'pur_missing')))).toEqual({ handled: false, purchaseId: null });
    expect(await handle(evt('checkout.session.completed', T0, session('payment', { metadata: { ...OURS(), app_id: 'other' } })))).toEqual({ handled: false, purchaseId: null });
    expect(await entitlements()).toEqual([]);
    expect(await count('app_billing_events')).toBe(0);
  });

  it('an event with no app_id is not this handler\'s', async () => {
    expect(await handle(evt('customer.subscription.deleted', T0, { id: 'sub_pro', metadata: {} }))).toEqual({ handled: false, purchaseId: null });
  });
});

describe('the webhook route (#508)', () => {
  const proCheckout = () => evt('checkout.session.completed', T0, { id: 'cs_pro', mode: 'subscription', customer: 'cus_pro', subscription: 'sub_pro', metadata: { user_id: 'gh:9' } });

  it('refuses an unsigned or tampered payload and writes nothing', async () => {
    await seedPurchase('pur_1', 'one_time');
    const payload = JSON.stringify(evt('checkout.session.completed', T0, session('payment')));
    expect((await SELF.fetch('https://api.test/webhooks/stripe', { method: 'POST', body: payload })).status).toBe(400);
    expect((await signedPost(payload, 'whsec_wrong')).status).toBe(401);
    const tampered = await signedPost(payload);
    expect(tampered.status).toBe(200); // the control: the untampered, correctly signed payload is accepted
    await env.DB.prepare('DELETE FROM app_entitlements').run();
    await env.DB.prepare('DELETE FROM app_billing_events').run();
    await env.DB.prepare('DELETE FROM app_billing_payments').run();
    // A signature over different bytes does not cover this payload.
    const t = Math.floor(Date.now() / 1000);
    const key = await crypto.subtle.importKey('raw', new TextEncoder().encode('whsec_runtime'), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${t}.${payload}`)));
    const v1 = [...mac].map((b) => b.toString(16).padStart(2, '0')).join('');
    const res = await SELF.fetch('https://api.test/webhooks/stripe', { method: 'POST', headers: { 'stripe-signature': `t=${t},v1=${v1}` }, body: payload.replace('3000', '1') });
    expect(res.status).toBe(401);
    expect(await entitlements()).toEqual([]);
  });

  it('routes a signed app event to the entitlements', async () => {
    await seedPurchase('pur_1', 'one_time');
    expect((await signedPost(JSON.stringify(evt('checkout.session.completed', T0, session('payment'))))).status).toBe(200);
    expect(await entitlements()).toHaveLength(3);
  });

  it('an app purchase never becomes a Pro upgrade, even with a user_id and a subscription', async () => {
    await seedPurchase('pur_1', 'recurring');
    expect((await signedPost(JSON.stringify(evt('checkout.session.completed', T0, session('subscription'))))).status).toBe(200);
    expect(await count('subscriptions')).toBe(0);
  });

  it('an app event the entitlements ignore (an unpaid session) still cannot reach the Pro handler', async () => {
    await seedPurchase('pur_1', 'recurring');
    expect((await signedPost(JSON.stringify(evt('checkout.session.completed', T0, session('subscription', { payment_status: 'unpaid' }))))).status).toBe(200);
    expect(await count('subscriptions')).toBe(0);
    expect(await entitlements()).toEqual([]);
  });

  it('the Pro flow is unchanged: an event with no app_id still activates Pro', async () => {
    expect((await signedPost(JSON.stringify(proCheckout()))).status).toBe(200);
    expect(await env.DB.prepare("SELECT tier, status FROM subscriptions WHERE user_id = 'gh:9'").first()).toEqual({ tier: 'pro', status: 'active' });
  });
});
