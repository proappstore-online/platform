import { Hono } from 'hono';
import type { Env } from '../types.js';
import { HttpError, requireAdmin, requireAppOwner, requireUser } from '../lib/auth.js';
import { getAppVisibility, requireVisible } from '../lib/visibility.js';
import { appLedger } from '../lib/billing-ledger.js';
import { isAppRedirectUrl } from './app-billing.js';
import { stripeFor } from '../lib/billing-env.js';
import type { StripeEnv } from '../lib/stripe-env.js';

/**
 * App billing 3/3 (#509, epic #506): what a buyer sees of their own purchases, the customer portal, what the owner sees, and the
 * admin's switch for live money.
 *
 * Three audiences, three rules. A signed-in buyer reads only rows whose buyer is them, whatever the query says. The owner (and the
 * platform admin) reads the whole app, the ledger included. Only a platform admin flips `app_billing.enabled`.
 */

export const appBillingAccountRoutes = new Hono<{ Bindings: Env }>();

const APP_ID = /^[a-z][a-z0-9-]{0,57}$/;
const MAX_SUBJECT_FILTER = 50;

async function requireApp(c: { env: Env }, appId: string): Promise<void> {
  if (!APP_ID.test(appId)) throw new HttpError('app not found', 404);
  const app = await c.env.DB.prepare('SELECT id FROM apps WHERE id = ?').bind(appId).first<{ id: string }>();
  if (!app) throw new HttpError('app not found', 404);
}

interface ProductRow {
  product_key: string; name: string; amount: number; currency: string; tax_behavior: string; modes: string;
  interval_unit: string | null; interval_count: number | null; grace_days: number; subject: string;
}

const productDto = (p: ProductRow) => ({
  key: p.product_key, name: p.name, amount: p.amount, currency: p.currency, taxBehavior: p.tax_behavior,
  modes: JSON.parse(p.modes) as string[], interval: p.interval_unit ? { unit: p.interval_unit, count: p.interval_count } : null,
  graceDays: p.grace_days, subject: p.subject,
});

const PRODUCT_COLUMNS = 'product_key, name, amount, currency, tax_behavior, modes, interval_unit, interval_count, grace_days, subject';

/** The products a buyer can be offered: active ones, and only once an admin has turned billing on. */
appBillingAccountRoutes.get('/apps/:appId/billing/products', async (c) => {
  const appId = c.req.param('appId')!;
  const user = await requireUser(c);
  await requireApp(c, appId);
  await requireVisible(c.env, appId, await getAppVisibility(c.env.DB, appId), user);
  const config = await c.env.DB.prepare('SELECT enabled FROM app_billing WHERE app_id = ?').bind(appId).first<{ enabled: number }>();
  if (config?.enabled !== 1) throw new HttpError('billing is not enabled for this app', 403);
  const { results } = await c.env.DB.prepare(`SELECT ${PRODUCT_COLUMNS} FROM app_billing_products WHERE app_id = ? AND active = 1 ORDER BY product_key`).bind(appId).all<ProductRow>();
  return c.json({ products: (results ?? []).map(productDto) });
});

interface EntitlementRow {
  product_key: string; subject: string; status: string; period_start: number | null; period_end: number | null;
  grace_until: number | null; renews: number; buyer_user_id: string | null; updated_at: number;
}

const entitlementDto = (e: EntitlementRow) => ({
  product: e.product_key, subject: e.subject, status: e.status, periodStart: e.period_start, periodEnd: e.period_end,
  graceUntil: e.grace_until, renews: e.renews === 1, updatedAt: e.updated_at,
});

const ENTITLEMENT_COLUMNS = 'product_key, subject, status, period_start, period_end, grace_until, renews, buyer_user_id, updated_at';

/**
 * The caller's own entitlements: rows they bought. Another buyer's rows for the same subject are not theirs and are
 * not returned. Scoped to the app's currently-active Stripe env (#519): a leftover test-mode row never shows up as
 * the buyer's state while the app is live, and vice versa.
 */
appBillingAccountRoutes.get('/apps/:appId/billing/entitlements', async (c) => {
  const appId = c.req.param('appId')!;
  const user = await requireUser(c);
  await requireApp(c, appId);
  const raw = c.req.query('subjects');
  const subjects = raw === undefined ? null : raw.split(',').filter((s) => s !== '');
  if (subjects && subjects.length > MAX_SUBJECT_FILTER) throw new HttpError(`subjects: at most ${MAX_SUBJECT_FILTER}`, 400);
  const filter = subjects ? ` AND subject IN (SELECT value FROM json_each(?3))` : '';
  const stmt = c.env.DB.prepare(`SELECT ${ENTITLEMENT_COLUMNS} FROM app_entitlements WHERE app_id = ?1 AND buyer_user_id = ?2 AND stripe_env = COALESCE((SELECT stripe_env FROM app_billing WHERE app_id = ?1), 'live')${filter} ORDER BY product_key, subject LIMIT 500`);
  const { results } = await (subjects ? stmt.bind(appId, user.id, JSON.stringify(subjects)) : stmt.bind(appId, user.id)).all<EntitlementRow>();
  return c.json({ entitlements: (results ?? []).map(entitlementDto) });
});

interface PurchaseRow {
  id: string; product_key: string; subjects: string; mode: string; status: string; created_at: number; sub_cancel_at_period_end: number;
  gross: number; currency: string | null;
}

/** The caller's own purchases (a receipt list). No fees, no other buyers: this is the buyer's view. */
appBillingAccountRoutes.get('/apps/:appId/billing/purchases', async (c) => {
  const appId = c.req.param('appId')!;
  const user = await requireUser(c);
  await requireApp(c, appId);
  const { results } = await c.env.DB.prepare(
    `SELECT p.id, p.product_key, p.subjects, p.mode, p.status, p.created_at, p.sub_cancel_at_period_end,
            (SELECT COALESCE(SUM(amount), 0) FROM app_billing_payments WHERE purchase_id = p.id) AS gross,
            (SELECT currency FROM app_billing_payments WHERE purchase_id = p.id ORDER BY paid_at LIMIT 1) AS currency
       FROM app_purchases p WHERE p.app_id = ? AND p.buyer_user_id = ? AND p.status != 'pending' AND p.status != 'failed'
      ORDER BY p.created_at DESC, p.id LIMIT 200`,
  ).bind(appId, user.id).all<PurchaseRow>();
  return c.json({
    purchases: (results ?? []).map((p) => ({
      id: p.id, product: p.product_key, subjects: JSON.parse(p.subjects) as string[], mode: p.mode, status: p.status,
      createdAt: p.created_at, paid: p.gross, currency: p.currency, cancelAtPeriodEnd: p.sub_cancel_at_period_end === 1,
    })),
  });
});

/**
 * Stripe's customer portal (cancel a renewal, receipts) for the CALLER's own Stripe customer. The customer id is read from the
 * caller's own record, never from the request, and the caller must have bought something in this app. No customer is created here.
 */
appBillingAccountRoutes.post('/apps/:appId/billing/portal', async (c) => {
  const appId = c.req.param('appId')!;
  const user = await requireUser(c);
  await requireApp(c, appId);
  const body = await c.req.json<{ returnUrl?: unknown }>().catch(() => null);
  const returnUrl = body?.returnUrl;
  if (typeof returnUrl !== 'string' || !returnUrl) throw new HttpError('returnUrl is required', 400);
  if (!(await isAppRedirectUrl(c.env.DB, appId, returnUrl))) {
    throw new HttpError("returnUrl must be on this app's own origins (its proappstore.online subdomain, a verified custom domain, or localhost)", 400);
  }
  // The app's currently-active env (#519) decides which Stripe identity, and which of the caller's purchases/customer
  // rows, the portal opens against.
  const envRow = await c.env.DB.prepare('SELECT stripe_env FROM app_billing WHERE app_id = ?').bind(appId).first<{ stripe_env: StripeEnv }>();
  const stripeEnv: StripeEnv = envRow?.stripe_env ?? 'live';
  const bought = await c.env.DB.prepare("SELECT 1 AS x FROM app_purchases WHERE app_id = ? AND buyer_user_id = ? AND stripe_env = ? AND status IN ('paid', 'refunded', 'canceled') LIMIT 1").bind(appId, user.id, stripeEnv).first();
  const customer = await c.env.DB.prepare('SELECT stripe_customer_id AS id FROM billing_customers WHERE user_id = ? AND stripe_env = ?').bind(user.id, stripeEnv).first<{ id: string }>();
  if (!bought || !customer) throw new HttpError('you have no purchases in this app', 404);
  try {
    const session = await stripeFor(c.env, stripeEnv).createBillingPortalSession({ customer: customer.id, returnUrl });
    return c.json({ url: session.url });
  } catch (e) {
    console.error('[billing] portal failed', { appId, error: e instanceof Error ? e.message : String(e) });
    throw new HttpError('could not open the billing portal', 502);
  }
});

/** Whether the platform has test-mode Stripe credentials configured at all (#519) — never the values. */
const testModeConfigured = (env: Env): boolean => !!(env.STRIPE_TEST_SECRET_KEY && env.STRIPE_TEST_WEBHOOK_SECRET);

/** The owner's view of the app's products, with whether billing is on, the effective Stripe mode, and any sync problem. */
appBillingAccountRoutes.get('/apps/:appId/billing/owner/products', async (c) => {
  const appId = c.req.param('appId')!;
  await requireAppOwner(c, appId);
  const config = await c.env.DB.prepare('SELECT enabled, authorize_action, stripe_env FROM app_billing WHERE app_id = ?').bind(appId).first<{ enabled: number; authorize_action: string | null; stripe_env: StripeEnv }>();
  const stripeEnv: StripeEnv = config?.stripe_env ?? 'live';
  const { results } = await c.env.DB.prepare(`SELECT ${PRODUCT_COLUMNS}, active, sync_error FROM app_billing_products WHERE app_id = ? ORDER BY product_key`).bind(appId).all<ProductRow & { active: number; sync_error: string | null }>();
  // The sync error shown tracks the effective env (#519): test mode's own linkage lives in a sibling table, never
  // app_billing_products' live columns.
  const testErrors = stripeEnv === 'test'
    ? new Map((await c.env.DB.prepare('SELECT product_key, sync_error FROM app_billing_products_test WHERE app_id = ?').bind(appId).all<{ product_key: string; sync_error: string | null }>()).results?.map((r) => [r.product_key, r.sync_error]) ?? [])
    : null;
  return c.json({
    enabled: config?.enabled === 1, authorizeAction: config?.authorize_action ?? null,
    stripeEnv, testModeConfigured: testModeConfigured(c.env),
    products: (results ?? []).map((p) => ({ ...productDto(p), active: p.active === 1, syncError: testErrors ? (testErrors.get(p.product_key) ?? null) : p.sync_error })),
  });
});

/** The owner's ledger: every paid purchase with gross, refunds and Stripe's fee. Buyers never reach this route. */
appBillingAccountRoutes.get('/apps/:appId/billing/owner/purchases', async (c) => {
  const appId = c.req.param('appId')!;
  await requireAppOwner(c, appId);
  return c.json(await appLedger(c.env.DB, appId));
});

/** Every entitlement of the app, for the owner, scoped to its currently-active env (#519); `?product=` narrows it. */
appBillingAccountRoutes.get('/apps/:appId/billing/owner/entitlements', async (c) => {
  const appId = c.req.param('appId')!;
  await requireAppOwner(c, appId);
  const product = c.req.query('product');
  const stmt = c.env.DB.prepare(`SELECT ${ENTITLEMENT_COLUMNS} FROM app_entitlements WHERE app_id = ?1 AND stripe_env = COALESCE((SELECT stripe_env FROM app_billing WHERE app_id = ?1), 'live')${product ? ' AND product_key = ?2' : ''} ORDER BY product_key, subject LIMIT 500`);
  const { results } = await (product ? stmt.bind(appId, product) : stmt.bind(appId)).all<EntitlementRow>();
  return c.json({ entitlements: (results ?? []).map((e) => ({ ...entitlementDto(e), buyerUserId: e.buyer_user_id })) });
});

/**
 * The switch for live money (#507): per app, off until a platform admin turns it on. Re-registering a manifest never
 * moves it. Also the admin's Stripe-mode switch (#519): switching `stripeEnv` is refused while billing stays or
 * becomes enabled — an unsafe transition under live checkout traffic — so the admin must disable first, switch,
 * then re-enable once the new mode's isolation is verified.
 */
appBillingAccountRoutes.put('/admin/apps/:appId/billing', async (c) => {
  const admin = await requireAdmin(c);
  const appId = c.req.param('appId')!;
  const body = await c.req.json<{ enabled?: unknown; stripeEnv?: unknown }>().catch(() => null);
  if (!body || typeof body !== 'object') throw new HttpError('body must be an object', 400);
  if (body.enabled === undefined && body.stripeEnv === undefined) throw new HttpError('body must set "enabled" and/or "stripeEnv"', 400);
  if (body.enabled !== undefined && typeof body.enabled !== 'boolean') throw new HttpError('enabled must be true or false', 400);
  if (body.stripeEnv !== undefined && body.stripeEnv !== 'live' && body.stripeEnv !== 'test') throw new HttpError('stripeEnv must be "live" or "test"', 400);
  await requireApp(c, appId);
  const current = await c.env.DB.prepare('SELECT enabled, stripe_env FROM app_billing WHERE app_id = ?').bind(appId).first<{ enabled: number; stripe_env: StripeEnv }>();
  if (!current) throw new HttpError('this app declares no billing', 404);

  const stripeEnv = (body.stripeEnv as StripeEnv | undefined) ?? current.stripe_env;
  if (stripeEnv !== current.stripe_env) {
    const stayingEnabled = body.enabled === true || (body.enabled === undefined && current.enabled === 1);
    if (stayingEnabled) throw new HttpError('disable billing before switching stripeEnv (switch while disabled, then re-enable)', 409);
  }
  const enabled = body.enabled === undefined ? current.enabled === 1 : body.enabled;
  const now = Date.now();
  await c.env.DB.prepare(
    `UPDATE app_billing SET enabled = ?1, stripe_env = ?2,
       stripe_env_updated_at = CASE WHEN stripe_env != ?2 THEN ?3 ELSE stripe_env_updated_at END,
       stripe_env_updated_by = CASE WHEN stripe_env != ?2 THEN ?4 ELSE stripe_env_updated_by END,
       updated_at = ?3 WHERE app_id = ?5`,
  ).bind(enabled ? 1 : 0, stripeEnv, now, admin.id, appId).run();
  console.warn('[billing] admin switch', { appId, enabled, stripeEnv, by: admin.id });
  return c.json({ ok: true, enabled, stripeEnv });
});

appBillingAccountRoutes.get('/admin/apps/:appId/billing', async (c) => {
  await requireAdmin(c);
  const appId = c.req.param('appId')!;
  const config = await c.env.DB.prepare('SELECT enabled, authorize_action, stripe_env FROM app_billing WHERE app_id = ?').bind(appId).first<{ enabled: number; authorize_action: string | null; stripe_env: StripeEnv }>();
  if (!config) throw new HttpError('this app declares no billing', 404);
  return c.json({ enabled: config.enabled === 1, authorizeAction: config.authorize_action, stripeEnv: config.stripe_env, testModeConfigured: testModeConfigured(c.env) });
});
