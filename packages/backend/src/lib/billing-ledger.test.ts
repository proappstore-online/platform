import { afterEach, describe, expect, it, vi } from 'vitest';
import { sqliteD1 } from '../sqlite-d1.js';
import { appLedger, fillChargeFees, recordChargeEvent } from './billing-ledger.js';

// #509: the revenue ledger. A charge is stored by id as Stripe sent it and tied to a purchase at READ time through the ids the purchase
// recorded, so the answer does not depend on which event arrived first. Real SQL on in-memory SQLite.

afterEach(() => vi.unstubAllGlobals());

const charge = (type: string, over: Record<string, unknown> = {}, id = 'evt_1') => ({
  id, type, data: { object: { id: 'ch_1', amount: 2000, currency: 'AUD', amount_refunded: 0, payment_intent: 'pi_1', invoice: null, balance_transaction: 'txn_1', ...over } },
});

async function setup() {
  const db = sqliteD1();
  await db.prepare("INSERT INTO app_purchases (id, app_id, product_key, buyer_user_id, subjects, quantity, mode, status, created_at, updated_at) VALUES ('pur_1', 'club', 'term', 'gh:2', '[\"kid\"]', 1, 'one_time', 'paid', 10, 10)").run();
  await db.prepare("INSERT INTO app_billing_payments (id, purchase_id, paid_at, amount, currency, created_at) VALUES ('purchase:pur_1', 'pur_1', 5, 2000, 'aud', 5)").run();
  await db.prepare("INSERT INTO app_billing_payment_refs (ref, purchase_id) VALUES ('pi_1', 'pur_1')").run();
  return db;
}

describe('recordChargeEvent', () => {
  it('ignores anything that is not a usable charge event', async () => {
    const db = await setup();
    for (const e of [null, 'x', {}, { type: 'invoice.paid' }, { type: 'charge.succeeded' }, { type: 'charge.succeeded', data: { object: { id: 'ch', amount: 1 } } }, { type: 'charge.succeeded', data: { object: { amount: 1, currency: 'aud' } } }]) {
      expect(await recordChargeEvent(db, e)).toBe(false);
    }
    expect((await db.prepare('SELECT COUNT(*) AS n FROM app_billing_charges').first<{ n: number }>())!.n).toBe(0);
  });

  it('stores a charge once, lower-cases its currency, and only ever raises the refund total', async () => {
    const db = await setup();
    expect(await recordChargeEvent(db, charge('charge.succeeded'))).toBe(true);
    await recordChargeEvent(db, charge('charge.refunded', { amount_refunded: 800 }));
    await recordChargeEvent(db, charge('charge.updated', { amount_refunded: 300 }));
    await recordChargeEvent(db, charge('charge.refunded', { amount_refunded: 800 }));
    const rows = (await db.prepare('SELECT * FROM app_billing_charges').all<Record<string, unknown>>()).results;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ charge_id: 'ch_1', currency: 'aud', amount: 2000, amount_refunded: 800, payment_intent: 'pi_1', balance_transaction: 'txn_1', fee: null });
  });

  it('reads expanded ids, keeps the first non-null ones, and treats junk amounts as zero', async () => {
    const db = await setup();
    await recordChargeEvent(db, charge('charge.succeeded', { payment_intent: { id: 'pi_1' }, balance_transaction: null, amount_refunded: -5, amount: 'x' }));
    await recordChargeEvent(db, charge('charge.updated', { payment_intent: null, invoice: { id: 'in_1' }, balance_transaction: { id: 'txn_9' } }));
    expect((await db.prepare('SELECT payment_intent, invoice, balance_transaction, amount, amount_refunded FROM app_billing_charges').first<Record<string, unknown>>())).toEqual({
      payment_intent: 'pi_1', invoice: 'in_1', balance_transaction: 'txn_9', amount: 0, amount_refunded: 0,
    });
  });
});

describe('fillChargeFees', () => {
  const stripeReplies = (reply: () => Response) => { const f = vi.fn(async () => reply()); vi.stubGlobal('fetch', f); return f; };

  it('does nothing without a Stripe key', async () => {
    const db = await setup();
    expect(await fillChargeFees({ DB: db, STRIPE_SECRET_KEY: '' } as never)).toBe(0);
  });

  it('reads the fee of a charge that belongs to an app purchase, once', async () => {
    const db = await setup();
    await recordChargeEvent(db, charge('charge.succeeded'));
    const f = stripeReplies(() => new Response(JSON.stringify({ id: 'txn_1', fee: 88.4, currency: 'aud' }), { status: 200 }));
    expect(await fillChargeFees({ DB: db, STRIPE_SECRET_KEY: 'sk_test' } as never)).toBe(1);
    expect(String(f.mock.calls[0]![0])).toBe('https://api.stripe.com/v1/balance_transactions/txn_1');
    expect(await db.prepare('SELECT fee, fee_currency FROM app_billing_charges').first()).toEqual({ fee: 88, fee_currency: 'aud' });
    expect(await fillChargeFees({ DB: db, STRIPE_SECRET_KEY: 'sk_test' } as never)).toBe(0);
    expect(f).toHaveBeenCalledTimes(1);
  });

  it('never looks up a charge that is not an app purchase\'s, and leaves a failed lookup for the next tick', async () => {
    const db = await setup();
    await recordChargeEvent(db, charge('charge.succeeded', { id: 'ch_pro', payment_intent: 'pi_pro', balance_transaction: 'txn_pro' }));
    const f = stripeReplies(() => new Response('{}', { status: 200 }));
    expect(await fillChargeFees({ DB: db, STRIPE_SECRET_KEY: 'sk_test' } as never)).toBe(0);
    expect(f).not.toHaveBeenCalled();

    await recordChargeEvent(db, charge('charge.succeeded'));
    stripeReplies(() => new Response('{"error":{}}', { status: 500 }));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect(await fillChargeFees({ DB: db, STRIPE_SECRET_KEY: 'sk_test' } as never)).toBe(0);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
    expect((await db.prepare("SELECT fee FROM app_billing_charges WHERE charge_id = 'ch_1'").first<{ fee: number | null }>())!.fee).toBeNull();
  });
});

describe('appLedger', () => {
  it('shows gross, refunds, fee and net per paid purchase, with totals by currency', async () => {
    const db = await setup();
    await db.prepare("UPDATE app_billing_charges SET fee = 1").run();
    await recordChargeEvent(db, charge('charge.refunded', { amount_refunded: 500 }));
    await db.prepare("UPDATE app_billing_charges SET fee = 88, fee_currency = 'aud'").run();
    await db.prepare("INSERT INTO app_purchases (id, app_id, product_key, buyer_user_id, subjects, quantity, mode, status, created_at, updated_at) VALUES ('pur_2', 'club', 'term', 'gh:3', '[]', 1, 'one_time', 'paid', 20, 20), ('pur_pending', 'club', 'term', 'gh:4', '[]', 1, 'one_time', 'pending', 30, 30), ('pur_other', 'other', 'term', 'gh:5', '[]', 1, 'one_time', 'paid', 40, 40)").run();
    await db.prepare("INSERT INTO app_billing_payments (id, purchase_id, paid_at, amount, currency, created_at) VALUES ('purchase:pur_2', 'pur_2', 6, 1000, 'aud', 6), ('purchase:pur_other', 'pur_other', 7, 9000, 'aud', 7)").run();
    const ledger = await appLedger(db, 'club');
    expect(ledger.purchases.map((p) => p.purchaseId)).toEqual(['pur_2', 'pur_1']);
    expect(ledger.purchases[1]).toMatchObject({ product: 'term', buyerUserId: 'gh:2', subjects: ['kid'], gross: 2000, refunded: 500, fee: 88, feeCurrency: 'aud', net: 1412, currency: 'aud', status: 'paid' });
    expect(ledger.purchases[0]).toMatchObject({ gross: 1000, refunded: 0, fee: null, net: 1000 });
    expect(ledger.totals).toEqual([{ currency: 'aud', gross: 3000, refunded: 500, fee: 88, net: 2412 }]);
  });

  it('is empty for an app with no paid purchase', async () => {
    expect(await appLedger(await setup(), 'nobody')).toEqual({ purchases: [], totals: [] });
  });
});
