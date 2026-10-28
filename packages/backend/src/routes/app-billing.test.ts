import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { app } from '../index.js';
import { testToken, TEST_SK } from '../test-helpers.js';

const authorize = vi.hoisted(() => vi.fn());
vi.mock('../lib/billing-authorize.js', () => ({ runAuthorizeAction: authorize, BillingAuthorizeError: class extends Error {} }));

const TOK = await testToken('gh:1', { login: 'parent', roles: ['user'] });
const mockFetch = vi.fn();

interface Row { [k: string]: unknown }
interface Fixture { product?: Row | null; price?: Row | null; domains?: string[]; customer?: string | null }

/** A D1 stand-in that answers by SQL text and records every write. */
function fakeDb(fx: Fixture) {
  const writes: { sql: string; args: unknown[] }[] = [];
  const prepare = (sql: string) => ({
    bind: (...args: unknown[]) => ({
      first: async () => {
        if (sql.includes('FROM app_products p JOIN app_billing')) return fx.product === undefined ? DEFAULT_PRODUCT : fx.product;
        if (sql.includes('FROM app_product_prices')) return fx.price === undefined ? { stripe_price_id: 'price_1' } : fx.price;
        if (sql.includes('stripe_customer_id')) return fx.customer ? { stripe_customer_id: fx.customer } : null;
        return null;
      },
      all: async () => ({ results: sql.includes('app_custom_domains') ? (fx.domains ?? []).map((domain) => ({ domain })) : [] }),
      run: async () => { writes.push({ sql, args }); return { meta: { changes: 1 } }; },
    }),
  });
  return { db: { prepare } as unknown as D1Database, writes };
}

const DEFAULT_PRODUCT = { product_key: 'child_term', modes: '["one_time","recurring"]', subject: 'required', authorize_action: 'can_buy' };
const OK = 'https://chess.proappstore.online/done';

function post(db: D1Database, body: unknown, token: string | null = TOK, appId = 'chess') {
  return app.request(`/v1/apps/${appId}/billing/checkout`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  }, { DB: db, STRIPE_SECRET_KEY: 'sk_test_x', SESSION_SIGNING_KEY: TEST_SK });
}

const valid = (over: Row = {}) => ({ product: 'child_term', subjects: ['kid-1', 'kid-2'], renew: false, successUrl: OK, cancelUrl: OK, ...over });

beforeEach(() => {
  mockFetch.mockReset();
  authorize.mockReset().mockResolvedValue(true);
  vi.stubGlobal('fetch', mockFetch);
  // Stripe: customer create, then the Checkout session.
  mockFetch.mockImplementation(async (url: string) => ({
    ok: true,
    json: async () => (String(url).endsWith('/customers') ? { id: 'cus_new' } : { id: 'cs_1', url: 'https://checkout.stripe.com/c/pay/cs_1' }),
  }));
});
afterEach(() => vi.unstubAllGlobals());

describe('POST /v1/apps/:appId/billing/checkout (#507)', () => {
  it('401s without a session', async () => {
    const { db } = fakeDb({});
    expect((await post(db, valid(), null)).status).toBe(401);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('returns the Checkout URL, quantity = subjects.length, ids in the session metadata', async () => {
    const { db, writes } = fakeDb({});
    const res = await post(db, valid());
    expect(res.status).toBe(200);
    const json = await res.json() as { url: string; purchaseId: string };
    expect(json.url).toBe('https://checkout.stripe.com/c/pay/cs_1');
    const session = mockFetch.mock.calls.find(([u]) => String(u).endsWith('/checkout/sessions'))!;
    const body = String((session[1] as RequestInit).body);
    expect(body).toContain('mode=payment');
    expect(body).toContain('line_items%5B0%5D%5Bquantity%5D=2');
    expect(body).toContain('metadata%5Bapp_id%5D=chess');
    expect(body).toContain('metadata%5Bproduct_key%5D=child_term');
    expect(body).toContain(`metadata%5Bpurchase_id%5D=${json.purchaseId}`);
    expect(body).not.toContain('kid-1'); // subjects are app data, never in Stripe metadata
    const insert = writes.find((w) => w.sql.includes('INSERT INTO purchases'))!;
    expect(insert.args).toContain(JSON.stringify(['kid-1', 'kid-2']));
    expect(insert.sql).toContain("'pending'");
  });

  it('renew uses subscription mode', async () => {
    const { db } = fakeDb({});
    expect((await post(db, valid({ renew: true }))).status).toBe(200);
    const session = mockFetch.mock.calls.find(([u]) => String(u).endsWith('/checkout/sessions'))!;
    expect(String((session[1] as RequestInit).body)).toContain('mode=subscription');
  });

  it('403s, with no Stripe call, when the authorize action denies', async () => {
    authorize.mockResolvedValue(false);
    const { db, writes } = fakeDb({});
    const res = await post(db, valid());
    expect(res.status).toBe(403);
    expect(mockFetch).not.toHaveBeenCalled();
    expect(writes).toEqual([]);
  });

  it('passes the buyer, product and subjects to the authorize action', async () => {
    const { db } = fakeDb({});
    await post(db, valid());
    expect(authorize).toHaveBeenCalledWith(expect.anything(), 'chess', 'can_buy', expect.any(String), 'child_term', ['kid-1', 'kid-2']);
  });

  it('fails closed (502) when the authorize action errors', async () => {
    authorize.mockRejectedValue(new Error('data worker down'));
    const { db } = fakeDb({});
    expect((await post(db, valid())).status).toBe(502);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('400s on an unknown product, and another app\'s key is unknown here', async () => {
    const { db } = fakeDb({ product: null });
    const res = await post(db, valid({ product: 'other_apps_product' }));
    expect(res.status).toBe(400);
    expect(authorize).not.toHaveBeenCalled();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('400s on an empty subject list for a subject-required product', async () => {
    const { db } = fakeDb({});
    expect((await post(db, valid({ subjects: [] }))).status).toBe(400);
    expect((await post(db, { product: 'child_term', renew: false, successUrl: OK, cancelUrl: OK })).status).toBe(400);
    expect(authorize).not.toHaveBeenCalled();
  });

  it('400s on repeated subjects', async () => {
    const { db } = fakeDb({});
    expect((await post(db, valid({ subjects: ['a', 'a'] }))).status).toBe(400);
  });

  it.each([
    ['another app', 'https://other.proappstore.online/done'],
    ['an arbitrary host', 'https://evil.example.com/done'],
    ['a lookalike suffix', 'https://chess.proappstore.online.evil.com/done'],
    ['plain http off localhost', 'http://chess.proappstore.online/done'],
    ['embedded credentials', 'https://u:p@chess.proappstore.online/done'],
  ])('400s on a redirect to %s', async (_n, url) => {
    const { db } = fakeDb({});
    expect((await post(db, valid({ successUrl: url }))).status).toBe(400);
    expect((await post(db, valid({ cancelUrl: url }))).status).toBe(400);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('accepts the app\'s verified custom domain, its subdomains and localhost', async () => {
    const { db } = fakeDb({ domains: ['chessclubs.online'] });
    for (const url of ['https://chessclubs.online/ok', 'https://www.chessclubs.online/ok', 'http://localhost:5173/ok']) {
      expect((await post(db, valid({ successUrl: url, cancelUrl: url }))).status).toBe(200);
    }
  });

  it('400s when the body is missing required fields', async () => {
    const { db } = fakeDb({});
    expect((await post(db, { subjects: ['a'] })).status).toBe(400);
    expect((await post(db, valid({ successUrl: undefined }))).status).toBe(400);
    expect((await post(db, valid({ renew: 'yes' }))).status).toBe(400);
  });

  it('400s when renew is asked of a one-time-only product', async () => {
    const { db } = fakeDb({ product: { ...DEFAULT_PRODUCT, modes: '["one_time"]' } });
    expect((await post(db, valid({ renew: true }))).status).toBe(400);
  });

  it('503s when no Price has been synced yet', async () => {
    const { db } = fakeDb({ price: null });
    expect((await post(db, valid())).status).toBe(503);
  });

  it('marks the purchase failed and returns 502 when Stripe refuses the session', async () => {
    mockFetch.mockImplementation(async (url: string) =>
      String(url).endsWith('/customers')
        ? { ok: true, json: async () => ({ id: 'cus_new' }) }
        : { ok: false, status: 500, text: async () => 'boom' });
    const { db, writes } = fakeDb({});
    expect((await post(db, valid())).status).toBe(502);
    expect(writes.some((w) => w.sql.includes("status = 'failed'"))).toBe(true);
  });
});
