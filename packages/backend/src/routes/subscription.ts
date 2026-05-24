import { Hono } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import type { Env, SubscriptionRow } from '../types.js';
import { requireUser, HttpError } from '../lib/auth.js';
import { Stripe } from '../lib/stripe.js';

export const subscriptionRoutes = new Hono<{ Bindings: Env }>();

/**
 * Public pricing surface — what's the current Pro subscription price and
 * Stripe price ID. Read by the Console + Dashboard so the client never has
 * to hard-code `priceId: "price_pro_monthly"` (which was a literal string
 * masquerading as a real Stripe price ID and 400'd every checkout attempt).
 *
 * No auth — the prices are public. Returns nulls when `STRIPE_PRO_MONTHLY_PRICE_ID`
 * isn't configured so the UI can degrade ("Upgrade unavailable — contact support")
 * rather than render a fake-looking error.
 */
subscriptionRoutes.get('/pricing', (c) => {
  const proPriceId = c.env.STRIPE_PRO_MONTHLY_PRICE_ID ?? null;
  return c.json({
    proMonthly: proPriceId
      ? { priceId: proPriceId, currency: 'usd', dollars: 9 }
      : null,
  });
});

/** Get current user's subscription status. */
subscriptionRoutes.get('/subscription', async (c) => {
  try {
    const user = await requireUser(c);
    const row = await c.env.DB.prepare(
      'SELECT * FROM subscriptions WHERE user_id = ?',
    )
      .bind(user.id)
      .first<SubscriptionRow>();

    if (!row || row.status === 'canceled') return c.json(null, 404);

    return c.json({
      status: row.status,
      tier: row.tier,
      priceId: row.price_id,
      currentPeriodEnd: row.current_period_end,
      cancelAtPeriodEnd: row.cancel_at_period_end === 1,
    });
  } catch (err) {
    if (err instanceof HttpError) return c.text(err.message, err.status as ContentfulStatusCode);
    throw err;
  }
});

/** Create a Stripe Checkout session for subscribing. */
subscriptionRoutes.post('/checkout', async (c) => {
  try {
    const user = await requireUser(c);
    const { priceId, successUrl, cancelUrl } = await c.req.json<{
      priceId: string;
      successUrl: string;
      cancelUrl: string;
    }>();

    if (!priceId || !successUrl || !cancelUrl) {
      return c.text('missing priceId, successUrl, or cancelUrl', 400);
    }

    const stripe = new Stripe(c.env.STRIPE_SECRET_KEY);

    // Get or create Stripe customer
    let row = await c.env.DB.prepare(
      'SELECT stripe_customer_id FROM subscriptions WHERE user_id = ?',
    )
      .bind(user.id)
      .first<{ stripe_customer_id: string }>();

    let customerId = row?.stripe_customer_id;
    if (!customerId) {
      const customer = await stripe.createCustomer({
        metadata: { user_id: user.id, login: user.login },
      });
      customerId = customer.id;

      // Upsert subscription row with just the customer ID
      await c.env.DB.prepare(
        `INSERT INTO subscriptions (user_id, stripe_customer_id, status, tier, current_period_end, cancel_at_period_end, created_at, updated_at)
         VALUES (?, ?, 'incomplete', 'free', 0, 0, ?, ?)
         ON CONFLICT(user_id) DO UPDATE SET stripe_customer_id = excluded.stripe_customer_id, updated_at = excluded.updated_at`,
      )
        .bind(user.id, customerId, Date.now(), Date.now())
        .run();
    }

    const session = await stripe.createCheckoutSession({
      customer: customerId,
      priceId,
      successUrl,
      cancelUrl,
      metadata: { user_id: user.id },
    });

    return c.json({ url: session.url });
  } catch (err) {
    if (err instanceof HttpError) return c.text(err.message, err.status as ContentfulStatusCode);
    throw err;
  }
});

/** Create a Stripe Billing Portal session. */
subscriptionRoutes.post('/portal', async (c) => {
  try {
    const user = await requireUser(c);
    const { returnUrl } = await c.req.json<{ returnUrl: string }>();

    if (!returnUrl) return c.text('missing returnUrl', 400);

    const row = await c.env.DB.prepare(
      'SELECT stripe_customer_id FROM subscriptions WHERE user_id = ?',
    )
      .bind(user.id)
      .first<{ stripe_customer_id: string }>();

    if (!row?.stripe_customer_id) {
      return c.text('no subscription found', 404);
    }

    const stripe = new Stripe(c.env.STRIPE_SECRET_KEY);
    const session = await stripe.createBillingPortalSession({
      customer: row.stripe_customer_id,
      returnUrl,
    });

    return c.json({ url: session.url });
  } catch (err) {
    if (err instanceof HttpError) return c.text(err.message, err.status as ContentfulStatusCode);
    throw err;
  }
});
