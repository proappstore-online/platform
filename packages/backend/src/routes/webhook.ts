import { Hono } from 'hono';
import type { Env } from '../types.js';
import { verifyWebhookSignature } from '../lib/stripe.js';
import { eventCarriesAppId } from '../lib/app-billing-events.js';
import { handleAppBillingEvent } from '../lib/app-billing-handler.js';
import { recordChargeEvent } from '../lib/billing-ledger.js';
import { mirrorApp } from '../lib/entitlement-mirror.js';

export const webhookRoutes = new Hono<{ Bindings: Env }>();

/** Stripe subscription statuses after which the subscription can never become active again. */
const TERMINAL_STATUSES = new Set(['canceled', 'incomplete_expired']);

/** Remember that a subscription ended (#321), so no later or earlier-delivered checkout can activate it. */
async function recordTerminated(db: D1Database, subscriptionId: string, eventType: string): Promise<void> {
  if (!subscriptionId) return;
  await db.prepare('INSERT OR IGNORE INTO stripe_terminated_subscriptions (subscription_id, terminated_at, event_type) VALUES (?, ?, ?)')
    .bind(subscriptionId, Date.now(), eventType).run();
}

interface StripeEvent {
  type: string;
  /** Unix seconds, inside the signed body: the event order this handler trusts (#321). */
  created?: number;
  data: {
    object: Record<string, unknown>;
  };
}

/**
 * Stripe webhook handler. Updates D1 subscription state based on events.
 * Key events:
 * - checkout.session.completed → activate subscription
 * - customer.subscription.updated → sync status/period
 * - customer.subscription.deleted → mark canceled
 * - invoice.payment_failed → mark past_due
 *
 * Idempotent on retries (every handler SETs absolute state, never increments).
 *
 * Ordering invariant (#321). Stripe does not guarantee delivery order and
 * redelivers events, so every write is conditional on authenticated event data:
 *
 * - **A subscription's end is terminal.** customer.subscription.deleted, or an
 *   update to `canceled`/`incomplete_expired`, records the subscription id in
 *   stripe_terminated_subscriptions, whether or not a row matched, and only then
 *   cancels the row. Stripe never reuses an id, so the record is permanent.
 * - **A checkout never revives a terminated subscription.** Its upsert inserts
 *   only if the id is not recorded as terminated, and updates the user's row only:
 *   - for the same subscription, while that row is not `canceled` (a duplicate
 *     or a retry: idempotent);
 *   - for a different subscription, when the row is `canceled` (a genuine
 *     re-subscribe after a cancellation), or when this checkout's event is newer
 *     than the one that set the row (`checkout_event_at`, the signed `created`).
 *   So a deletion that arrives before its own checkout still wins, and an old
 *   checkout delivered late cannot swap a user back to a superseded subscription.
 * - **updated / payment_failed never touch a `canceled` row.**
 *
 * Each write is one statement, so concurrent deliveries of these events end in
 * the same state whatever order D1 runs them in.
 */
webhookRoutes.post('/webhooks/stripe', async (c) => {
  const signature = c.req.header('stripe-signature');
  if (!signature) return c.text('missing stripe-signature', 400);

  const payload = await c.req.text();

  const valid = await verifyWebhookSignature(payload, signature, c.env.STRIPE_WEBHOOK_SECRET);
  if (!valid) return c.text('invalid signature', 401);

  const event = JSON.parse(payload) as StripeEvent;
  const obj = event.data.object;

  // #509: what a charge says (refund total, fee id) is kept for the revenue ledger, whichever path the event takes next.
  try {
    await recordChargeEvent(c.env.DB, event);
  } catch (e) {
    console.error('[billing] charge record failed', { type: event.type, error: e instanceof Error ? e.message : String(e) });
    return c.text('charge record failed', 500);
  }

  // #508: an event that carries our `app_id` belongs to an app's own purchase and never reaches the Pro handlers below. Those key a
  // checkout by `metadata.user_id` and would read an app purchase (which carries one too) as a Pro upgrade. Decided by the metadata
  // alone, so an app event the entitlements ignore (an unpaid session, a partial refund) still cannot fall through.
  if (eventCarriesAppId(event)) {
    try {
      // Push the changed rows to the app's D1 after the response; a failed push leaves them dirty for the sweep.
      await handleAppBillingEvent(c.env.DB, event, Date.now(), async (appId) => {
        c.executionCtx.waitUntil(mirrorApp(c.env, appId).then(() => undefined, (e) => console.warn('[billing] mirror failed', { appId, error: e instanceof Error ? e.message : String(e) })));
      });
    } catch (e) {
      // Not acknowledged: Stripe redelivers, and the handler is safe to repeat.
      console.error('[billing] app event failed', { type: event.type, error: e instanceof Error ? e.message : String(e) });
      return c.text('app billing event failed', 500);
    }
    return c.json({ received: true });
  }

  switch (event.type) {
    case 'checkout.session.completed': {
      const userId = (obj.metadata as Record<string, string>)?.user_id;
      const customerId = obj.customer as string;
      const subscriptionId = obj.subscription as string;
      if (userId && customerId && subscriptionId) {
        // #321: one conditional upsert — see the ordering invariant above.
        const eventAt = typeof event.created === 'number' ? event.created : 0;
        const now = Date.now();
        await c.env.DB.prepare(
          `INSERT INTO subscriptions (user_id, stripe_customer_id, stripe_subscription_id, status, tier, current_period_end, cancel_at_period_end, created_at, updated_at, checkout_event_at)
           SELECT ?1, ?2, ?3, 'active', 'pro', 0, 0, ?4, ?4, ?5
            WHERE NOT EXISTS (SELECT 1 FROM stripe_terminated_subscriptions WHERE subscription_id = ?3)
           ON CONFLICT(user_id) DO UPDATE SET
             stripe_customer_id = excluded.stripe_customer_id,
             stripe_subscription_id = excluded.stripe_subscription_id,
             status = 'active',
             tier = 'pro',
             updated_at = excluded.updated_at,
             checkout_event_at = MAX(COALESCE(subscriptions.checkout_event_at, 0), excluded.checkout_event_at)
           WHERE (subscriptions.stripe_subscription_id = excluded.stripe_subscription_id AND subscriptions.status != 'canceled')
              OR (subscriptions.stripe_subscription_id IS NOT excluded.stripe_subscription_id
                  AND (subscriptions.status = 'canceled' OR COALESCE(subscriptions.checkout_event_at, 0) < excluded.checkout_event_at))`,
        )
          .bind(userId, customerId, subscriptionId, now, eventAt)
          .run();
      }
      break;
    }

    case 'customer.subscription.updated': {
      const subscriptionId = obj.id as string;
      const status = obj.status as string;
      const cancelAtPeriodEnd = obj.cancel_at_period_end as boolean;
      // Stripe API 2025-03-31+ moved current_period_end off the Subscription
      // object onto each subscription item. Read the item first, fall back to
      // the legacy top-level field so both API versions persist a real renewal
      // date (not epoch 0).
      const items = obj.items as { data?: { current_period_end?: number; price?: { id?: string } }[] };
      const periodEndSec = items?.data?.[0]?.current_period_end ?? (obj.current_period_end as number) ?? 0;
      const currentPeriodEnd = periodEndSec * 1000;
      const priceId = items?.data?.[0]?.price?.id ?? null;

      // A terminal status ends the subscription for good (#321): record it first, as a deletion does.
      if (TERMINAL_STATUSES.has(status)) await recordTerminated(c.env.DB, subscriptionId, event.type);
      await c.env.DB.prepare(
        `UPDATE subscriptions SET
           status = ?,
           price_id = ?,
           current_period_end = ?,
           cancel_at_period_end = ?,
           updated_at = ?
         WHERE stripe_subscription_id = ? AND status != 'canceled'`,
      )
        .bind(status, priceId, currentPeriodEnd, cancelAtPeriodEnd ? 1 : 0, Date.now(), subscriptionId)
        .run();
      break;
    }

    case 'customer.subscription.deleted': {
      const subscriptionId = obj.id as string;
      // #321: record the end BEFORE cancelling the row. A concurrent checkout either ran first (and is cancelled
      // next) or finds the record and does nothing; a crash between the two is retried by Stripe, idempotently.
      await recordTerminated(c.env.DB, subscriptionId, event.type);
      await c.env.DB.prepare(
        `UPDATE subscriptions SET status = 'canceled', tier = 'free', updated_at = ? WHERE stripe_subscription_id = ?`,
      )
        .bind(Date.now(), subscriptionId)
        .run();
      break;
    }

    case 'invoice.payment_failed': {
      // Stripe API 2025-03-31 moved the invoice's subscription under `parent`; no version is
      // pinned, so the payload's shape is the account default's. Read both (#303).
      const parent = obj.parent as { subscription_details?: { subscription?: string } } | undefined;
      const subscriptionId = (obj.subscription as string | undefined) ?? parent?.subscription_details?.subscription;
      if (subscriptionId) {
        await c.env.DB.prepare(
          `UPDATE subscriptions SET status = 'past_due', updated_at = ? WHERE stripe_subscription_id = ? AND status != 'canceled'`,
        )
          .bind(Date.now(), subscriptionId)
          .run();
      }
      break;
    }
  }

  return c.json({ received: true });
});
