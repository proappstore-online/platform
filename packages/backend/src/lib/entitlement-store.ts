import { computeEntitlement, type Entitlement, type PurchaseFacts } from './entitlements.js';
import type { StripeEnv } from './stripe-env.js';

/**
 * The database side of the entitlement rules (#508): load every fact about one (app, product, subject), compute, and write the
 * entitlement only if it changed. Events never edit an entitlement; they record facts and call this.
 */

interface PurchaseRow {
  id: string;
  app_id: string;
  product_key: string;
  buyer_user_id: string;
  subjects: string;
  mode: 'one_time' | 'recurring';
  created_at: number;
  interval_unit: string | null;
  interval_count: number | null;
  grace_days: number;
  failed_at: number | null;
  refunded_at: number | null;
  sub_cancel_at_period_end: number;
  sub_ended_at: number | null;
  stripe_env: StripeEnv;
}

interface EntitlementRow {
  status: string;
  period_start: number | null;
  period_end: number | null;
  grace_until: number | null;
  renews: number;
  buyer_user_id: string | null;
  purchase_id: string | null;
}

/** The subjects a purchase covers; a product with none is the empty-string subject. */
function subjectsOf(row: PurchaseRow): string[] {
  try {
    const parsed = JSON.parse(row.subjects) as unknown;
    const list = Array.isArray(parsed) ? parsed.filter((s): s is string => typeof s === 'string') : [];
    return list.length > 0 ? list : [''];
  } catch {
    return [''];
  }
}

async function factsFor(db: D1Database, appId: string, productKey: string, subject: string, stripeEnv: StripeEnv): Promise<PurchaseFacts[]> {
  const where = subject === ''
    ? 'json_array_length(subjects) = 0'
    : 'EXISTS (SELECT 1 FROM json_each(app_purchases.subjects) WHERE value = ?4)';
  const binds = subject === '' ? [appId, productKey, stripeEnv] : [appId, productKey, stripeEnv, subject];
  // #519: a live and a test purchase of the same (app, product, subject) must never be facts of the same entitlement.
  const { results } = await db.prepare(`SELECT * FROM app_purchases WHERE app_id = ?1 AND product_key = ?2 AND stripe_env = ?3 AND ${where}`).bind(...binds).all<PurchaseRow>();
  const purchases = results ?? [];
  if (purchases.length === 0) return [];

  const marks = purchases.map(() => '?').join(', ');
  const paid = await db.prepare(`SELECT id, purchase_id, paid_at FROM app_billing_payments WHERE purchase_id IN (${marks})`)
    .bind(...purchases.map((p) => p.id)).all<{ id: string; purchase_id: string; paid_at: number }>();
  const byPurchase = new Map<string, { id: string; paidAt: number }[]>();
  for (const p of paid.results ?? []) byPurchase.set(p.purchase_id, [...(byPurchase.get(p.purchase_id) ?? []), { id: p.id, paidAt: p.paid_at }]);

  return purchases.map((p) => ({
    id: p.id,
    mode: p.mode,
    buyerUserId: p.buyer_user_id,
    createdAt: p.created_at,
    terms: { intervalUnit: p.interval_unit, intervalCount: p.interval_count, graceDays: p.grace_days },
    payments: byPurchase.get(p.id) ?? [],
    failedAt: p.failed_at,
    refundedAt: p.refunded_at,
    cancelAtPeriodEnd: p.sub_cancel_at_period_end === 1,
    endedAt: p.sub_ended_at,
  }));
}

const same = (a: EntitlementRow, e: Entitlement): boolean =>
  a.status === e.status && a.period_start === e.periodStart && a.period_end === e.periodEnd && a.grace_until === e.graceUntil
  && a.renews === (e.renews ? 1 : 0) && a.buyer_user_id === e.buyerUserId && a.purchase_id === e.purchaseId;

/**
 * Recompute one subject. Returns true when the stored entitlement changed (its version rose). `stripeEnv`
 * defaults to 'live' so existing one-env callers are unaffected (#519); the sweep and the handler pass the
 * purchase's own env explicitly.
 */
export async function recomputeSubject(db: D1Database, appId: string, productKey: string, subject: string, now: number, stripeEnv: StripeEnv = 'live'): Promise<boolean> {
  const entitlement = computeEntitlement(await factsFor(db, appId, productKey, subject, stripeEnv), now);
  if (!entitlement) return false;
  const stored = await db.prepare('SELECT status, period_start, period_end, grace_until, renews, buyer_user_id, purchase_id FROM app_entitlements WHERE app_id = ? AND product_key = ? AND subject = ? AND stripe_env = ?')
    .bind(appId, productKey, subject, stripeEnv).first<EntitlementRow>();
  if (stored && same(stored, entitlement)) return false;
  await db.prepare(
    `INSERT INTO app_entitlements (app_id, product_key, subject, stripe_env, status, period_start, period_end, grace_until, renews, buyer_user_id, purchase_id, version, created_at, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, 1, ?12, ?12)
     ON CONFLICT(app_id, product_key, subject, stripe_env) DO UPDATE SET status = excluded.status, period_start = excluded.period_start, period_end = excluded.period_end,
       grace_until = excluded.grace_until, renews = excluded.renews, buyer_user_id = excluded.buyer_user_id, purchase_id = excluded.purchase_id,
       version = app_entitlements.version + 1, updated_at = excluded.updated_at`,
  ).bind(appId, productKey, subject, stripeEnv, entitlement.status, entitlement.periodStart, entitlement.periodEnd, entitlement.graceUntil, entitlement.renews ? 1 : 0, entitlement.buyerUserId, entitlement.purchaseId, now).run();
  return true;
}

/** Recompute every subject one purchase covers; returns how many entitlements changed. The purchase's own stripe_env
 *  (stamped at checkout, #519) decides which entitlement env is touched — never re-derived from app_billing's current one. */
export async function recomputePurchase(db: D1Database, purchaseId: string, now: number): Promise<number> {
  const row = await db.prepare('SELECT * FROM app_purchases WHERE id = ?').bind(purchaseId).first<PurchaseRow>();
  if (!row) return 0;
  let changed = 0;
  for (const subject of subjectsOf(row)) if (await recomputeSubject(db, row.app_id, row.product_key, subject, now, row.stripe_env)) changed++;
  return changed;
}
