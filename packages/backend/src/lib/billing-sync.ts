/**
 * Deploy-time Stripe upsert for an app's products (#507).
 *
 * Runs after the manifest registers (D1 already holds the definitions in app_products). For each
 * active product: ensure a Stripe Product (metadata app_id, product_key), and for each mode in
 * `modes` ensure one active Price matching the declared amount, currency, tax_behavior and, for
 * recurring, interval/interval_count. Stripe Prices are immutable, so a change creates a new
 * Price (version + 1), makes it current, and archives the old one. Nothing is ever deleted, and a
 * redeploy with nothing changed makes no Stripe write. Products dropped from the manifest are
 * left alone in Stripe.
 *
 * Idempotency keys carry the price version, never just the amount: a key reused for an amount
 * that comes back (A, B, A within Stripe's 24h window) would return the archived price.
 */
import { Stripe } from './stripe.js';

interface ProductRow {
  product_key: string; name: string; amount: number; currency: string; tax_behavior: string; modes: string;
  interval_unit: string | null; interval_count: number | null; stripe_product_id: string | null; stripe_name: string | null;
}
interface PriceRow {
  product_key: string; kind: string; version: number; stripe_price_id: string; amount: number; currency: string;
  tax_behavior: string; interval_unit: string | null; interval_count: number | null;
}

export interface BillingSyncResult { products: number; pricesCreated: number; pricesArchived: number; warnings: string[] }

export async function syncBillingToStripe(env: { DB: D1Database; STRIPE_SECRET_KEY?: string | undefined }, appId: string): Promise<BillingSyncResult> {
  const out: BillingSyncResult = { products: 0, pricesCreated: 0, pricesArchived: 0, warnings: [] };
  const db = env.DB;
  const { results: products } = await db.prepare(
    'SELECT product_key, name, amount, currency, tax_behavior, modes, interval_unit, interval_count, stripe_product_id, stripe_name FROM app_products WHERE app_id = ? AND active = 1',
  ).bind(appId).all<ProductRow>();
  if (!products?.length) return out;
  if (!env.STRIPE_SECRET_KEY) {
    out.warnings.push('billing: STRIPE_SECRET_KEY is not configured; products are registered but not created in Stripe, so checkout is unavailable until the next deploy');
    return out;
  }
  const stripe = new Stripe(env.STRIPE_SECRET_KEY);

  for (const p of products) {
    try {
      let productId = p.stripe_product_id;
      if (!productId) {
        const created = await stripe.createProduct({
          name: p.name, metadata: { app_id: appId, product_key: p.product_key }, idempotencyKey: `pas-product-${appId}-${p.product_key}`,
        });
        productId = created.id;
        await db.prepare('UPDATE app_products SET stripe_product_id = ?, stripe_name = ? WHERE app_id = ? AND product_key = ?')
          .bind(productId, p.name, appId, p.product_key).run();
      } else if (p.stripe_name !== p.name) {
        await stripe.updateProductName(productId, p.name);
        await db.prepare('UPDATE app_products SET stripe_name = ? WHERE app_id = ? AND product_key = ?').bind(p.name, appId, p.product_key).run();
      }
      out.products++;

      const modes = JSON.parse(p.modes) as string[];
      const { results: prices } = await db.prepare(
        'SELECT product_key, kind, version, stripe_price_id, amount, currency, tax_behavior, interval_unit, interval_count FROM app_product_prices WHERE app_id = ? AND product_key = ? AND active = 1',
      ).bind(appId, p.product_key).all<PriceRow>();
      for (const kind of ['one_time', 'recurring'] as const) {
        const current = (prices ?? []).find((r) => r.kind === kind);
        if (!modes.includes(kind)) {
          // The mode was dropped: retire its price (archived below).
          if (current) await db.prepare('UPDATE app_product_prices SET active = 0 WHERE app_id = ? AND product_key = ? AND kind = ? AND version = ?')
            .bind(appId, p.product_key, kind, current.version).run();
          continue;
        }
        const unit = kind === 'recurring' ? p.interval_unit : null;
        const count = kind === 'recurring' ? p.interval_count : null;
        const same = current && current.amount === p.amount && current.currency === p.currency && current.tax_behavior === p.tax_behavior
          && current.interval_unit === unit && current.interval_count === count;
        if (same) continue;
        const version = (current?.version ?? await latestVersion(db, appId, p.product_key, kind)) + 1;
        const created = await stripe.createPrice({
          product: productId, amount: p.amount, currency: p.currency, taxBehavior: p.tax_behavior,
          ...(unit && count ? { recurring: { unit, count } } : {}),
          metadata: { app_id: appId, product_key: p.product_key },
          idempotencyKey: `pas-price-${appId}-${p.product_key}-${kind}-v${version}`,
        });
        out.pricesCreated++;
        await db.batch([
          db.prepare('UPDATE app_product_prices SET active = 0 WHERE app_id = ? AND product_key = ? AND kind = ? AND active = 1').bind(appId, p.product_key, kind),
          db.prepare(
            `INSERT INTO app_product_prices (app_id, product_key, kind, version, stripe_price_id, amount, currency, tax_behavior, interval_unit, interval_count, active, archived, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 0, ?)`,
          ).bind(appId, p.product_key, kind, version, created.id, p.amount, p.currency, p.tax_behavior, unit, count, Date.now()),
        ]);
      }
    } catch (e) {
      out.warnings.push(`billing: product "${p.product_key}" was not fully synced to Stripe (${(e as Error).message.slice(0, 200)}); redeploy to retry`);
    }
  }

  // Retired prices are archived, not deleted; retried here until Stripe confirms.
  try {
    const { results: stale } = await db.prepare(
      'SELECT product_key, kind, version, stripe_price_id FROM app_product_prices WHERE app_id = ? AND active = 0 AND archived = 0',
    ).bind(appId).all<{ product_key: string; kind: string; version: number; stripe_price_id: string }>();
    for (const r of stale ?? []) {
      try {
        await stripe.archivePrice(r.stripe_price_id);
        await db.prepare('UPDATE app_product_prices SET archived = 1 WHERE app_id = ? AND product_key = ? AND kind = ? AND version = ?')
          .bind(appId, r.product_key, r.kind, r.version).run();
        out.pricesArchived++;
      } catch (e) {
        out.warnings.push(`billing: could not archive the old price of "${r.product_key}" (${(e as Error).message.slice(0, 120)}); redeploy to retry`);
      }
    }
  } catch (e) {
    out.warnings.push(`billing: could not read prices to archive (${(e as Error).message.slice(0, 120)})`);
  }
  return out;
}

async function latestVersion(db: D1Database, appId: string, key: string, kind: string): Promise<number> {
  const row = await db.prepare('SELECT MAX(version) AS v FROM app_product_prices WHERE app_id = ? AND product_key = ? AND kind = ?')
    .bind(appId, key, kind).first<{ v: number | null }>();
  return row?.v ?? 0;
}
