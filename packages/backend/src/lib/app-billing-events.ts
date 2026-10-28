/**
 * Turn an already-verified Stripe event into one typed fact about an app purchase (#508, epic #506).
 *
 * Pure: no database, no Stripe client, no clock. An event with no `metadata.app_id` is `unrelated`, which is how the Pro
 * subscription events stay on their own path. Stripe moved an invoice's subscription and metadata between API versions, so
 * those are read from every place they have lived. Money is in the currency's smallest unit, times in milliseconds.
 */

export type AppBillingFact =
  | { kind: 'purchase'; appId: string; userId: string; purchaseId: string; amount: number; currency: string; stripePaymentIntentId: string | null; stripeSubscriptionId: string | null; productType: 'one_time' | 'subscription'; intervalMonths: number | null; eventId: string }
  | { kind: 'renewal'; appId: string; userId: string; purchaseId: string; amount: number; currency: string; stripeInvoiceId: string; stripeSubscriptionId: string; periodEnd: number; eventId: string }
  | { kind: 'payment_failed'; appId: string; userId: string; purchaseId: string; stripeSubscriptionId: string; eventId: string }
  | { kind: 'subscription_updated'; appId: string; userId: string; purchaseId: string; stripeSubscriptionId: string; cancelAtPeriodEnd: boolean; ended: boolean; eventId: string }
  | { kind: 'cancelled'; appId: string; userId: string; purchaseId: string; stripeSubscriptionId: string; eventId: string }
  | { kind: 'refunded'; appId: string; userId: string; purchaseId: string; stripeChargeId: string; eventId: string }
  | { kind: 'unrelated' };

type Obj = Record<string, unknown>;
const UNRELATED: AppBillingFact = { kind: 'unrelated' };

const asObj = (v: unknown): Obj | null => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : null);
const asStr = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);
const asNum = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
/** A Stripe reference that may arrive as an id or as an expanded object carrying one. */
const refOf = (v: unknown): string | null => asStr(v) ?? asStr(asObj(v)?.id);

/** Our metadata, from the object itself or from the subscription details an invoice carries. */
function ours(o: Obj): { appId: string; userId: string; purchaseId: string } | null {
  const details = [asObj(o.subscription_details), asObj(asObj(o.parent)?.subscription_details)];
  for (const m of [asObj(o.metadata), ...details.map((d) => asObj(d?.metadata))]) {
    const appId = asStr(m?.app_id);
    if (appId) return { appId, userId: asStr(m?.user_id) ?? '', purchaseId: asStr(m?.purchase_id) ?? '' };
  }
  return null;
}

function invoiceSubscription(o: Obj): string | null {
  return refOf(o.subscription) ?? refOf(asObj(asObj(o.parent)?.subscription_details)?.subscription) ?? refOf(asObj(o.subscription_details)?.subscription);
}

/** The end of the period the invoice paid for, from its first line; 0 when the event does not carry one. */
function invoicePeriodEnd(o: Obj): number {
  const line = asObj((asObj(o.lines)?.data as unknown[] | undefined)?.[0]);
  const end = asNum(asObj(line?.period)?.end);
  return end === null ? 0 : end * 1000;
}

/**
 * True when the event carries our `metadata.app_id`, whether or not it parses into a fact. Routing uses this, not the parse:
 * an app's unpaid session or partial refund is `unrelated` to the entitlements but must still never reach the Pro handler.
 */
export function eventCarriesAppId(event: unknown): boolean {
  const o = asObj(asObj(asObj(event)?.data)?.object);
  return !!o && ours(o) !== null;
}

export function parseAppBillingEvent(event: unknown): AppBillingFact {
  const e = asObj(event);
  const eventId = asStr(e?.id);
  const type = asStr(e?.type);
  const o = asObj(asObj(e?.data)?.object);
  if (!e || !eventId || !type || !o) return UNRELATED;
  const meta = ours(o);
  if (!meta) return UNRELATED;
  const base = { appId: meta.appId, userId: meta.userId, purchaseId: meta.purchaseId, eventId };

  switch (type) {
    case 'checkout.session.completed': {
      if (!meta.purchaseId || o.payment_status !== 'paid') return UNRELATED;
      const subscription = o.mode === 'subscription';
      // The interval is not on a Checkout session: the term was snapshotted on the purchase when checkout began.
      return { kind: 'purchase', ...base, amount: asNum(o.amount_total) ?? 0, currency: asStr(o.currency) ?? '', stripePaymentIntentId: refOf(o.payment_intent), stripeSubscriptionId: refOf(o.subscription), productType: subscription ? 'subscription' : 'one_time', intervalMonths: null };
    }
    case 'invoice.paid':
    case 'invoice.payment_succeeded': {
      const sub = invoiceSubscription(o);
      const invoiceId = asStr(o.id);
      if (!meta.purchaseId || !sub || !invoiceId) return UNRELATED;
      return { kind: 'renewal', ...base, amount: asNum(o.amount_paid) ?? 0, currency: asStr(o.currency) ?? '', stripeInvoiceId: invoiceId, stripeSubscriptionId: sub, periodEnd: invoicePeriodEnd(o) };
    }
    case 'invoice.payment_failed': {
      const sub = invoiceSubscription(o);
      return meta.purchaseId && sub ? { kind: 'payment_failed', ...base, stripeSubscriptionId: sub } : UNRELATED;
    }
    case 'customer.subscription.updated': {
      const sub = asStr(o.id);
      if (!meta.purchaseId || !sub) return UNRELATED;
      // `cancel_at_period_end` turning on stops renewal but keeps the paid period; turning off again restores it. An ended status is final.
      const ended = o.status === 'canceled' || o.status === 'incomplete_expired';
      return { kind: 'subscription_updated', ...base, stripeSubscriptionId: sub, cancelAtPeriodEnd: o.cancel_at_period_end === true, ended };
    }
    case 'customer.subscription.deleted': {
      const sub = asStr(o.id);
      return meta.purchaseId && sub ? { kind: 'cancelled', ...base, stripeSubscriptionId: sub } : UNRELATED;
    }
    case 'charge.refunded': {
      const charge = asStr(o.id);
      const amount = asNum(o.amount) ?? 0;
      // Only a full refund is a refund of the purchase: a partial one names no subject, so it changes no entitlement.
      const full = o.refunded === true || (amount > 0 && (asNum(o.amount_refunded) ?? 0) >= amount);
      return meta.purchaseId && charge && full ? { kind: 'refunded', ...base, stripeChargeId: charge } : UNRELATED;
    }
    default:
      return UNRELATED;
  }
}
