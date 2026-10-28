import { SELF, env as providedEnv, fetchMock } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Env } from '../../../backend/src/types';
import { disableAppWorker } from '../../../backend/src/lib/app-worker-host';
import { BASE, mockNetwork, resetTables, seedApp, seedUser, session } from './helpers';

const env = providedEnv as unknown as Env;

// #507 (epic #506) on real D1 and the real migrations: products declared in mcp.json reach Stripe once, and checkout
// refuses everything the app or the platform should refuse BEFORE Stripe is called. Only Stripe and the app's data worker
// are intercepted.

const MAY_BUY = {
  name: 'may_buy', description: 'May this user buy', operation: 'query', requires_auth: true, callers: ['billing'],
  params: { product: { type: 'string' }, subjects_json: { type: 'string' } },
  sql: 'SELECT 1 AS allowed WHERE :product IS NOT NULL AND :subjects_json IS NOT NULL AND :__user_id IS NOT NULL',
};
const TERM = {
  key: 'child_term', name: 'Chess Academy term (per child)', amount: 1000, currency: 'aud', tax_behavior: 'inclusive',
  modes: ['one_time', 'recurring'], interval: { unit: 'month', count: 3 }, grace_days: 5, subject: 'required',
};
const DONATION = { key: 'donation', name: 'Donation', amount: 500, currency: 'aud', modes: ['one_time'] };
const billing = (products: Record<string, unknown>[] = [TERM], over: Record<string, unknown> = {}) => ({ authorize_action: 'may_buy', products, ...over });

const owner = () => session('gh:admin', { roles: ['user', 'admin'] });
const dataWorker = (app = 'club') => fetchMock.get(`https://pas-data-${app}.${env.DATA_WORKER_HOST}`);
const stripe = () => fetchMock.get('https://api.stripe.com');

interface Seen { path: string; body: URLSearchParams; idem: string | null }
let seen: Seen[] = [];
const record = (path: string, reply: Record<string, unknown>) => stripe().intercept({ path, method: 'POST' }).reply(200, (req) => {
  const headers = Object.fromEntries(Object.entries((req.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v]));
  seen.push({ path, body: new URLSearchParams(String(req.body)), idem: headers['idempotency-key'] ?? null });
  return reply;
});
const stripeCalls = (path: string) => seen.filter((s) => s.path === path);

async function register(app: string, tools: Record<string, unknown>[], bill: unknown): Promise<{ status: number; body: { warnings?: string[]; error?: string } }> {
  dataWorker(app).intercept({ path: '/validate', method: 'POST' })
    .reply(200, (req) => ({ results: (JSON.parse(String(req.body)) as { statements: { id: string }[] }).statements.map((st) => ({ id: st.id, ok: true })) }));
  const res = await SELF.fetch(`${BASE}/v1/apps/${app}/tools`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${await owner()}` }, body: JSON.stringify({ tools, billing: bill }),
  });
  return { status: res.status, body: await res.json() as { warnings?: string[]; error?: string } };
}
/** First deploy of a billing app, with Stripe answering product and prices. */
async function deploy(app = 'club', products: Record<string, unknown>[] = [TERM], ids = { product: 'prod_1', prices: ['price_ot', 'price_rec'] }) {
  record('/v1/products', { id: ids.product });
  for (const id of ids.prices) record('/v1/prices', { id });
  return register(app, [MAY_BUY], billing(products));
}
const enable = (app = 'club') => env.DB.prepare('UPDATE app_billing SET enabled = 1 WHERE app_id = ?').bind(app).run();

async function checkout(body: Record<string, unknown>, opts: { app?: string; uid?: string; token?: string | null } = {}): Promise<Response> {
  const token = opts.token === null ? undefined : opts.token ?? await session(opts.uid ?? 'gh:2');
  return SELF.fetch(`${BASE}/v1/apps/${opts.app ?? 'club'}/billing/checkout`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify({ product: 'child_term', subjects: ['kid-a', 'kid-b'], renew: false, successUrl: 'https://club.proappstore.online/thanks', cancelUrl: 'https://club.proappstore.online/', ...body }),
  });
}
/** The app's authorize action answers with these rows. */
const authorizes = (rows: unknown[] | 'fail', app = 'club') => dataWorker(app).intercept({ path: '/query', method: 'POST' }).reply(rows === 'fail' ? 500 : 200, rows === 'fail' ? { error: 'internal server error' } : { rows });
const session1 = (id = 'cs_test_1') => record('/v1/checkout/sessions', { id, url: `https://checkout.stripe.test/${id}` });
const purchases = async () => (await env.DB.prepare('SELECT * FROM app_purchases ORDER BY created_at').all<Record<string, unknown>>()).results ?? [];

afterEach(() => fetchMock.assertNoPendingInterceptors());
beforeEach(async () => {
  seen = [];
  mockNetwork();
  for (const r of (await env.DB.prepare('SELECT app_id FROM app_workers').all<{ app_id: string }>()).results ?? []) await disableAppWorker(env, r.app_id);
  await resetTables();
  for (const t of ['app_billing', 'app_billing_products', 'app_billing_prices', 'app_purchases', 'billing_customers', 'subscriptions', 'app_custom_domains', 'app_go_live']) await env.DB.prepare(`DELETE FROM ${t}`).run();
  await env.DB.prepare('UPDATE app_worker_platform SET open = 1, closed_reason = NULL, closed_at = NULL').run();
  await seedUser('gh:admin', 'admin');
  await seedUser('gh:2', 'buyer');
  await seedApp('club', 'gh:admin');
  await seedApp('other', 'gh:admin');
  // Live apps: an action registered for an app that has not gone live is staged, and checkout refuses a staged authorize action.
  await env.DB.prepare("INSERT INTO app_go_live (app_id, went_live_at) VALUES ('club', 1), ('other', 1)").run();
});

describe('declaring products: the manifest and the Stripe sync (#507)', () => {
  it('creates one Stripe product and a price per mode, with the app and product in metadata, and records them', async () => {
    const r = await deploy();
    expect(r.status).toBe(200);
    expect((r.body.warnings ?? []).join('\n')).not.toMatch(/billing/);

    const product = stripeCalls('/v1/products')[0]!;
    expect(product.body.get('name')).toBe('Chess Academy term (per child)');
    expect(product.body.get('metadata[app_id]')).toBe('club');
    expect(product.body.get('metadata[product_key]')).toBe('child_term');
    expect(product.idem).toBe('pas-product:club:child_term');

    const [oneOff, recurring] = stripeCalls('/v1/prices');
    expect(oneOff!.body.get('unit_amount')).toBe('1000');
    expect(oneOff!.body.get('currency')).toBe('aud');
    expect(oneOff!.body.get('tax_behavior')).toBe('inclusive');
    expect(oneOff!.body.get('recurring[interval]')).toBeNull();
    expect(recurring!.body.get('recurring[interval]')).toBe('month');
    expect(recurring!.body.get('recurring[interval_count]')).toBe('3');
    expect(recurring!.body.get('product')).toBe('prod_1');
    expect(recurring!.body.get('metadata[app_id]')).toBe('club');
    expect(oneOff!.idem).toMatch(/^pas-price:/);
    expect(oneOff!.idem).not.toBe(recurring!.idem);

    const rows = (await env.DB.prepare("SELECT stripe_price_id, mode, status FROM app_billing_prices WHERE app_id = 'club' ORDER BY mode").all<Record<string, string>>()).results;
    expect(rows).toEqual([{ stripe_price_id: 'price_ot', mode: 'one_time', status: 'active' }, { stripe_price_id: 'price_rec', mode: 'recurring', status: 'active' }]);
    const config = await env.DB.prepare("SELECT authorize_action, enabled FROM app_billing WHERE app_id = 'club'").first<{ authorize_action: string; enabled: number }>();
    expect(config).toEqual({ authorize_action: 'may_buy', enabled: 0 }); // declaring never turns live money on
  });

  it('a redeploy with the same products makes no Stripe call', async () => {
    await deploy();
    seen = [];
    const again = await register('club', [MAY_BUY], billing());
    expect(again.status).toBe(200);
    expect((again.body.warnings ?? []).join('\n')).not.toMatch(/billing/); // an unexpected Stripe call would be refused by the mock and warned about
    expect(seen).toEqual([]);
    expect(((await env.DB.prepare('SELECT COUNT(*) AS n FROM app_billing_prices').first<{ n: number }>())?.n)).toBe(2);
  });

  it('a changed amount creates a new price, archives the old one, and deletes nothing', async () => {
    await deploy();
    record('/v1/prices', { id: 'price_ot2' });
    record('/v1/prices', { id: 'price_rec2' });
    record('/v1/prices/price_ot', { id: 'price_ot' });
    record('/v1/prices/price_rec', { id: 'price_rec' });
    seen = [];
    expect((await register('club', [MAY_BUY], billing([{ ...TERM, amount: 1200 }]))).status).toBe(200);

    expect(stripeCalls('/v1/prices').map((s) => s.body.get('unit_amount'))).toEqual(['1200', '1200']);
    expect(stripeCalls('/v1/products')).toHaveLength(0); // the product is reused
    expect(stripeCalls('/v1/prices/price_ot')[0]!.body.get('active')).toBe('false');
    const rows = (await env.DB.prepare('SELECT stripe_price_id, status FROM app_billing_prices ORDER BY stripe_price_id').all<Record<string, string>>()).results;
    expect(rows).toEqual([
      { stripe_price_id: 'price_ot', status: 'archived' }, { stripe_price_id: 'price_ot2', status: 'active' },
      { stripe_price_id: 'price_rec', status: 'archived' }, { stripe_price_id: 'price_rec2', status: 'active' },
    ]);
  });

  it('a product the manifest stops declaring is deactivated, not deleted, and cannot be bought', async () => {
    await deploy('club', [TERM, DONATION], { product: 'prod_1', prices: ['price_ot', 'price_rec'] });
    // (the donation's own product and price are created on the same deploy only if Stripe answers: it was not offered one)
    await enable();
    expect((await register('club', [MAY_BUY], billing([DONATION]))).status).toBe(200);
    const rows = (await env.DB.prepare('SELECT product_key, active FROM app_billing_products ORDER BY product_key').all<Record<string, number>>()).results;
    expect(rows).toEqual([{ product_key: 'child_term', active: 0 }, { product_key: 'donation', active: 1 }]);
    expect((await checkout({})).status).toBe(400); // unknown product
  });

  it("a Stripe failure never fails the deploy: it is a warning, kept on the product, and the next deploy retries", async () => {
    stripe().intercept({ path: '/v1/products', method: 'POST' }).reply(500, { error: { message: 'Stripe is down' } });
    const first = await register('club', [MAY_BUY], billing());
    expect(first.status).toBe(200);
    expect(first.body.warnings!.join('\n')).toMatch(/product "child_term" was not synced to Stripe/);
    expect((await env.DB.prepare("SELECT sync_error FROM app_billing_products WHERE app_id = 'club'").first<{ sync_error: string }>())?.sync_error).toMatch(/Stripe/);

    record('/v1/products', { id: 'prod_1' });
    record('/v1/prices', { id: 'price_ot' });
    record('/v1/prices', { id: 'price_rec' });
    const second = await register('club', [MAY_BUY], billing());
    expect((second.body.warnings ?? []).join('\n')).not.toMatch(/billing/);
    expect((await env.DB.prepare("SELECT sync_error, stripe_product_id FROM app_billing_products WHERE app_id = 'club'").first<Record<string, string | null>>())).toEqual({ sync_error: null, stripe_product_id: 'prod_1' });
  });

  it('refuses a manifest whose billing is malformed, or whose authorize action is not safe', async () => {
    const bad = async (bill: unknown, tools: Record<string, unknown>[] = [MAY_BUY]) => (await register('club', tools, bill)).body.error ?? '';
    expect(await bad({ products: [TERM] })).toMatch(/authorize_action is required/);
    expect(await bad(billing([TERM], { authorize_action: 'nope' }))).toMatch(/not a tool in this manifest/);
    expect(await bad(billing(), [{ ...MAY_BUY, callers: ['user'] }])).toMatch(/callers: \["billing"\] only/);
    expect(await bad(billing(), [{ ...MAY_BUY, callers: ['user', 'billing'] }])).toMatch(/callers: \["billing"\] only/);
    expect(await bad(billing([{ ...TERM, amount: 10.5 }]))).toMatch(/amount must be a whole number/);
    expect(await bad(billing([{ ...TERM, interval: undefined }]))).toMatch(/recurring product needs an interval/);
    expect(await bad(billing([TERM, TERM]))).toMatch(/declared twice/);
  });

  it('a billing-only action cannot be called over HTTP by anyone, and MCP does not list it', async () => {
    await deploy();
    const res = await SELF.fetch(`${BASE}/v1/apps/club/actions/may_buy`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${await owner()}` }, body: JSON.stringify({ params: { product: 'child_term', subjects_json: '[]' } }),
    });
    expect(res.status).toBe(403);
  });
});

describe('checkout (#507)', () => {
  beforeEach(async () => {
    await deploy();
    // The buyer already has a Stripe customer, so a test about checkout is not also a test about customer creation.
    await env.DB.prepare("INSERT INTO billing_customers (user_id, stripe_customer_id, created_at) VALUES ('gh:2', 'cus_pre', 1)").run();
    seen = [];
  });

  it('is refused until an admin enables billing for the app, and touches neither the app nor Stripe', async () => {
    const res = await checkout({});
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: 'billing is not enabled for this app' });
    expect(await purchases()).toEqual([]);
  });

  it('needs a signed-in user', async () => {
    await enable();
    expect((await checkout({}, { token: null })).status).toBe(401);
  });

  it('is refused (403) when the authorize action returns no row, allowed = 0, or more than one row; and fails closed when the check cannot run', async () => {
    await enable();
    for (const rows of [[], [{ allowed: 0 }], [{ allowed: 1 }, { allowed: 1 }], [{ ok: 1 }]] as unknown[][]) {
      authorizes(rows);
      const res = await checkout({});
      expect(res.status, JSON.stringify(rows)).toBe(403);
    }
    authorizes('fail');
    expect((await checkout({})).status).toBe(502);
    expect(await purchases()).toEqual([]);
    expect(seen).toEqual([]); // not one Stripe call
  });

  it('runs the app\'s SQL with the buyer, the product and the subjects, then opens a one-off Stripe session for one seat per subject', async () => {
    await enable();
    dataWorker().intercept({ path: '/query', method: 'POST' }).reply(200, (req) => {
      const sent = JSON.parse(String(req.body)) as { sql: string; params: unknown[] };
      expect(sent.sql).toContain('SELECT 1 AS allowed');
      expect(sent.params).toEqual(['child_term', JSON.stringify(['kid-a', 'kid-b']), 'gh:2']);
      return { rows: [{ allowed: 1 }] };
    });
    session1();
    const res = await checkout({});
    expect(res.status).toBe(200);
    const out = (await res.json()) as { url: string; purchaseId: string };
    expect(out.url).toBe('https://checkout.stripe.test/cs_test_1');

    const call = stripeCalls('/v1/checkout/sessions')[0]!;
    expect(call.body.get('mode')).toBe('payment');
    expect(call.body.get('line_items[0][price]')).toBe('price_ot');
    expect(call.body.get('line_items[0][quantity]')).toBe('2');
    expect(call.body.get('metadata[app_id]')).toBe('club');
    expect(call.body.get('metadata[product_key]')).toBe('child_term');
    expect(call.body.get('metadata[user_id]')).toBe('gh:2');
    expect(call.body.get('metadata[purchase_id]')).toBe(out.purchaseId);
    expect(call.body.get('payment_intent_data[metadata][purchase_id]')).toBe(out.purchaseId);
    expect(call.body.toString()).not.toContain('kid-a'); // subjects are app data: kept here, never sent to Stripe
    expect(call.idem).toBe(`pas-checkout:${out.purchaseId}`);

    const [purchase] = await purchases();
    expect(purchase).toMatchObject({ id: out.purchaseId, app_id: 'club', product_key: 'child_term', buyer_user_id: 'gh:2', quantity: 2, mode: 'one_time', status: 'pending', price_id: 'price_ot', stripe_session_id: 'cs_test_1' });
    expect(JSON.parse(purchase!.subjects as string)).toEqual(['kid-a', 'kid-b']);
  });

  it('renew: true opens a subscription at the recurring price, and the subscription carries the metadata', async () => {
    await enable();
    authorizes([{ allowed: 1 }]);
    session1();
    expect((await checkout({ renew: true })).status).toBe(200);
    const call = stripeCalls('/v1/checkout/sessions')[0]!;
    expect(call.body.get('mode')).toBe('subscription');
    expect(call.body.get('line_items[0][price]')).toBe('price_rec');
    expect(call.body.get('subscription_data[metadata][app_id]')).toBe('club');
    expect(call.body.get('subscription_data[metadata][purchase_id]')).toBeTruthy();
    expect((await purchases())[0]).toMatchObject({ mode: 'recurring' });
  });

  it('refuses 400 for an unknown product, an empty or malformed subject list, a duplicate subject, and a mode the product does not offer', async () => {
    await enable();
    const cases: [Record<string, unknown>, RegExp][] = [
      [{ product: 'nope' }, /unknown product/],
      [{ product: undefined }, /product is required/],
      [{ subjects: [] }, /non-empty list/],
      [{ subjects: undefined }, /non-empty list/],
      [{ subjects: ['a', 'a'] }, /must not repeat/],
      [{ subjects: [1] }, /non-empty string/],
      [{ subjects: ['x'.repeat(129)] }, /at most 128/],
      [{ subjects: Array.from({ length: 51 }, (_, i) => `k${i}`) }, /at most 50/],
      [{ renew: 'yes' }, /renew must be true or false/],
    ];
    for (const [body, error] of cases) {
      const res = await checkout(body);
      expect(res.status, JSON.stringify(body).slice(0, 60)).toBe(400);
      expect(JSON.stringify(await res.json())).toMatch(error);
    }
    expect(await purchases()).toEqual([]);
  });

  it('a product that takes no subject refuses one, and sells one seat', async () => {
    record('/v1/products', { id: 'prod_d' });
    record('/v1/prices', { id: 'price_d' });
    await register('club', [MAY_BUY], billing([TERM, DONATION]));
    await enable();
    expect((await checkout({ product: 'donation', subjects: ['kid-a'] })).status).toBe(400);
    expect((await checkout({ product: 'donation', renew: true, subjects: undefined })).status).toBe(400); // one-off only
    authorizes([{ allowed: 1 }]);
    session1();
    expect((await checkout({ product: 'donation', subjects: undefined })).status).toBe(200);
    expect(stripeCalls('/v1/checkout/sessions')[0]!.body.get('line_items[0][quantity]')).toBe('1');
  });

  it("refuses 400 a redirect outside the app's own origins, and allows its subdomain, an active custom domain and localhost", async () => {
    await enable();
    await env.DB.prepare("INSERT INTO app_custom_domains (app_id, domain, status, added_at) VALUES ('club', 'chessclubs.online', 'active', 1), ('club', 'pending.example', 'pending', 1), ('other', 'othersite.example', 'active', 1)").run();
    const refused = [
      'https://evil.example/', 'https://club.proappstore.online.evil.example/', 'https://other.proappstore.online/', 'http://club.proappstore.online/',
      'https://pending.example/', 'https://othersite.example/', 'https://user:pw@club.proappstore.online/', 'not a url', 'javascript:alert(1)', 'https://xchessclubs.online/',
    ];
    for (const url of refused) expect((await checkout({ successUrl: url })).status, url).toBe(400);
    expect((await checkout({ cancelUrl: 'https://evil.example/' })).status).toBe(400);

    for (const url of ['https://club.proappstore.online/ok', 'https://app.club.proappstore.online/ok', 'https://chessclubs.online/ok', 'https://www.chessclubs.online/ok', 'http://localhost:5173/ok']) {
      authorizes([{ allowed: 1 }]);
      session1(`cs_${stripeCalls('/v1/checkout/sessions').length}`);
      expect((await checkout({ successUrl: url, cancelUrl: url })).status, url).toBe(200);
    }
  });

  it("another app's product key cannot be bought through this app's route", async () => {
    record('/v1/products', { id: 'prod_secret' });
    record('/v1/prices', { id: 'price_secret' });
    await register('other', [MAY_BUY], billing([{ key: 'secret_item', name: 'Secret', amount: 900, currency: 'aud' }]));
    await enable();
    await enable('other');
    const res = await checkout({ product: 'secret_item', subjects: undefined });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: 'unknown product' });
    expect(await purchases()).toEqual([]);
  });

  it('is not available for a product with no price yet, and an unknown app is a 404', async () => {
    await enable();
    await env.DB.prepare("UPDATE app_billing_prices SET status = 'archived'").run();
    // The price is looked up before the app is asked, so the app's SQL never runs for a product that cannot be sold.
    expect((await checkout({})).status).toBe(503);
    expect((await checkout({}, { app: 'nope' })).status).toBe(404);
  });

  it('a Stripe failure after authorization is a 502 and leaves the purchase failed, not pending', async () => {
    await enable();
    authorizes([{ allowed: 1 }]);
    stripe().intercept({ path: '/v1/checkout/sessions', method: 'POST' }).reply(500, { error: { message: 'boom card_number 4242' } });
    const res = await checkout({});
    expect(res.status).toBe(502);
    expect(JSON.stringify(await res.json())).not.toContain('4242');
    expect((await purchases())[0]).toMatchObject({ status: 'failed' });
  });

  it('uses one Stripe customer per platform user: a new one is created once, then reused; an earlier Pro customer is reused', async () => {
    await enable();
    await env.DB.prepare("DELETE FROM billing_customers WHERE user_id = 'gh:2'").run();
    record('/v1/customers', { id: 'cus_new' });
    authorizes([{ allowed: 1 }]);
    session1('cs_a');
    expect((await checkout({})).status).toBe(200);
    expect(stripeCalls('/v1/checkout/sessions')[0]!.body.get('customer')).toBe('cus_new');
    expect(stripeCalls('/v1/customers')[0]!.body.get('metadata[user_id]')).toBe('gh:2');

    authorizes([{ allowed: 1 }]);
    session1('cs_b');
    expect((await checkout({})).status).toBe(200); // no second /v1/customers: it would be refused by the mock
    expect(stripeCalls('/v1/checkout/sessions')[1]!.body.get('customer')).toBe('cus_new');

    await seedUser('gh:3', 'pro');
    await env.DB.prepare("INSERT INTO subscriptions (user_id, stripe_customer_id, status, tier, current_period_end, cancel_at_period_end, created_at, updated_at) VALUES ('gh:3', 'cus_pro', 'active', 'pro', 0, 0, 1, 1)").run();
    authorizes([{ allowed: 1 }]);
    session1('cs_c');
    expect((await checkout({}, { uid: 'gh:3' })).status).toBe(200);
    expect(stripeCalls('/v1/checkout/sessions')[2]!.body.get('customer')).toBe('cus_pro');
    expect((await env.DB.prepare("SELECT stripe_customer_id FROM billing_customers WHERE user_id = 'gh:3'").first<{ stripe_customer_id: string }>())?.stripe_customer_id).toBe('cus_pro');
  });
});
