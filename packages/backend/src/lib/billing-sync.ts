import type { BillingMode } from './manifest/billing.js';

/**
 * Mirror an app's declared products to Stripe (#507): a Product per product, a Price per (product, mode).
 *
 * Idempotent and additive. A redeploy with nothing changed makes no Stripe call at all. A changed amount, currency, tax
 * behaviour or interval creates a NEW Price and then archives the old one: Stripe Prices are immutable, and an old
 * receipt or subscription must keep resolving. Nothing is ever deleted. Stripe POSTs carry an idempotency key made from the
 * thing being created, so a deploy retried after a half-finished sync converges instead of duplicating.
 */

/** The slice of the Stripe client this needs, so a test can hand in a fake. */
export interface BillingStripe {
  createProduct(params: { name: string; metadata: Record<string, string> }, idempotencyKey?: string): Promise<{ id: string }>;
  updateProduct(productId: string, params: { name: string }): Promise<{ id: string }>;
  createPrice(params: { productId: string; amount: number; currency: string; taxBehavior: string; interval?: { unit: string; count: number }; metadata: Record<string, string> }, idempotencyKey?: string): Promise<{ id: string }>;
  archivePrice(priceId: string): Promise<{ id: string }>;
}

interface ProductRow {
  product_key: string;
  name: string;
  amount: number;
  currency: string;
  tax_behavior: string;
  modes: string;
  interval_unit: string | null;
  interval_count: number | null;
  stripe_product_id: string | null;
  stripe_name: string | null;
}
interface PriceRow {
  stripe_price_id: string;
  mode: BillingMode;
  amount: number;
  currency: string;
  tax_behavior: string;
  interval_unit: string | null;
  interval_count: number | null;
}

export interface SyncResult {
  productsCreated: number;
  pricesCreated: number;
  pricesArchived: number;
  /** Product keys whose sync failed; the row keeps the error and the next deploy retries. */
  failed: { key: string; error: string }[];
}

async function sha(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].slice(0, 8).map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function syncBillingProducts(db: D1Database, stripe: BillingStripe, appId: string): Promise<SyncResult> {
  const result: SyncResult = { productsCreated: 0, pricesCreated: 0, pricesArchived: 0, failed: [] };
  const { results } = await db.prepare(
    `SELECT product_key, name, amount, currency, tax_behavior, modes, interval_unit, interval_count, stripe_product_id, stripe_name
       FROM app_billing_products WHERE app_id = ? AND active = 1 ORDER BY product_key`,
  ).bind(appId).all<ProductRow>();

  for (const p of results ?? []) {
    try {
      const metadata = { app_id: appId, product_key: p.product_key };
      let productId = p.stripe_product_id;
      if (!productId) {
        productId = (await stripe.createProduct({ name: p.name, metadata }, `pas-product:${appId}:${p.product_key}`)).id;
        result.productsCreated++;
        await db.prepare('UPDATE app_billing_products SET stripe_product_id = ?, stripe_name = ?, updated_at = ? WHERE app_id = ? AND product_key = ?')
          .bind(productId, p.name, Date.now(), appId, p.product_key).run();
      } else if (p.stripe_name !== p.name) {
        await stripe.updateProduct(productId, { name: p.name });
        await db.prepare('UPDATE app_billing_products SET stripe_name = ?, updated_at = ? WHERE app_id = ? AND product_key = ?').bind(p.name, Date.now(), appId, p.product_key).run();
      }

      const modes = JSON.parse(p.modes) as BillingMode[];
      const active = await db.prepare(
        "SELECT stripe_price_id, mode, amount, currency, tax_behavior, interval_unit, interval_count FROM app_billing_prices WHERE app_id = ? AND product_key = ? AND status = 'active' ORDER BY created_at ASC, rowid ASC",
      ).bind(appId, p.product_key).all<PriceRow>();
      // Two active prices for one mode mean an earlier sync stopped between creating the new price and archiving the old:
      // keep the newest, archive the rest.
      const byMode = new Map<BillingMode, PriceRow>();
      for (const r of active.results ?? []) {
        const older = byMode.get(r.mode);
        if (older) {
          await stripe.archivePrice(older.stripe_price_id);
          await archived(db, older.stripe_price_id);
          result.pricesArchived++;
        }
        byMode.set(r.mode, r);
      }

      for (const mode of ['one_time', 'recurring'] as const) {
        const current = byMode.get(mode);
        if (!modes.includes(mode)) {
          // The product no longer sells this way: archive its price so nothing new can be bought at it.
          if (current) {
            await stripe.archivePrice(current.stripe_price_id);
            await archived(db, current.stripe_price_id);
            result.pricesArchived++;
          }
          continue;
        }
        const interval = mode === 'recurring' && p.interval_unit && p.interval_count ? { unit: p.interval_unit, count: p.interval_count } : undefined;
        const same = current
          && current.amount === p.amount && current.currency === p.currency && current.tax_behavior === p.tax_behavior
          && (current.interval_unit ?? null) === (interval?.unit ?? null) && (current.interval_count ?? null) === (interval?.count ?? null);
        if (same) continue;

        const spec = `${productId}|${mode}|${p.amount}|${p.currency}|${p.tax_behavior}|${interval?.unit ?? ''}|${interval?.count ?? ''}`;
        const created = await stripe.createPrice(
          { productId, amount: p.amount, currency: p.currency, taxBehavior: p.tax_behavior, ...(interval ? { interval } : {}), metadata: { ...metadata, mode } },
          `pas-price:${await sha(spec)}`,
        );
        result.pricesCreated++;
        // The new price is recorded before the old one is archived: a failure in between leaves two active rows for one
        // mode, which the next sync resolves by archiving the older, and never leaves a product with no price to sell.
        await db.prepare(
          `INSERT OR IGNORE INTO app_billing_prices (stripe_price_id, app_id, product_key, mode, amount, currency, tax_behavior, interval_unit, interval_count, status, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?)`,
        ).bind(created.id, appId, p.product_key, mode, p.amount, p.currency, p.tax_behavior, interval?.unit ?? null, interval?.count ?? null, Date.now()).run();
        if (current) {
          await stripe.archivePrice(current.stripe_price_id);
          await archived(db, current.stripe_price_id);
          result.pricesArchived++;
        }
      }
      await db.prepare('UPDATE app_billing_products SET sync_error = NULL WHERE app_id = ? AND product_key = ?').bind(appId, p.product_key).run();
    } catch (e) {
      const error = (e instanceof Error ? e.message : String(e)).slice(0, 300);
      result.failed.push({ key: p.product_key, error });
      await db.prepare('UPDATE app_billing_products SET sync_error = ? WHERE app_id = ? AND product_key = ?').bind(error, appId, p.product_key).run().catch(() => undefined);
    }
  }
  return result;
}

async function archived(db: D1Database, priceId: string): Promise<void> {
  await db.prepare("UPDATE app_billing_prices SET status = 'archived', archived_at = ? WHERE stripe_price_id = ?").bind(Date.now(), priceId).run();
}
