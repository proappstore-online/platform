import { Hono } from 'hono';
import type { Env } from '../types.js';
import { verifyWebhookSignature } from '../lib/stripe.js';

export const webhookRoutes = new Hono<{ Bindings: Env }>();

interface StripeEvent {
  type: string;
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
 */
webhookRoutes.post('/webhooks/stripe', async (c) => {
  const signature = c.req.header('stripe-signature');
  if (!signature) return c.text('missing stripe-signature', 400);

  const payload = await c.req.text();

  const valid = await verifyWebhookSignature(payload, signature, c.env.STRIPE_WEBHOOK_SECRET);
  if (!valid) return c.text('invalid signature', 401);

  const event = JSON.parse(payload) as StripeEvent;
  const obj = event.data.object;

  switch (event.type) {
    case 'checkout.session.completed': {
      const userId = (obj.metadata as Record<string, string>)?.user_id;
      const customerId = obj.customer as string;
      const subscriptionId = obj.subscription as string;
      if (userId && customerId && subscriptionId) {
        await c.env.DB.prepare(
          `INSERT INTO subscriptions (user_id, stripe_customer_id, stripe_subscription_id, status, tier, current_period_end, cancel_at_period_end, created_at, updated_at)
           VALUES (?, ?, ?, 'active', 'pro', 0, 0, ?, ?)
           ON CONFLICT(user_id) DO UPDATE SET
             stripe_customer_id = excluded.stripe_customer_id,
             stripe_subscription_id = excluded.stripe_subscription_id,
             status = 'active',
             tier = 'pro',
             updated_at = excluded.updated_at`,
        )
          .bind(userId, customerId, subscriptionId, Date.now(), Date.now())
          .run();
      }
      break;
    }

    case 'customer.subscription.updated': {
      const subscriptionId = obj.id as string;
      const status = obj.status as string;
      const cancelAtPeriodEnd = obj.cancel_at_period_end as boolean;
      const currentPeriodEnd = ((obj.current_period_end as number) ?? 0) * 1000;
      const priceId = ((obj.items as { data?: { price?: { id?: string } }[] })?.data?.[0]?.price?.id) ?? null;

      await c.env.DB.prepare(
        `UPDATE subscriptions SET
           status = ?,
           price_id = ?,
           current_period_end = ?,
           cancel_at_period_end = ?,
           updated_at = ?
         WHERE stripe_subscription_id = ?`,
      )
        .bind(status, priceId, currentPeriodEnd, cancelAtPeriodEnd ? 1 : 0, Date.now(), subscriptionId)
        .run();
      break;
    }

    case 'customer.subscription.deleted': {
      const subscriptionId = obj.id as string;
      await c.env.DB.prepare(
        `UPDATE subscriptions SET status = 'canceled', tier = 'free', updated_at = ? WHERE stripe_subscription_id = ?`,
      )
        .bind(Date.now(), subscriptionId)
        .run();
      break;
    }

    case 'invoice.payment_failed': {
      const subscriptionId = obj.subscription as string;
      if (subscriptionId) {
        await c.env.DB.prepare(
          `UPDATE subscriptions SET status = 'past_due', updated_at = ? WHERE stripe_subscription_id = ?`,
        )
          .bind(Date.now(), subscriptionId)
          .run();
      }
      break;
    }
  }

  return c.json({ received: true });
});
