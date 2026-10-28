import { describe, expect, it, vi } from 'vitest';
import { sqliteD1 } from '../sqlite-d1.js';
import { syncBillingProducts, type BillingStripe } from './billing-sync.js';

// #507: products declared in the manifest are mirrored to Stripe once, and a redeploy with nothing changed makes no call. Real SQL.

function fakeStripe() {
  let n = 0;
  const calls: string[] = [];
  const stripe: BillingStripe = {
    createProduct: vi.fn(async (p) => { calls.push(`product:${p.name}`); return { id: `prod_${++n}` }; }),
    updateProduct: vi.fn(async (id, p) => { calls.push(`rename:${id}:${p.name}`); return { id }; }),
    createPrice: vi.fn(async (p) => { calls.push(`price:${p.amount}:${p.interval ? 'rec' : 'one'}`); return { id: `price_${++n}` }; }),
    archivePrice: vi.fn(async (id) => { calls.push(`archive:${id}`); return { id }; }),
  };
  return { stripe, calls };
}

async function product(db: D1Database, over: Record<string, unknown> = {}) {
  const p = { name: 'Term', amount: 1000, currency: 'aud', tax: 'inclusive', modes: '["one_time","recurring"]', unit: 'month', count: 3, ...over };
  await db.prepare(
    `INSERT OR REPLACE INTO app_billing_products (app_id, product_key, name, amount, currency, tax_behavior, modes, interval_unit, interval_count, grace_days, subject, active, stripe_product_id, stripe_name, created_at, updated_at)
     VALUES ('club', 'term', ?, ?, ?, ?, ?, ?, ?, 5, 'required', 1, (SELECT stripe_product_id FROM app_billing_products WHERE app_id = 'club' AND product_key = 'term'), (SELECT stripe_name FROM app_billing_products WHERE app_id = 'club' AND product_key = 'term'), 1, 1)`,
  ).bind(p.name, p.amount, p.currency, p.tax, p.modes, p.unit, p.count).run();
}
const prices = async (db: D1Database) => (await db.prepare('SELECT mode, amount, status FROM app_billing_prices ORDER BY created_at, rowid').all<Record<string, unknown>>()).results;

describe('syncBillingProducts', () => {
  it('creates a product and a price per mode, then a redeploy with nothing changed calls nothing', async () => {
    const db = sqliteD1();
    const { stripe, calls } = fakeStripe();
    await product(db);
    expect(await syncBillingProducts(db, stripe, 'club')).toEqual({ productsCreated: 1, pricesCreated: 2, pricesArchived: 0, failed: [] });
    expect(calls).toEqual(['product:Term', 'price:1000:one', 'price:1000:rec']);
    calls.length = 0;
    expect(await syncBillingProducts(db, stripe, 'club')).toEqual({ productsCreated: 0, pricesCreated: 0, pricesArchived: 0, failed: [] });
    expect(calls).toEqual([]);
  });

  it('a changed amount makes a new price and archives the old one; a rename updates the product', async () => {
    const db = sqliteD1();
    const { stripe, calls } = fakeStripe();
    await product(db);
    await syncBillingProducts(db, stripe, 'club');
    calls.length = 0;
    await product(db, { amount: 1500, name: 'Term v2' });
    const r = await syncBillingProducts(db, stripe, 'club');
    expect(r).toMatchObject({ productsCreated: 0, pricesCreated: 2, pricesArchived: 2 });
    expect(calls.filter((c) => c.startsWith('rename'))).toHaveLength(1);
    expect((await prices(db)).filter((p) => p.status === 'active').map((p) => p.amount)).toEqual([1500, 1500]);
  });

  it('archives the price of a mode the product no longer sells', async () => {
    const db = sqliteD1();
    const { stripe } = fakeStripe();
    await product(db);
    await syncBillingProducts(db, stripe, 'club');
    await product(db, { modes: '["one_time"]' });
    expect(await syncBillingProducts(db, stripe, 'club')).toMatchObject({ pricesCreated: 0, pricesArchived: 1 });
    expect((await prices(db)).filter((p) => p.status === 'active').map((p) => p.mode)).toEqual(['one_time']);
  });

  it('two active prices for one mode (an interrupted sync) are resolved by archiving the older', async () => {
    const db = sqliteD1();
    const { stripe, calls } = fakeStripe();
    await product(db, { modes: '["one_time"]' });
    await syncBillingProducts(db, stripe, 'club');
    await db.prepare("INSERT INTO app_billing_prices (stripe_price_id, app_id, product_key, mode, amount, currency, tax_behavior, status, created_at) VALUES ('price_dup', 'club', 'term', 'one_time', 1000, 'aud', 'inclusive', 'active', 9999999999999)").run();
    calls.length = 0;
    expect(await syncBillingProducts(db, stripe, 'club')).toMatchObject({ pricesArchived: 1, pricesCreated: 0 });
    expect(calls).toHaveLength(1);
    expect((await db.prepare("SELECT stripe_price_id FROM app_billing_prices WHERE status = 'active'").all<{ stripe_price_id: string }>()).results).toEqual([{ stripe_price_id: 'price_dup' }]);
  });

  it('records a Stripe failure on the product and carries on; the next sync clears it', async () => {
    const db = sqliteD1();
    const { stripe } = fakeStripe();
    await product(db);
    stripe.createProduct = vi.fn(async () => { throw new Error('stripe is down'); });
    expect(await syncBillingProducts(db, stripe, 'club')).toMatchObject({ failed: [{ key: 'term', error: 'stripe is down' }] });
    expect((await db.prepare('SELECT sync_error FROM app_billing_products').first<{ sync_error: string }>())!.sync_error).toBe('stripe is down');
    const ok = fakeStripe();
    await syncBillingProducts(db, ok.stripe, 'club');
    expect((await db.prepare('SELECT sync_error FROM app_billing_products').first<{ sync_error: string | null }>())!.sync_error).toBeNull();
  });

  it('does nothing for an app with no products', async () => {
    expect(await syncBillingProducts(sqliteD1(), fakeStripe().stripe, 'empty')).toEqual({ productsCreated: 0, pricesCreated: 0, pricesArchived: 0, failed: [] });
  });
});
