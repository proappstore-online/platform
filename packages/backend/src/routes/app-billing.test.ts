import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { app } from '../index.js';
import { forgetAppVisibility } from '../lib/visibility.js';
import { sqliteD1 } from '../sqlite-d1.js';
import { makeEnv, testToken } from '../test-helpers.js';

// #507: checkout for a product an app declared. Everything that can refuse does so BEFORE Stripe is called, in a fixed order. Real SQL on
// in-memory SQLite; Stripe and the app's data worker are one stubbed fetch. The same flow runs on real D1 in packages/runtime-tests.

const MAY_BUY = {
  name: 'may_buy', description: 'May this user buy', operation: 'query', requires_auth: true, callers: ['billing'],
  params: { product: { type: 'string' }, subjects_json: { type: 'string' } },
  sql: 'SELECT 1 AS allowed WHERE :product IS NOT NULL AND :subjects_json IS NOT NULL AND :__user_id IS NOT NULL',
};
const OK = { successUrl: 'https://club.proappstore.online/thanks', cancelUrl: 'https://club.proappstore.online/' };

let db: ReturnType<typeof sqliteD1>;
let env: ReturnType<typeof makeEnv>;
let calls: { url: string; body: string }[];
let verdict: () => Response;

beforeEach(async () => {
  db = sqliteD1();
  env = makeEnv({ DB: db, DATA_WORKER_HOST: 'workers.test', INTERNAL_TOKEN: 'internal' });
  forgetAppVisibility();
  calls = [];
  verdict = () => new Response(JSON.stringify({ rows: [{ allowed: 1 }] }), { status: 200 });
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
    calls.push({ url: String(url), body: String(init.body) });
    const u = String(url);
    if (u.includes('pas-data-')) return verdict();
    if (u.endsWith('/v1/customers')) return new Response(JSON.stringify({ id: 'cus_new' }), { status: 200 });
    if (u.endsWith('/v1/checkout/sessions')) return new Response(JSON.stringify({ id: 'cs_1', url: 'https://checkout.stripe.test/cs_1' }), { status: 200 });
    return new Response('{}', { status: 404 });
  }));
  const cols = (await db.prepare('PRAGMA table_info(apps)').all<{ name: string; notnull: number; dflt_value: string | null }>()).results;
  const required = cols.filter((c) => c.notnull && c.dflt_value === null && !['id', 'creator_id'].includes(c.name)).map((c) => c.name);
  await db.prepare(`INSERT INTO apps (id, creator_id, ${required.join(', ')}) VALUES ('club', 'gh:owner', ${required.map(() => '?').join(', ')})`).bind(...required.map((c) => (/_at$/.test(c) ? 1 : `club-${c}`))).run();
  await db.prepare("INSERT INTO app_billing (app_id, authorize_action, enabled, created_at, updated_at) VALUES ('club', 'may_buy', 1, 1, 1)").run();
  await db.prepare(
    `INSERT INTO app_billing_products (app_id, product_key, name, amount, currency, modes, interval_unit, interval_count, grace_days, subject, active, created_at, updated_at)
     VALUES ('club', 'term', 'Term', 1000, 'aud', '["one_time","recurring"]', 'month', 3, 5, 'required', 1, 1, 1)`,
  ).run();
  await db.prepare("INSERT INTO app_billing_prices (stripe_price_id, app_id, product_key, mode, amount, currency, tax_behavior, status, created_at) VALUES ('price_ot', 'club', 'term', 'one_time', 1000, 'aud', 'inclusive', 'active', 1), ('price_rec', 'club', 'term', 'recurring', 1000, 'aud', 'inclusive', 'active', 1)").run();
  await db.prepare("INSERT INTO app_tools (app_id, name, manifest, source, state, created_at, updated_at) VALUES ('club', 'may_buy', ?, 'code', 'live', 1, 1)").bind(JSON.stringify(MAY_BUY)).run();
  await db.prepare("INSERT INTO billing_customers (user_id, stripe_customer_id, created_at) VALUES ('gh:2', 'cus_pre', 1)").run();
});
afterEach(() => vi.unstubAllGlobals());

async function checkout(body: unknown, opts: { uid?: string | null; appId?: string } = {}) {
  const token = opts.uid === null ? null : await testToken(opts.uid ?? 'gh:2');
  return app.request(`/v1/apps/${opts.appId ?? 'club'}/billing/checkout`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  }, env as never);
}
const stripeCalls = () => calls.filter((c) => c.url.includes('api.stripe.com'));
const purchases = async () => (await db.prepare('SELECT * FROM app_purchases').all<Record<string, unknown>>()).results;
const good = { product: 'term', subjects: ['kid-a', 'kid-b'], renew: false, ...OK };
const err = async (res: Response) => ((await res.json()) as { error: string }).error;

describe('a purchase that goes through', () => {
  it('records the purchase with its snapshotted term, asks Stripe once, and returns the session url', async () => {
    const res = await checkout(good);
    expect(res.status).toBe(200);
    const body = await res.json() as { url: string; purchaseId: string };
    expect(body.url).toBe('https://checkout.stripe.test/cs_1');
    const [p] = await purchases();
    expect(p).toMatchObject({ id: body.purchaseId, app_id: 'club', product_key: 'term', buyer_user_id: 'gh:2', mode: 'one_time', status: 'pending', quantity: 2, price_id: 'price_ot', interval_unit: 'month', interval_count: 3, grace_days: 5, stripe_session_id: 'cs_1' });
    expect(JSON.parse(String(p!.subjects))).toEqual(['kid-a', 'kid-b']);
    const session = new URLSearchParams(stripeCalls()[0]!.body);
    expect(session.get('customer')).toBe('cus_pre');
    expect(session.get('metadata[purchase_id]')).toBe(body.purchaseId);
    expect(session.get('metadata[app_id]')).toBe('club');
    expect(session.get('mode')).toBe('payment');
  });

  it('renew: true buys the recurring price in subscription mode', async () => {
    await checkout({ ...good, renew: true });
    expect(new URLSearchParams(stripeCalls()[0]!.body).get('mode')).toBe('subscription');
    expect((await purchases())[0]).toMatchObject({ mode: 'recurring', price_id: 'price_rec' });
  });

  it('creates one Stripe customer per user the first time, and reuses a Pro subscription\'s customer', async () => {
    await checkout(good, { uid: 'gh:5' });
    expect(calls.some((c) => c.url.endsWith('/v1/customers'))).toBe(true);
    expect((await db.prepare("SELECT stripe_customer_id AS id FROM billing_customers WHERE user_id = 'gh:5'").first<{ id: string }>())!.id).toBe('cus_new');
    calls.length = 0;
    await db.prepare("INSERT INTO subscriptions (user_id, stripe_customer_id, stripe_subscription_id, status, tier, current_period_end, cancel_at_period_end, created_at, updated_at) VALUES ('gh:6', 'cus_pro', 'sub_pro', 'active', 'pro', 0, 0, 1, 1)").run();
    await checkout(good, { uid: 'gh:6' });
    expect(calls.some((c) => c.url.endsWith('/v1/customers'))).toBe(false);
    expect(new URLSearchParams(stripeCalls()[0]!.body).get('customer')).toBe('cus_pro');
  });

  it('a Stripe failure marks the purchase failed and answers 502', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => (String(url).includes('pas-data-') ? verdict() : new Response('{"error":{}}', { status: 500 }))));
    const e = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect((await checkout(good)).status).toBe(502);
    e.mockRestore();
    expect((await purchases())[0]!.status).toBe('failed');
  });
});

describe('everything that can refuse does so before Stripe is called', () => {
  const refused = async (res: Response, status: number, message?: RegExp) => {
    expect(res.status).toBe(status);
    if (message) expect(await err(res)).toMatch(message);
    expect(stripeCalls()).toEqual([]);
    expect(await purchases()).toEqual([]);
  };

  it('no session, an unknown app, an app id that is not one, a body that is not JSON', async () => {
    await refused(await checkout(good, { uid: null }), 401);
    await refused(await checkout(good, { appId: 'nope' }), 404);
    await refused(await checkout(good, { appId: 'Bad_Id' }), 404);
    await refused(await checkout('not json'), 400, /JSON body/);
  });

  it('billing off, or never declared, is 403 whatever else is wrong', async () => {
    await db.prepare("UPDATE app_billing SET enabled = 0").run();
    await refused(await checkout({ product: 'nope' }), 403, /not enabled/);
    await db.prepare("DELETE FROM app_billing").run();
    await refused(await checkout(good), 403, /not enabled/);
  });

  it('a missing, unknown, inactive or other-app product', async () => {
    await refused(await checkout({ ...good, product: undefined }), 400, /product is required/);
    await refused(await checkout({ ...good, product: 'nope' }), 400, /unknown product/);
    await db.prepare("UPDATE app_billing_products SET active = 0").run();
    await refused(await checkout(good), 400, /unknown product/);
  });

  it('bad subjects: none, too many, repeated, wrong shape, too long, or a product that takes none', async () => {
    await refused(await checkout({ ...good, subjects: undefined }), 400, /non-empty list/);
    await refused(await checkout({ ...good, subjects: [] }), 400, /non-empty list/);
    await refused(await checkout({ ...good, subjects: Array.from({ length: 51 }, (_, i) => `s${i}`) }), 400, /at most 50/);
    await refused(await checkout({ ...good, subjects: ['a', 'a'] }), 400, /not repeat/);
    await refused(await checkout({ ...good, subjects: ['a', ''] }), 400, /non-empty string/);
    await refused(await checkout({ ...good, subjects: [7] }), 400, /non-empty string/);
    await refused(await checkout({ ...good, subjects: ['x'.repeat(129)] }), 400, /at most 128/);
    await db.prepare("UPDATE app_billing_products SET subject = 'none'").run();
    await refused(await checkout({ ...good, subjects: ['a'] }), 400, /takes no subjects/);
  });

  it('a mode the product cannot be bought in, and a renew flag that is not a boolean', async () => {
    await refused(await checkout({ ...good, renew: 'yes' }), 400, /renew must be/);
    await db.prepare("UPDATE app_billing_products SET modes = '[\"one_time\"]'").run();
    await refused(await checkout({ ...good, renew: true }), 400, /auto-renew/);
    await db.prepare("UPDATE app_billing_products SET modes = '[\"recurring\"]'").run();
    await refused(await checkout(good), 400, /one-off/);
  });

  it("redirect URLs off the app's own origins, or missing", async () => {
    await refused(await checkout({ ...good, successUrl: 'https://evil.example/' }), 400, /own origins/);
    await refused(await checkout({ ...good, cancelUrl: 'http://club.proappstore.online/' }), 400, /own origins/);
    await refused(await checkout({ ...good, cancelUrl: 'https://user:pw@club.proappstore.online/' }), 400, /own origins/);
    await refused(await checkout({ ...good, cancelUrl: 'not a url' }), 400, /own origins/);
    await refused(await checkout({ ...good, successUrl: undefined }), 400, /required/);
    expect((await checkout({ ...good, successUrl: 'http://localhost:5173/ok', cancelUrl: 'http://127.0.0.1:5173/' })).status).toBe(200);
  });

  it("a verified custom domain is an origin of the app; an unverified one is not", async () => {
    await db.prepare("INSERT INTO app_custom_domains (app_id, domain, status, added_at) VALUES ('club', 'club.example.com', 'pending', 1)").run();
    await refused(await checkout({ ...good, successUrl: 'https://club.example.com/ok' }), 400, /own origins/);
    await db.prepare("UPDATE app_custom_domains SET status = 'active'").run();
    expect((await checkout({ ...good, successUrl: 'https://shop.club.example.com/ok' })).status).toBe(200);
  });

  it('a product with no active price is not available yet', async () => {
    await db.prepare("UPDATE app_billing_prices SET status = 'archived'").run();
    await refused(await checkout(good), 503, /not available/);
  });

  it('the app decides who may buy: no authorize action, a staged one, a refusal, a failure, or the wrong number of rows', async () => {
    await db.prepare("UPDATE app_billing SET authorize_action = NULL").run();
    await refused(await checkout(good), 503, /no authorize action/);
    await db.prepare("UPDATE app_billing SET authorize_action = 'gone'").run();
    await refused(await checkout(good), 503, /no authorize action/);
    await db.prepare("UPDATE app_billing SET authorize_action = 'may_buy'").run();
    await db.prepare("UPDATE app_tools SET state = 'staged'").run();
    await refused(await checkout(good), 403, /not live/);
    await db.prepare("UPDATE app_tools SET state = 'live'").run();

    verdict = () => new Response(JSON.stringify({ rows: [{ allowed: 0 }] }), { status: 200 });
    await refused(await checkout(good), 403, /may not buy/);
    verdict = () => new Response(JSON.stringify({ rows: [] }), { status: 200 });
    await refused(await checkout(good), 403, /may not buy/);
    verdict = () => new Response(JSON.stringify({ rows: [{ allowed: 1 }, { allowed: 1 }] }), { status: 200 });
    await refused(await checkout(good), 403, /may not buy/);
    verdict = () => new Response('{}', { status: 500 });
    await refused(await checkout(good), 502, /could not check/);
    verdict = () => new Response('not json', { status: 200 });
    await refused(await checkout(good), 403, /may not buy/);
  });

  it('an authorize action whose manifest cannot be bound is a 500, never a purchase', async () => {
    await db.prepare("UPDATE app_tools SET manifest = '{\"broken\":'").run();
    await refused(await checkout(good), 500, /could not be run/);
  });
});
