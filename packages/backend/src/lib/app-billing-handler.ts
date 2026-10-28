import { parseAppBillingEvent, type AppBillingFact } from './app-billing-events.js';
import { recomputePurchase } from './entitlement-store.js';

/**
 * Apply one verified Stripe event for an app purchase (#508, epic #506).
 *
 * The event is recorded by its id first, so a redelivery of a processed event does nothing; `processed_at` is set only after the
 * facts are written and the entitlements recomputed, so a half-applied event is retried, and every write here is safe to repeat.
 * Facts only ever move forward (a failure time takes the later, a refund or an end is kept once set), and a payment is one row
 * by its id. The entitlement is then a pure function of those rows (see entitlements.ts), so delivery order is not an input.
 */

export interface BillingHandled {
  /** The event was for an app purchase (it may still have been a duplicate). */
  handled: boolean;
  purchaseId: string | null;
  /** The event id had already been processed: nothing was written. */
  duplicate?: boolean;
}

interface RawEvent { id?: unknown; type?: unknown; created?: unknown }

const IGNORED: BillingHandled = { handled: false, purchaseId: null };

/** The event's own clock, in ms: the only time this layer trusts. */
const eventTime = (event: RawEvent, now: number): number => (typeof event.created === 'number' ? event.created * 1000 : now);

async function claimEvent(db: D1Database, eventId: string, type: string, appId: string, now: number): Promise<boolean> {
  await db.prepare('INSERT OR IGNORE INTO app_billing_events (event_id, type, app_id, received_at) VALUES (?, ?, ?, ?)').bind(eventId, type, appId, now).run();
  const row = await db.prepare('SELECT processed_at FROM app_billing_events WHERE event_id = ?').bind(eventId).first<{ processed_at: number | null }>();
  return row?.processed_at == null;
}

const ref = (db: D1Database, value: string | null, purchaseId: string) =>
  value ? db.prepare('INSERT OR IGNORE INTO app_billing_payment_refs (ref, purchase_id) VALUES (?, ?)').bind(value, purchaseId).run() : Promise.resolve();

/** A payment is one row by id; seen again, it keeps the EARLIEST time, so either order of two events about it gives one answer. */
const payment = (db: D1Database, id: string, purchaseId: string, paidAt: number, amount: number, currency: string, now: number) =>
  db.prepare(
    `INSERT INTO app_billing_payments (id, purchase_id, paid_at, amount, currency, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)
     ON CONFLICT(id) DO UPDATE SET paid_at = MIN(app_billing_payments.paid_at, excluded.paid_at)`,
  ).bind(id, purchaseId, paidAt, amount, currency, now).run();

const touch = (db: D1Database, purchaseId: string, set: string, ...binds: unknown[]) =>
  db.prepare(`UPDATE app_purchases SET ${set}, updated_at = ? WHERE id = ?`).bind(...binds, Date.now(), purchaseId).run();

async function applyFact(db: D1Database, fact: Exclude<AppBillingFact, { kind: 'unrelated' }>, at: number, now: number): Promise<void> {
  const id = fact.purchaseId;
  switch (fact.kind) {
    case 'purchase':
      await touch(db, id, "status = CASE WHEN status IN ('pending', 'failed') THEN 'paid' ELSE status END, stripe_subscription_id = COALESCE(stripe_subscription_id, ?)", fact.stripeSubscriptionId);
      await ref(db, fact.stripePaymentIntentId, id);
      // A one-off checkout is the payment. A subscription's payments are its invoices.
      if (fact.productType === 'one_time') await payment(db, `purchase:${id}`, id, at, fact.amount, fact.currency, now);
      return;
    case 'renewal':
      await touch(db, id, "status = CASE WHEN status IN ('pending', 'failed') THEN 'paid' ELSE status END, stripe_subscription_id = COALESCE(stripe_subscription_id, ?)", fact.stripeSubscriptionId);
      await ref(db, fact.stripeInvoiceId, id);
      await payment(db, `in:${fact.stripeInvoiceId}`, id, at, fact.amount, fact.currency, now);
      return;
    case 'payment_failed':
      await touch(db, id, 'failed_at = MAX(COALESCE(failed_at, 0), ?)', at);
      return;
    case 'subscription_updated':
      // The cancel flag follows the newest event (an older one never undoes a newer one); an ended subscription is final whatever the order.
      await touch(db, id,
        'sub_cancel_at_period_end = CASE WHEN ?1 >= sub_event_at THEN ?2 ELSE sub_cancel_at_period_end END, sub_event_at = MAX(sub_event_at, ?1), sub_ended_at = CASE WHEN ?3 = 1 THEN COALESCE(sub_ended_at, ?1) ELSE sub_ended_at END',
        at, fact.cancelAtPeriodEnd ? 1 : 0, fact.ended ? 1 : 0);
      return;
    case 'cancelled':
      await touch(db, id, 'sub_ended_at = COALESCE(sub_ended_at, ?), sub_event_at = MAX(sub_event_at, ?)', at, at);
      return;
    case 'refunded':
      await touch(db, id, "refunded_at = COALESCE(refunded_at, ?), status = 'refunded'", at);
      await ref(db, fact.stripeChargeId, id);
      return;
  }
}

/**
 * `afterApplied` runs once the event is fully applied, with the app id: the route uses it to push the changed rows to the app's D1. It
 * can never fail the event (the rows stay dirty and the sweep pushes them), so a failure in it is swallowed.
 */
export async function handleAppBillingEvent(db: D1Database, event: unknown, now: number = Date.now(), afterApplied?: (appId: string) => Promise<void>): Promise<BillingHandled> {
  const fact = parseAppBillingEvent(event);
  if (fact.kind === 'unrelated') return IGNORED;
  const raw = event as RawEvent;
  const eventId = String(raw.id);

  const purchase = await db.prepare('SELECT id, app_id FROM app_purchases WHERE id = ?').bind(fact.purchaseId).first<{ id: string; app_id: string }>();
  // An event for a purchase we never made, or one that names a different app's purchase, is acknowledged and ignored.
  if (!purchase || purchase.app_id !== fact.appId) {
    console.warn('[billing] event for an unknown purchase', { eventId, type: raw.type, appId: fact.appId });
    return IGNORED;
  }

  if (!(await claimEvent(db, eventId, String(raw.type), fact.appId, now))) return { handled: true, purchaseId: purchase.id, duplicate: true };
  await applyFact(db, fact, eventTime(raw, now), now);
  await recomputePurchase(db, purchase.id, now);
  await db.prepare('UPDATE app_billing_events SET processed_at = ? WHERE event_id = ?').bind(Date.now(), eventId).run();
  if (afterApplied) await afterApplied(fact.appId).catch((e) => console.warn('[billing] after-apply hook failed', { appId: fact.appId, error: e instanceof Error ? e.message : String(e) }));
  return { handled: true, purchaseId: purchase.id };
}
