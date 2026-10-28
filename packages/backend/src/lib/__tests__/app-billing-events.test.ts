import { describe, expect, it } from 'vitest';
import { parseAppBillingEvent } from '../app-billing-events.js';

// #508: Stripe-shaped events, as plain objects, through the parser. No database and no Stripe client.

const OURS = { app_id: 'club', user_id: 'gh:2', purchase_id: 'pur_1' };
const event = (type: string, object: Record<string, unknown>, id = 'evt_1') => ({ id, type, created: 1_800_000_000, data: { object } });

const session = (over: Record<string, unknown> = {}) => ({
  id: 'cs_1', object: 'checkout.session', mode: 'payment', payment_status: 'paid', amount_total: 2000, currency: 'aud',
  payment_intent: 'pi_1', subscription: null, customer: 'cus_1', metadata: OURS, ...over,
});
const invoice = (over: Record<string, unknown> = {}) => ({
  id: 'in_1', object: 'invoice', amount_paid: 1000, currency: 'aud', subscription: 'sub_1',
  lines: { data: [{ period: { start: 1_800_000_000, end: 1_807_776_000 } }] },
  subscription_details: { metadata: OURS }, ...over,
});

describe('purchase (checkout.session.completed)', () => {
  it('a one-off payment', () => {
    expect(parseAppBillingEvent(event('checkout.session.completed', session()))).toEqual({
      kind: 'purchase', appId: 'club', userId: 'gh:2', purchaseId: 'pur_1', amount: 2000, currency: 'aud',
      stripePaymentIntentId: 'pi_1', stripeSubscriptionId: null, productType: 'one_time', intervalMonths: null, eventId: 'evt_1',
    });
  });

  it('a subscription', () => {
    expect(parseAppBillingEvent(event('checkout.session.completed', session({ mode: 'subscription', payment_intent: null, subscription: 'sub_1' })))).toMatchObject({
      kind: 'purchase', productType: 'subscription', stripeSubscriptionId: 'sub_1', stripePaymentIntentId: null,
    });
  });

  it('reads an expanded payment intent or subscription as its id', () => {
    expect(parseAppBillingEvent(event('checkout.session.completed', session({ payment_intent: { id: 'pi_9' } })))).toMatchObject({ stripePaymentIntentId: 'pi_9' });
  });

  it('is unrelated until the session is paid', () => {
    expect(parseAppBillingEvent(event('checkout.session.completed', session({ payment_status: 'unpaid' })))).toEqual({ kind: 'unrelated' });
  });

  it('is unrelated without a purchase id: there is nothing to attach it to', () => {
    expect(parseAppBillingEvent(event('checkout.session.completed', session({ metadata: { app_id: 'club' } })))).toEqual({ kind: 'unrelated' });
  });
});

describe('renewal (invoice.paid, invoice.payment_succeeded)', () => {
  it('names the invoice, the subscription and the end of the period it paid for, in ms', () => {
    const expected = {
      kind: 'renewal', appId: 'club', userId: 'gh:2', purchaseId: 'pur_1', amount: 1000, currency: 'aud',
      stripeInvoiceId: 'in_1', stripeSubscriptionId: 'sub_1', periodEnd: 1_807_776_000_000, eventId: 'evt_1',
    };
    expect(parseAppBillingEvent(event('invoice.paid', invoice()))).toEqual(expected);
    expect(parseAppBillingEvent(event('invoice.payment_succeeded', invoice()))).toEqual(expected);
  });

  it("reads the newer API's shape, where the subscription and its metadata sit under parent.subscription_details", () => {
    const newer = invoice({ subscription: undefined, subscription_details: undefined, parent: { subscription_details: { subscription: 'sub_2', metadata: OURS } } });
    expect(parseAppBillingEvent(event('invoice.paid', newer))).toMatchObject({ kind: 'renewal', stripeSubscriptionId: 'sub_2', purchaseId: 'pur_1' });
  });

  it('has period end 0 when the invoice carries no line period', () => {
    expect(parseAppBillingEvent(event('invoice.paid', invoice({ lines: { data: [] } })))).toMatchObject({ kind: 'renewal', periodEnd: 0 });
  });

  it('is unrelated without a subscription', () => {
    expect(parseAppBillingEvent(event('invoice.paid', invoice({ subscription: null, subscription_details: { metadata: OURS } })))).toEqual({ kind: 'unrelated' });
  });
});

describe('payment_failed (invoice.payment_failed)', () => {
  it('names the subscription whose renewal failed', () => {
    expect(parseAppBillingEvent(event('invoice.payment_failed', invoice()))).toEqual({
      kind: 'payment_failed', appId: 'club', userId: 'gh:2', purchaseId: 'pur_1', stripeSubscriptionId: 'sub_1', eventId: 'evt_1',
    });
  });
});

describe('cancelled (customer.subscription.deleted)', () => {
  it('names the subscription that ended', () => {
    expect(parseAppBillingEvent(event('customer.subscription.deleted', { id: 'sub_1', object: 'subscription', status: 'canceled', metadata: OURS }))).toEqual({
      kind: 'cancelled', appId: 'club', userId: 'gh:2', purchaseId: 'pur_1', stripeSubscriptionId: 'sub_1', eventId: 'evt_1',
    });
  });
});

describe('refunded (charge.refunded)', () => {
  const charge = (over: Record<string, unknown> = {}) => ({ id: 'ch_1', object: 'charge', amount: 2000, amount_refunded: 2000, refunded: true, metadata: OURS, ...over });

  it('a full refund', () => {
    expect(parseAppBillingEvent(event('charge.refunded', charge()))).toEqual({
      kind: 'refunded', appId: 'club', userId: 'gh:2', purchaseId: 'pur_1', stripeChargeId: 'ch_1', eventId: 'evt_1',
    });
  });

  it('a full refund is recognised by the amounts too', () => {
    expect(parseAppBillingEvent(event('charge.refunded', charge({ refunded: false })))).toMatchObject({ kind: 'refunded' });
  });

  it('a partial refund changes no entitlement: it names no subject', () => {
    expect(parseAppBillingEvent(event('charge.refunded', charge({ refunded: false, amount_refunded: 500 })))).toEqual({ kind: 'unrelated' });
  });
});

describe('unrelated', () => {
  it('a Pro subscription event, with no app_id, stays on the Pro path', () => {
    expect(parseAppBillingEvent(event('checkout.session.completed', session({ metadata: { user_id: 'gh:2' }, mode: 'subscription', subscription: 'sub_pro' })))).toEqual({ kind: 'unrelated' });
    expect(parseAppBillingEvent(event('customer.subscription.deleted', { id: 'sub_pro', metadata: {} }))).toEqual({ kind: 'unrelated' });
  });

  it('an event type this layer does not handle, even with our metadata', () => {
    expect(parseAppBillingEvent(event('customer.subscription.updated', { id: 'sub_1', metadata: OURS }))).toEqual({ kind: 'unrelated' });
    expect(parseAppBillingEvent(event('payment_intent.created', { id: 'pi_1', metadata: OURS }))).toEqual({ kind: 'unrelated' });
  });

  it('anything that is not an event object', () => {
    for (const junk of [null, undefined, 'evt', 42, [], {}, { id: 'evt_1' }, { id: 'evt_1', type: 'invoice.paid' }, { id: 'evt_1', type: 'invoice.paid', data: { object: null } }, { type: 'invoice.paid', data: { object: invoice() } }]) {
      expect(parseAppBillingEvent(junk)).toEqual({ kind: 'unrelated' });
    }
  });

  it('never throws on a malformed object', () => {
    expect(parseAppBillingEvent(event('invoice.paid', { id: 5, metadata: 'x', lines: 'y', subscription: { id: 7 } }))).toEqual({ kind: 'unrelated' });
  });
});
