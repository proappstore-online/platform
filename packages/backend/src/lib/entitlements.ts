/**
 * The entitlement rules (#508, epic #506), as one pure function.
 *
 * An entitlement is NOT updated by events. Events record facts (a payment of a given id at a given time, a failed attempt,
 * a refund, the subscription's end or cancel-at-period-end) and the entitlement is recomputed from ALL the facts of a
 * (app, product, subject) every time. So replaying an event changes nothing, and delivering events in any order ends in the
 * same state: the order they arrived in is not an input.
 *
 * Time. A payment buys one interval, starting where the previous paid time ends (a renewal extends from the previous
 * `period_end`, not from the payment date) or at the payment if the entitlement had lapsed. Payments are folded in the order
 * they were MADE, not the order their events arrived.
 *
 * Status, by priority:
 *   refunded  every payment was fully refunded (immediately, whatever the clock says)
 *   canceled  every purchase that paid is a subscription that has ended
 *   grace     a renewal payment failed and nothing paid since: until period_end + grace_days
 *   active    inside the paid period; or a renewing subscription just past it, awaiting Stripe (see SUBSCRIPTION_SLACK_MS)
 *   expired   anything else once its time has passed
 */

export const DAY_MS = 86_400_000;
/**
 * A renewing subscription's invoice is created at period end and charged shortly after: Stripe sends `invoice.paid` or
 * `invoice.payment_failed`, not a clock tick. Past `period_end` with no failure and no cancellation, the entitlement stays
 * active for this long awaiting that event, then expires (dunning exhausted, or an event we never received).
 */
export const SUBSCRIPTION_SLACK_MS = 3 * DAY_MS;

export type EntitlementStatus = 'active' | 'grace' | 'expired' | 'refunded' | 'canceled';

export interface Terms {
  intervalUnit: string | null;
  intervalCount: number | null;
  graceDays: number;
}

export interface PurchaseFacts {
  id: string;
  mode: 'one_time' | 'recurring';
  buyerUserId: string;
  createdAt: number;
  terms: Terms;
  /** Payments that bought time, in ms. */
  payments: { id: string; paidAt: number }[];
  failedAt: number | null;
  refundedAt: number | null;
  cancelAtPeriodEnd: boolean;
  endedAt: number | null;
}

export interface Entitlement {
  status: EntitlementStatus;
  periodStart: number | null;
  periodEnd: number | null;
  graceUntil: number | null;
  renews: boolean;
  buyerUserId: string;
  purchaseId: string;
}

/** `ts` plus `count` units, calendar-aware for months and years (UTC), clamping the day (Jan 31 + 1 month = Feb 28/29). */
export function addInterval(ts: number, unit: string, count: number): number {
  const d = new Date(ts);
  switch (unit) {
    case 'day': return ts + count * DAY_MS;
    case 'week': return ts + count * 7 * DAY_MS;
    case 'month':
    case 'year': {
      const months = unit === 'year' ? count * 12 : count;
      const day = d.getUTCDate();
      const target = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + months, 1, d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds(), d.getUTCMilliseconds()));
      const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
      target.setUTCDate(Math.min(day, lastDay));
      return target.getTime();
    }
    default: throw new Error(`unknown interval unit ${unit}`);
  }
}

export function computeEntitlement(purchases: PurchaseFacts[], now: number): Entitlement | null {
  const live = purchases.filter((p) => p.refundedAt === null);
  const refunded = purchases.filter((p) => p.refundedAt !== null);

  // One payment is one id: a duplicate (a replayed event reaching this layer) buys no extra time.
  const seen = new Set<string>();
  const payments = live
    .flatMap((p) => p.payments.map((pay) => ({ ...pay, purchase: p })))
    .filter((pay) => (seen.has(pay.id) ? false : (seen.add(pay.id), true)))
    .sort((a, b) => a.paidAt - b.paidAt || (a.id < b.id ? -1 : 1));

  if (payments.length === 0) {
    // Nothing paid is left. A refund with no live payment is a refunded entitlement (even if its payment event is still to come).
    const last = [...refunded].sort((a, b) => (b.refundedAt ?? 0) - (a.refundedAt ?? 0))[0];
    if (!last) return null;
    return { status: 'refunded', periodStart: null, periodEnd: null, graceUntil: null, renews: false, buyerUserId: last.buyerUserId, purchaseId: last.id };
  }

  let periodStart: number | null = null;
  let periodEnd: number | null = null;
  let lifetime = false;
  for (const pay of payments) {
    const { intervalUnit, intervalCount } = pay.purchase.terms;
    if (!intervalUnit || !intervalCount) { lifetime = true; periodEnd = null; periodStart = pay.paidAt; continue; }
    const base = periodEnd !== null && periodEnd > pay.paidAt ? periodEnd : pay.paidAt;
    periodStart = base;
    periodEnd = addInterval(base, intervalUnit, intervalCount);
    lifetime = false;
  }
  const latest = payments[payments.length - 1]!.purchase;
  const paying = [...new Map(payments.map((p) => [p.purchase.id, p.purchase])).values()];

  const renewing = live.filter((p) => p.mode === 'recurring' && p.endedAt === null && !p.cancelAtPeriodEnd);
  const renews = renewing.length > 0;
  const base = { periodStart, periodEnd, renews, buyerUserId: latest.buyerUserId, purchaseId: latest.id };

  if (paying.every((p) => p.mode === 'recurring' && p.endedAt !== null)) return { ...base, status: 'canceled', graceUntil: null, renews: false };

  // A failure no later payment has resolved: a payment made after it (by the Stripe clock) clears it.
  const failing = live.find((p) => {
    if (p.mode !== 'recurring' || p.endedAt !== null || p.failedAt === null) return false;
    const lastPaid = p.payments.reduce((m, pay) => Math.max(m, pay.paidAt), 0);
    return p.failedAt > lastPaid;
  });
  if (failing) {
    const graceUntil = (periodEnd ?? now) + failing.terms.graceDays * DAY_MS;
    return { ...base, status: now < graceUntil ? 'grace' : 'expired', graceUntil };
  }

  if (lifetime || periodEnd === null || now < periodEnd) return { ...base, status: 'active', graceUntil: null };
  if (renews && now < periodEnd + SUBSCRIPTION_SLACK_MS) return { ...base, status: 'active', graceUntil: null };
  return { ...base, status: 'expired', graceUntil: null };
}
