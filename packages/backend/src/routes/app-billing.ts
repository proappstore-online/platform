import { Hono } from 'hono';
import type { Env } from '../types.js';
import { HttpError, requireUser } from '../lib/auth.js';
import { Stripe } from '../lib/stripe.js';
import { getAppVisibility, requireVisible } from '../lib/visibility.js';
import { prepareActionQuery, type ToolManifest } from '../lib/action-sql.js';
import { downstreamTraceparent, requestTrace } from '../lib/log-ingest.js';
import { forwardToDataWorker } from './actions.js';

/**
 * App billing 1/3 (#507, epic #506): checkout for a product an app declared in its manifest, through the platform's
 * single Stripe account. The Pro subscription flow (subscription.ts) is separate and unchanged.
 *
 * The order is the contract. Everything that can refuse does so BEFORE Stripe is called:
 *   signed in -> billing enabled for the app -> the app's own product -> subjects -> the app's origins -> the app's own SQL
 *   decides who may buy -> a pending purchase row -> only then the Stripe customer and session.
 */

export const appBillingRoutes = new Hono<{ Bindings: Env }>();

const MAX_SUBJECTS = 50;
const MAX_SUBJECT_LENGTH = 128;
const APP_ID = /^[a-z][a-z0-9-]{0,57}$/;

/**
 * Redirect URLs may only go to the app's own origins (#507): its PAS subdomain, its active custom domains and their
 * subdomains, and localhost. A URL elsewhere would send a buyer, mid-payment, to a site the app does not control.
 */
async function isAppRedirectUrl(db: D1Database, appId: string, raw: string): Promise<boolean> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  const host = url.hostname.toLowerCase();
  if (url.username || url.password) return false;
  if (host === 'localhost' || host === '127.0.0.1') return url.protocol === 'http:' || url.protocol === 'https:';
  if (url.protocol !== 'https:') return false;
  const own = `${appId}.proappstore.online`;
  if (host === own || host.endsWith(`.${own}`)) return true;
  const { results } = await db.prepare("SELECT domain FROM app_custom_domains WHERE app_id = ? AND status = 'active'").bind(appId).all<{ domain: string }>();
  return (results ?? []).some((d) => host === d.domain.toLowerCase() || host.endsWith(`.${d.domain.toLowerCase()}`));
}

/** The subject ids of a checkout: opaque to the platform, so only their shape is checked. */
function parseSubjects(raw: unknown, rule: string): string[] {
  if (rule === 'none') {
    if (raw !== undefined && !(Array.isArray(raw) && raw.length === 0)) throw new HttpError('this product takes no subjects', 400);
    return [];
  }
  if (!Array.isArray(raw) || raw.length === 0) throw new HttpError('subjects must be a non-empty list for this product', 400);
  if (raw.length > MAX_SUBJECTS) throw new HttpError(`subjects: at most ${MAX_SUBJECTS} per checkout`, 400);
  const out: string[] = [];
  for (const s of raw) {
    if (typeof s !== 'string' || !s.trim() || s.length > MAX_SUBJECT_LENGTH) throw new HttpError(`each subject must be a non-empty string of at most ${MAX_SUBJECT_LENGTH} characters`, 400);
    out.push(s);
  }
  if (new Set(out).size !== out.length) throw new HttpError('subjects must not repeat', 400);
  return out;
}

interface ProductRow {
  product_key: string;
  modes: string;
  subject: string;
  interval_unit: string | null;
  interval_count: number | null;
  grace_days: number;
}

// No `wrap`: a refusal answers through the platform's error handler, as JSON with a safe errorCode and the trace id (#390).
appBillingRoutes.post('/apps/:appId/billing/checkout', async (c) => {
  const appId = c.req.param('appId')!;
  const user = await requireUser(c);
  if (!APP_ID.test(appId)) throw new HttpError('app not found', 404);
  const db = c.env.DB;

  const app = await db.prepare('SELECT id FROM apps WHERE id = ?').bind(appId).first<{ id: string }>();
  if (!app) throw new HttpError('app not found', 404);
  await requireVisible(c.env, appId, await getAppVisibility(db, appId), user);

  const body = await c.req.json<{ product?: unknown; subjects?: unknown; renew?: unknown; successUrl?: unknown; cancelUrl?: unknown }>().catch(() => null);
  if (!body || typeof body !== 'object') throw new HttpError('JSON body required', 400);

  // Live money is an admin's decision, per app, and off until then. Checked before anything else about the product.
  const config = await db.prepare('SELECT enabled, authorize_action FROM app_billing WHERE app_id = ?').bind(appId).first<{ enabled: number; authorize_action: string | null }>();
  if (config?.enabled !== 1) throw new HttpError('billing is not enabled for this app', 403);

  // Looked up under THIS app: another app's product key resolves to nothing here.
  if (typeof body.product !== 'string') throw new HttpError('product is required', 400);
  const product = await db.prepare('SELECT product_key, modes, subject, interval_unit, interval_count, grace_days FROM app_billing_products WHERE app_id = ? AND product_key = ? AND active = 1')
    .bind(appId, body.product).first<ProductRow>();
  if (!product) throw new HttpError('unknown product', 400);

  const subjects = parseSubjects(body.subjects, product.subject);
  if (body.renew !== undefined && typeof body.renew !== 'boolean') throw new HttpError('renew must be true or false', 400);
  const mode = body.renew === true ? 'recurring' : 'one_time';
  if (!(JSON.parse(product.modes) as string[]).includes(mode)) throw new HttpError(`this product cannot be bought ${mode === 'recurring' ? 'with auto-renew' : 'as a one-off'}`, 400);

  const { successUrl, cancelUrl } = body;
  if (typeof successUrl !== 'string' || typeof cancelUrl !== 'string' || !successUrl || !cancelUrl) throw new HttpError('successUrl and cancelUrl are required', 400);
  if (!(await isAppRedirectUrl(db, appId, successUrl)) || !(await isAppRedirectUrl(db, appId, cancelUrl))) {
    throw new HttpError("successUrl and cancelUrl must be on this app's own origins (its proappstore.online subdomain, a verified custom domain, or localhost)", 400);
  }

  const price = await db.prepare("SELECT stripe_price_id FROM app_billing_prices WHERE app_id = ? AND product_key = ? AND mode = ? AND status = 'active' ORDER BY created_at DESC, rowid DESC LIMIT 1")
    .bind(appId, product.product_key, mode).first<{ stripe_price_id: string }>();
  if (!price) throw new HttpError('this product is not available yet', 503);

  // The app decides who may buy, in its own SQL, before any Stripe call: exactly one row with allowed = 1 or the buyer is refused.
  if (!config.authorize_action) throw new HttpError('this app has no authorize action', 503);
  const tool = await db.prepare("SELECT manifest, state FROM app_tools WHERE app_id = ? AND name = ? AND source = 'code'").bind(appId, config.authorize_action).first<{ manifest: string; state: string | null }>();
  if (!tool) throw new HttpError('this app has no authorize action', 503);
  if (tool.state === 'staged') throw new HttpError('this app is not live yet', 403);
  let payload: unknown;
  try {
    payload = prepareActionQuery(JSON.parse(tool.manifest) as ToolManifest, { product: product.product_key, subjects_json: JSON.stringify(subjects) }, user.id);
  } catch {
    throw new HttpError('the authorize action could not be run', 500);
  }
  const traceparent = downstreamTraceparent(requestTrace(c.req.raw));
  const verdict = await forwardToDataWorker(c.env, appId, 'query', payload, null, traceparent).catch(() => null);
  if (!verdict?.ok) throw new HttpError('could not check whether you may buy this', 502);
  const rows = ((await verdict.json().catch(() => null)) as { rows?: Record<string, unknown>[] } | null)?.rows;
  if (!Array.isArray(rows) || rows.length !== 1 || Number(rows[0]!.allowed) !== 1) throw new HttpError('you may not buy this', 403);

  // The platform's record of the attempt, before Stripe: its id rides in the session metadata, and the subjects stay here.
  const purchaseId = crypto.randomUUID();
  const now = Date.now();
  await db.prepare(
    `INSERT INTO app_purchases (id, app_id, product_key, buyer_user_id, subjects, quantity, mode, status, price_id, interval_unit, interval_count, grace_days, created_at, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'pending', ?8, ?9, ?10, ?11, ?12, ?12)`,
  // The term is snapshotted here (#508): a renewal is computed from the interval and grace the buyer paid for, whatever the manifest says later.
  ).bind(purchaseId, appId, product.product_key, user.id, JSON.stringify(subjects), Math.max(1, subjects.length), mode, price.stripe_price_id, product.interval_unit, product.interval_count, product.grace_days, now).run();

  const stripe = new Stripe(c.env.STRIPE_SECRET_KEY);
  try {
    const customer = await customerFor(c.env, stripe, user.id, user.login);
    const session = await stripe.createAppCheckoutSession({
      customer,
      priceId: price.stripe_price_id,
      quantity: Math.max(1, subjects.length),
      mode: mode === 'recurring' ? 'subscription' : 'payment',
      successUrl,
      cancelUrl,
      metadata: { app_id: appId, product_key: product.product_key, user_id: user.id, purchase_id: purchaseId },
    }, `pas-checkout:${purchaseId}`);
    await db.prepare('UPDATE app_purchases SET stripe_session_id = ?, updated_at = ? WHERE id = ?').bind(session.id, Date.now(), purchaseId).run();
    return c.json({ url: session.url, purchaseId });
  } catch (e) {
    await db.prepare("UPDATE app_purchases SET status = 'failed', updated_at = ? WHERE id = ?").bind(Date.now(), purchaseId).run().catch(() => undefined);
    console.error('[billing] checkout failed', { appId, purchaseId, error: e instanceof Error ? e.message : String(e) });
    throw new HttpError('could not start checkout', 502);
  }
});

/** One Stripe Customer per platform user across every app: ours, else the one a Pro subscription made, else a new one. */
async function customerFor(env: Env, stripe: Stripe, userId: string, login: string): Promise<string> {
  const known = await env.DB.prepare('SELECT stripe_customer_id AS id FROM billing_customers WHERE user_id = ?1 UNION ALL SELECT stripe_customer_id FROM subscriptions WHERE user_id = ?1 AND stripe_customer_id IS NOT NULL LIMIT 1')
    .bind(userId).first<{ id: string }>();
  if (known?.id) {
    await env.DB.prepare('INSERT OR IGNORE INTO billing_customers (user_id, stripe_customer_id, created_at) VALUES (?, ?, ?)').bind(userId, known.id, Date.now()).run();
    return known.id;
  }
  const created = await stripe.createCustomer({ metadata: { user_id: userId, login } });
  await env.DB.prepare('INSERT OR IGNORE INTO billing_customers (user_id, stripe_customer_id, created_at) VALUES (?, ?, ?)').bind(userId, created.id, Date.now()).run();
  // A concurrent first checkout may have stored a different customer: use whichever won, so there is one per user.
  return (await env.DB.prepare('SELECT stripe_customer_id AS id FROM billing_customers WHERE user_id = ?').bind(userId).first<{ id: string }>())?.id ?? created.id;
}
