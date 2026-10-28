import type { Env } from '../types.js';
import { Stripe } from './stripe.js';

/**
 * The per-app revenue ledger (#509, epic #506). The platform sells every app's products through its own Stripe account, so what an app
 * earned is attributed here, per purchase: gross (what the buyer paid), refunds, and Stripe's fee.
 *
 * Gross is already recorded by the entitlement layer (app_billing_payments). This adds what only the charge knows. A charge event
 * is stored by its charge id as Stripe sent it (a refund total only ever rises, a fee is written once), and is tied to a purchase at
 * READ time through the payment intent / invoice / charge ids the purchase recorded. So the ledger is the same whichever of the
 * charge event and the checkout event arrives first, and a redelivery changes nothing.
 */

const CHARGE_EVENTS = new Set(['charge.succeeded', 'charge.updated', 'charge.refunded']);
const FEES_PER_TICK = 20;

const asString = (v: unknown): string | null => (typeof v === 'string' && v ? v : v && typeof v === 'object' && typeof (v as { id?: unknown }).id === 'string' ? (v as { id: string }).id : null);
const asInt = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? Math.max(0, Math.trunc(v)) : 0);

/** Remember what a charge event says. Safe to repeat and to receive in any order. Returns whether the event was a charge event. */
export async function recordChargeEvent(db: D1Database, event: unknown, now: number = Date.now()): Promise<boolean> {
  const e = event as { type?: unknown; data?: { object?: Record<string, unknown> } } | null;
  if (!e || typeof e.type !== 'string' || !CHARGE_EVENTS.has(e.type)) return false;
  const c = e.data?.object;
  const chargeId = asString(c?.id);
  if (!c || !chargeId || typeof c.currency !== 'string') return false;
  await db.prepare(
    `INSERT INTO app_billing_charges (charge_id, payment_intent, invoice, amount, currency, amount_refunded, balance_transaction, created_at, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?8)
     ON CONFLICT(charge_id) DO UPDATE SET
       payment_intent = COALESCE(app_billing_charges.payment_intent, excluded.payment_intent),
       invoice = COALESCE(app_billing_charges.invoice, excluded.invoice),
       amount_refunded = MAX(app_billing_charges.amount_refunded, excluded.amount_refunded),
       balance_transaction = COALESCE(app_billing_charges.balance_transaction, excluded.balance_transaction),
       updated_at = excluded.updated_at`,
  ).bind(chargeId, asString(c.payment_intent), asString(c.invoice), asInt(c.amount), c.currency.toLowerCase(), asInt(c.amount_refunded), asString(c.balance_transaction), now).run();
  return true;
}

/**
 * Read Stripe's fee for charges that belong to an app purchase and have none yet. A few per tick; one that fails stays unread for
 * the next. A charge nobody bought an app product with (a Pro subscription's) is never looked up.
 */
export async function fillChargeFees(env: Pick<Env, 'DB' | 'STRIPE_SECRET_KEY'>, limit: number = FEES_PER_TICK): Promise<number> {
  if (!env.STRIPE_SECRET_KEY) return 0;
  const { results } = await env.DB.prepare(
    `SELECT c.charge_id, c.balance_transaction FROM app_billing_charges c
      WHERE c.fee IS NULL AND c.balance_transaction IS NOT NULL
        AND EXISTS (SELECT 1 FROM app_billing_payment_refs r WHERE r.ref IN (c.payment_intent, c.invoice, c.charge_id))
      ORDER BY c.created_at LIMIT ?`,
  ).bind(limit).all<{ charge_id: string; balance_transaction: string }>();
  const stripe = new Stripe(env.STRIPE_SECRET_KEY);
  let filled = 0;
  for (const row of results ?? []) {
    try {
      const txn = await stripe.getBalanceTransaction(row.balance_transaction);
      await env.DB.prepare('UPDATE app_billing_charges SET fee = ?, fee_currency = ?, updated_at = ? WHERE charge_id = ? AND fee IS NULL')
        .bind(Math.max(0, Math.trunc(txn.fee)), txn.currency, Date.now(), row.charge_id).run();
      filled++;
    } catch (e) {
      console.warn('[billing] fee lookup failed', { chargeId: row.charge_id, error: e instanceof Error ? e.message : String(e) });
    }
  }
  return filled;
}

interface LedgerPurchase {
  purchaseId: string;
  product: string;
  buyerUserId: string;
  subjects: string[];
  mode: string;
  status: string;
  createdAt: number;
  currency: string | null;
  /** What the buyer paid, across the purchase's payments. */
  gross: number;
  /** What has been refunded of it. */
  refunded: number;
  /** Stripe's fee, in `feeCurrency`; null until it has been read. */
  fee: number | null;
  feeCurrency: string | null;
  /** Gross less refunds less fee (a fee not yet read counts as 0). */
  net: number;
}

export interface Ledger {
  purchases: LedgerPurchase[];
  /** Totals by currency, over the purchases returned. */
  totals: { currency: string; gross: number; refunded: number; fee: number; net: number }[];
}

interface LedgerRow {
  id: string; product_key: string; buyer_user_id: string; subjects: string; mode: string; status: string; created_at: number;
  currency: string | null; gross: number; refunded: number; fee: number | null; fee_currency: string | null;
}

/** The ledger of one app: its purchases that have been paid, newest first, with refunds and fees. */
export async function appLedger(db: D1Database, appId: string, limit = 200): Promise<Ledger> {
  const { results } = await db.prepare(
    `SELECT p.id, p.product_key, p.buyer_user_id, p.subjects, p.mode, p.status, p.created_at,
            (SELECT currency FROM app_billing_payments WHERE purchase_id = p.id ORDER BY paid_at LIMIT 1) AS currency,
            (SELECT COALESCE(SUM(amount), 0) FROM app_billing_payments WHERE purchase_id = p.id) AS gross,
            (SELECT COALESCE(SUM(c.amount_refunded), 0) FROM app_billing_charges c
               WHERE EXISTS (SELECT 1 FROM app_billing_payment_refs r WHERE r.purchase_id = p.id AND r.ref IN (c.payment_intent, c.invoice, c.charge_id))) AS refunded,
            (SELECT SUM(c.fee) FROM app_billing_charges c
               WHERE EXISTS (SELECT 1 FROM app_billing_payment_refs r WHERE r.purchase_id = p.id AND r.ref IN (c.payment_intent, c.invoice, c.charge_id))) AS fee,
            (SELECT MAX(c.fee_currency) FROM app_billing_charges c
               WHERE EXISTS (SELECT 1 FROM app_billing_payment_refs r WHERE r.purchase_id = p.id AND r.ref IN (c.payment_intent, c.invoice, c.charge_id))) AS fee_currency
       FROM app_purchases p
      WHERE p.app_id = ? AND EXISTS (SELECT 1 FROM app_billing_payments WHERE purchase_id = p.id)
      ORDER BY p.created_at DESC, p.id LIMIT ?`,
  ).bind(appId, limit).all<LedgerRow>();

  const purchases: LedgerPurchase[] = (results ?? []).map((r) => ({
    purchaseId: r.id, product: r.product_key, buyerUserId: r.buyer_user_id, subjects: JSON.parse(r.subjects) as string[], mode: r.mode, status: r.status,
    createdAt: r.created_at, currency: r.currency, gross: r.gross, refunded: r.refunded, fee: r.fee, feeCurrency: r.fee_currency,
    net: r.gross - r.refunded - (r.fee ?? 0),
  }));
  const byCurrency = new Map<string, Ledger['totals'][number]>();
  for (const p of purchases) {
    const key = p.currency ?? '';
    const t = byCurrency.get(key) ?? { currency: key, gross: 0, refunded: 0, fee: 0, net: 0 };
    t.gross += p.gross; t.refunded += p.refunded; t.fee += p.fee ?? 0; t.net += p.net;
    byCurrency.set(key, t);
  }
  return { purchases, totals: [...byCurrency.values()] };
}
