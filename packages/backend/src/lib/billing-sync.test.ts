import { beforeEach, describe, expect, it, vi } from 'vitest';
import { syncBillingToStripe } from './billing-sync.js';

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

interface Row { [k: string]: unknown }
interface Fixture { products?: Row[]; prices?: Row[]; stale?: Row[]; maxVersion?: number }

/** A D1 stand-in that answers by SQL text and records every write. */
function fakeDb(fx: Fixture) {
  const writes: { sql: string; args: unknown[] }[] = [];
  const answer = (sql: string) => {
    if (sql.includes('FROM app_products')) return { results: fx.products ?? [] };
    if (sql.includes('active = 0 AND archived = 0')) return { results: fx.stale ?? [] };
    if (sql.includes('FROM app_product_prices')) return { results: fx.prices ?? [] };
    return { results: [] };
  };
  const prepare = (sql: string) => ({
    bind: (...args: unknown[]) => ({
      sql,
      args,
      all: async () => answer(sql),
      first: async () => (sql.includes('MAX(version)') ? { v: fx.maxVersion ?? 0 } : null),
      run: async () => { writes.push({ sql, args }); return { meta: { changes: 1 } }; },
    }),
  });
  const batch = async (stmts: { sql: string; args: unknown[] }[]) => {
    for (const s of stmts) writes.push({ sql: s.sql, args: s.args });
    return [];
  };
  return { db: { prepare, batch } as unknown as D1Database, writes };
}

function stripeOk(...ids: string[]) {
  for (const id of ids) mockFetch.mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ id }) } as Response);
}

const product = (over: Row = {}): Row => ({
  product_key: 'child_term', name: 'Term (per child)', amount: 1000, currency: 'aud', tax_behavior: 'inclusive',
  modes: '["one_time"]', interval_unit: null, interval_count: null, stripe_product_id: null, stripe_name: null, ...over,
});
const price = (over: Row = {}): Row => ({
  product_key: 'child_term', kind: 'one_time', version: 1, stripe_price_id: 'price_old', amount: 1000, currency: 'aud',
  tax_behavior: 'inclusive', interval_unit: null, interval_count: null, ...over,
});
const calls = () => mockFetch.mock.calls.map(([url, init]) => ({ url: url as string, body: String((init as RequestInit).body) }));

describe('syncBillingToStripe (#507)', () => {
  beforeEach(() => mockFetch.mockReset());

  it('creates the Stripe Product and a one-time Price tagged with app_id and product_key', async () => {
    const { db, writes } = fakeDb({ products: [product()] });
    stripeOk('prod_1', 'price_1');
    const out = await syncBillingToStripe({ DB: db, STRIPE_SECRET_KEY: 'sk_test_x' }, 'chess');
    expect(out).toMatchObject({ products: 1, pricesCreated: 1, pricesArchived: 0, warnings: [] });
    const [p, pr] = calls();
    expect(p!.url).toBe('https://api.stripe.com/v1/products');
    expect(p!.body).toContain('metadata%5Bapp_id%5D=chess');
    expect(p!.body).toContain('metadata%5Bproduct_key%5D=child_term');
    expect(pr!.url).toBe('https://api.stripe.com/v1/prices');
    expect(pr!.body).toContain('unit_amount=1000');
    expect(pr!.body).toContain('currency=aud');
    expect(pr!.body).toContain('tax_behavior=inclusive');
    expect(pr!.body).not.toContain('recurring');
    expect(writes.some((w) => w.sql.includes('INSERT INTO app_product_prices'))).toBe(true);
  });

  it('sends interval and interval_count for a recurring Price', async () => {
    const { db } = fakeDb({ products: [product({ modes: '["recurring"]', interval_unit: 'month', interval_count: 3 })] });
    stripeOk('prod_1', 'price_r');
    await syncBillingToStripe({ DB: db, STRIPE_SECRET_KEY: 'sk_test_x' }, 'chess');
    const body = calls()[1]!.body;
    expect(body).toContain('recurring%5Binterval%5D=month');
    expect(body).toContain('recurring%5Binterval_count%5D=3');
  });

  it('makes no Stripe call at all on a redeploy with the same amount', async () => {
    const { db, writes } = fakeDb({
      products: [product({ stripe_product_id: 'prod_1', stripe_name: 'Term (per child)' })],
      prices: [price()],
    });
    const out = await syncBillingToStripe({ DB: db, STRIPE_SECRET_KEY: 'sk_test_x' }, 'chess');
    expect(mockFetch).not.toHaveBeenCalled();
    expect(out).toMatchObject({ pricesCreated: 0, pricesArchived: 0, warnings: [] });
    expect(writes).toEqual([]);
  });

  it('a changed amount creates a new Price, then archives the old one and never deletes', async () => {
    const { db } = fakeDb({
      products: [product({ amount: 1200, stripe_product_id: 'prod_1', stripe_name: 'Term (per child)' })],
      prices: [price()],
      stale: [{ product_key: 'child_term', kind: 'one_time', version: 1, stripe_price_id: 'price_old' }],
    });
    stripeOk('price_new', 'price_old');
    const out = await syncBillingToStripe({ DB: db, STRIPE_SECRET_KEY: 'sk_test_x' }, 'chess');
    expect(out).toMatchObject({ pricesCreated: 1, pricesArchived: 1 });
    const [create, archive] = calls();
    expect(create!.url).toBe('https://api.stripe.com/v1/prices');
    expect(create!.body).toContain('unit_amount=1200');
    expect(archive!.url).toBe('https://api.stripe.com/v1/prices/price_old');
    expect(archive!.body).toBe('active=false');
    expect(calls().every((c) => !c.url.includes('DELETE'))).toBe(true);
    expect(mockFetch.mock.calls.every(([, init]) => (init as RequestInit).method === 'POST')).toBe(true);
  });

  it('a renamed product updates the Stripe Product name instead of creating another', async () => {
    const { db } = fakeDb({
      products: [product({ name: 'Renamed', stripe_product_id: 'prod_1', stripe_name: 'Old' })],
      prices: [price()],
    });
    stripeOk('prod_1');
    await syncBillingToStripe({ DB: db, STRIPE_SECRET_KEY: 'sk_test_x' }, 'chess');
    expect(calls()).toHaveLength(1);
    expect(calls()[0]!.url).toBe('https://api.stripe.com/v1/products/prod_1');
    expect(calls()[0]!.body).toBe('name=Renamed');
  });

  it('warns and skips Stripe when no secret is configured, so deploy is never blocked', async () => {
    const { db } = fakeDb({ products: [product()] });
    const out = await syncBillingToStripe({ DB: db }, 'chess');
    expect(mockFetch).not.toHaveBeenCalled();
    expect(out.warnings[0]).toMatch(/STRIPE_SECRET_KEY/);
  });

  it('does nothing for an app with no active products', async () => {
    const { db } = fakeDb({});
    const out = await syncBillingToStripe({ DB: db, STRIPE_SECRET_KEY: 'sk_test_x' }, 'chess');
    expect(mockFetch).not.toHaveBeenCalled();
    expect(out).toEqual({ products: 0, pricesCreated: 0, pricesArchived: 0, warnings: [] });
  });

  it('a Stripe failure becomes a warning, not a thrown deploy error', async () => {
    const { db } = fakeDb({ products: [product()] });
    mockFetch.mockResolvedValueOnce({ ok: false, status: 500, text: () => Promise.resolve('boom') } as Response);
    const out = await syncBillingToStripe({ DB: db, STRIPE_SECRET_KEY: 'sk_test_x' }, 'chess');
    expect(out.warnings.join(' ')).toMatch(/child_term/);
    expect(out.pricesCreated).toBe(0);
  });
});
