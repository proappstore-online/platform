/**
 * App products (#507, epic #506): `POST /v1/apps/:appId/billing/checkout`.
 *
 * Any PAS app sells the products it declared in mcp.json `billing` through the platform's single
 * Stripe account. Order matters and is the contract:
 *   1. signed-in user; the body is shaped; the product is THIS app's and active (400);
 *   2. subjects fit the product, the redirect URLs are on this app's origins (400);
 *   3. the app's authorize_action allows it (403), before any Stripe call;
 *   4. only then Stripe: customer, then a Checkout session for the Price the deploy created.
 * Subjects are the app's opaque ids. They are stored on the purchase row, never in Stripe metadata.
 */
import { Hono } from 'hono';
import type { Env } from '../types.js';
import { requireUser } from '../lib/auth.js';
import { wrap } from '../lib/route-wrap.js';
import { Stripe } from '../lib/stripe.js';
import { isAllowedAppRedirectUrl } from '../lib/app-redirect.js';
import { runAuthorizeAction } from '../lib/billing-authorize.js';

export const appBillingRoutes = new Hono<{ Bindings: Env }>();

const MAX_SUBJECTS = 50;
const MAX_SUBJECT_LENGTH = 200;

interface ProductRow { product_key: string; modes: string; subject: string; authorize_action: string }

function fail(c: { json: (b: unknown, s: 400 | 403 | 502 | 503) => Response }, status: 400 | 403 | 502 | 503, error: string): Response {
  return c.json({ error }, status);
}

async function customerFor(env: Env, stripe: Stripe, user: { id: string; login: string }): Promise<string> {
  // The Pro flow's customer (subscriptions) is reused when there is one; otherwise ours.
  const known = await env.DB.prepare(
    `SELECT stripe_customer_id FROM subscriptions WHERE user_id = ?1 AND stripe_customer_id IS NOT NULL
     UNION ALL SELECT stripe_customer_id FROM billing_customers WHERE user_id = ?1 LIMIT 1`,
  ).bind(user.id).first<{ stripe_customer_id: string }>();
  if (known?.stripe_customer_id) return known.stripe_customer_id;
  const created = await stripe.createCustomer({ metadata: { user_id: user.id, login: user.login }, idempotencyKey: `pas-customer-${user.id}` });
  await env.DB.prepare('INSERT OR IGNORE INTO billing_customers (user_id, stripe_customer_id, created_at) VALUES (?, ?, ?)')
    .bind(user.id, created.id, Date.now()).run();
  const stored = await env.DB.prepare('SELECT stripe_customer_id FROM billing_customers WHERE user_id = ?').bind(user.id).first<{ stripe_customer_id: string }>();
  return stored?.stripe_customer_id ?? created.id;
}

appBillingRoutes.post('/apps/:appId/billing/checkout', wrap(async (c) => {
  const appId = c.req.param('appId')!;
  const user = await requireUser(c);
  const body = await c.req.json<Record<string, unknown>>().catch(() => null);
  if (!body || typeof body !== 'object') return fail(c, 400, 'a JSON body is required');
  const { product, subjects, renew, successUrl, cancelUrl } = body;
  if (typeof product !== 'string' || !product) return fail(c, 400, 'product is required');
  if (typeof successUrl !== 'string' || typeof cancelUrl !== 'string' || !successUrl || !cancelUrl) return fail(c, 400, 'successUrl and cancelUrl are required');
  if (renew !== undefined && typeof renew !== 'boolean') return fail(c, 400, 'renew must be a boolean');
  if (subjects !== undefined && (!Array.isArray(subjects) || subjects.some((s) => typeof s !== 'string' || !s.trim() || s.length > MAX_SUBJECT_LENGTH))) {
    return fail(c, 400, `subjects must be a list of non-empty strings of at most ${MAX_SUBJECT_LENGTH} characters`);
  }

  // Keyed by THIS app: another app's product key is simply unknown here.
  const row = await c.env.DB.prepare(
    `SELECT p.product_key, p.modes, p.subject, b.authorize_action
       FROM app_products p JOIN app_billing b ON b.app_id = p.app_id
      WHERE p.app_id = ? AND p.product_key = ? AND p.active = 1`,
  ).bind(appId, product).first<ProductRow>();
  if (!row) return fail(c, 400, 'unknown product');

  const list = (subjects ?? []) as string[];
  if (row.subject === 'required') {
    if (list.length === 0) return fail(c, 400, 'this product needs at least one subject');
    if (list.length > MAX_SUBJECTS) return fail(c, 400, `at most ${MAX_SUBJECTS} subjects per checkout`);
    if (new Set(list).size !== list.length) return fail(c, 400, 'subjects must not repeat');
  } else if (list.length > 0) {
    return fail(c, 400, 'this product takes no subjects');
  }
  const quantity = row.subject === 'required' ? list.length : 1;

  const renews = renew === true;
  const kind = renews ? 'recurring' : 'one_time';
  if (!(JSON.parse(row.modes) as string[]).includes(kind)) {
    return fail(c, 400, renews ? 'this product cannot auto-renew' : 'this product is sold with auto-renew only');
  }
  if (!(await isAllowedAppRedirectUrl(c.env.DB, appId, successUrl)) || !(await isAllowedAppRedirectUrl(c.env.DB, appId, cancelUrl))) {
    return fail(c, 400, "redirect URLs must be on this app's own origins (its proappstore.online subdomain, a verified custom domain, or localhost)");
  }

  // The app's own SQL decides. Before any Stripe call, and fail closed.
  let allowed: boolean;
  try {
    allowed = await runAuthorizeAction(c.env, appId, row.authorize_action, user.id, product, list);
  } catch (e) {
    console.error(`[billing] authorize failed app=${appId} action=${row.authorize_action}: ${(e as Error).message}`);
    return fail(c, 502, 'the purchase could not be authorized right now');
  }
  if (!allowed) return fail(c, 403, 'this purchase is not allowed');

  if (!c.env.STRIPE_SECRET_KEY) return fail(c, 503, 'billing is not configured');
  const price = await c.env.DB.prepare(
    'SELECT stripe_price_id FROM app_product_prices WHERE app_id = ? AND product_key = ? AND kind = ? AND active = 1',
  ).bind(appId, product, kind).first<{ stripe_price_id: string }>();
  if (!price) return fail(c, 503, 'this product is not available for sale yet');

  const stripe = new Stripe(c.env.STRIPE_SECRET_KEY);
  let customerId: string;
  try {
    customerId = await customerFor(c.env, stripe, user);
  } catch (e) {
    console.error(`[billing] customer failed app=${appId}: ${(e as Error).message}`);
    return fail(c, 502, 'could not start checkout');
  }
  const purchaseId = crypto.randomUUID();
  const now = Date.now();
  const mode = renews ? 'subscription' : 'payment';
  await c.env.DB.prepare(
    `INSERT INTO purchases (id, app_id, product_key, buyer_user_id, subjects, quantity, renew, mode, status, stripe_price_id, stripe_customer_id, created_at, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 'pending', ?9, ?10, ?11, ?11)`,
  ).bind(purchaseId, appId, product, user.id, JSON.stringify(list), quantity, renews ? 1 : 0, mode, price.stripe_price_id, customerId, now).run();
  try {
    const session = await stripe.createAppCheckoutSession({
      customer: customerId, priceId: price.stripe_price_id, quantity, mode, successUrl, cancelUrl,
      metadata: { app_id: appId, product_key: product, user_id: user.id, purchase_id: purchaseId },
    });
    await c.env.DB.prepare('UPDATE purchases SET stripe_session_id = ?, updated_at = ? WHERE id = ?').bind(session.id, Date.now(), purchaseId).run();
    return c.json({ url: session.url, purchaseId });
  } catch (e) {
    await c.env.DB.prepare("UPDATE purchases SET status = 'failed', updated_at = ? WHERE id = ?").bind(Date.now(), purchaseId).run().catch(() => undefined);
    console.error(`[billing] checkout session failed app=${appId}: ${(e as Error).message}`);
    return fail(c, 502, 'could not start checkout');
  }
}));
