import { readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { app } from '../index.js';
import { makeEnv, testToken } from '../test-helpers.js';

// #507 against real SQLite (node:sqlite) running EVERY root migration, 0118 included: products declared
// in mcp.json register through the real PUT route, the deploy-time upsert talks to a mocked Stripe (no
// key, no network), and POST /v1/apps/:appId/billing/checkout runs the app's authorize action first.

const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');
const MIGRATIONS = new URL('../../../../migrations/', import.meta.url);

let sqlite: InstanceType<typeof DatabaseSync>;
type Stmt = { sql: string; args: unknown[] };
function exec({ sql, args }: Stmt, mode: 'first' | 'all' | 'run') {
  const st = sqlite.prepare(sql);
  const params = args.map((a) => (a === undefined ? null : a)) as never[];
  if (mode === 'first') return (st.get(...params) as unknown) ?? null;
  if (mode === 'all') return { results: st.all(...params) };
  const r = st.run(...params);
  return { meta: { changes: Number(r.changes) } };
}
const db = {
  prepare(sql: string) {
    const make = (args: unknown[]): Stmt & Record<string, unknown> => ({
      sql, args,
      bind: (...a: unknown[]) => make(a),
      first: async () => exec({ sql, args }, 'first'),
      all: async () => exec({ sql, args }, 'all'),
      run: async () => exec({ sql, args }, 'run'),
    });
    return make([]);
  },
  async batch(stmts: Stmt[]) {
    sqlite.exec('BEGIN');
    try {
      const out = stmts.map((s) => (/^\s*SELECT/i.test(s.sql) ? exec(s, 'all') : exec(s, 'run')));
      sqlite.exec('COMMIT');
      return out;
    } catch (err) {
      sqlite.exec('ROLLBACK');
      throw err;
    }
  },
} as unknown as D1Database;

const get = <T>(sql: string, ...args: unknown[]) => sqlite.prepare(sql).get(...(args as never[])) as T;
const rowsOf = <T>(sql: string, ...args: unknown[]) => sqlite.prepare(sql).all(...(args as never[])) as T[];

const authorizeTool = {
  name: 'billing_can_buy', description: 'May this buyer buy this product for these subjects', operation: 'query', requires_auth: true,
  callers: ['billing'], params: { product: { type: 'string' }, subjects_json: { type: 'string' } },
  sql: "SELECT 1 AS allowed FROM members WHERE user_id = :__user_id AND :product <> '' AND :subjects_json <> '' LIMIT 1",
};
const term = {
  key: 'child_term', name: 'Chess Academy term (per child)', amount: 1000, currency: 'AUD', tax_behavior: 'inclusive',
  modes: ['one_time', 'recurring'], interval: { unit: 'month', count: 3 }, grace_days: 5, subject: 'required',
};
const billing = (product: Record<string, unknown> = term) => ({ authorize_action: 'billing_can_buy', products: [product] });

interface StripeCall { path: string; form: URLSearchParams }
let stripeCalls: StripeCall[] = [];
let queries: { app: string; params: unknown[] }[] = [];
let authorizeRows: Record<string, unknown>[] = [{ allowed: 1 }];
let authorizeStatus = 200;
let stripeFails: false | true | string = false;
let seq = 0;
let envOverrides: Record<string, unknown> = {};

function installFetch(): void {
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    const text = typeof init?.body === 'string' ? init.body : '';
    if (url.host === 'api.stripe.com') {
      stripeCalls.push({ path: url.pathname, form: new URLSearchParams(text) });
      const p0 = url.pathname;
      if (stripeFails === true || (stripeFails && p0 === stripeFails)) return new Response('{"error":"boom"}', { status: 500 });
      const p = url.pathname;
      const prefix = p === '/v1/products' ? 'prod' : p === '/v1/prices' ? 'price' : p === '/v1/customers' ? 'cus' : p === '/v1/checkout/sessions' ? 'cs' : p.startsWith('/v1/prices/') ? 'arch' : 'prodname';
      const id = `${prefix}_${++seq}`;
      return new Response(JSON.stringify({ id, ...(prefix === 'cs' ? { url: `https://checkout.stripe.test/${id}` } : {}) }), { status: 200 });
    }
    const dw = /^pas-data-([a-z-]+)\./.exec(url.host);
    if (dw && url.pathname === '/validate') {
      return new Response(JSON.stringify({ results: (JSON.parse(text) as { statements: { id: string }[] }).statements.map((st) => ({ id: st.id, ok: true })) }), { status: 200 });
    }
    if (dw && url.pathname === '/query') {
      queries.push({ app: dw[1]!, params: (JSON.parse(text) as { params: unknown[] }).params });
      return new Response(JSON.stringify({ rows: authorizeRows, meta: {} }), { status: authorizeStatus });
    }
    throw new Error(`unexpected fetch ${url.href}`);
  }) as unknown as typeof fetch;
}

const env = () => makeEnv(envOverrides, db as never);
const ADMIN = await testToken('gh:admin', { roles: ['user', 'admin'] });
const BUYER = await testToken('gh:buyer');

async function deploy(appId: string, site: Record<string, unknown>, tools: unknown[] = [authorizeTool]): Promise<{ status: number; body: Record<string, unknown> & { error?: string; warnings?: string[] } }> {
  const res = await app.request(`/v1/apps/${appId}/tools`, {
    method: 'PUT', headers: { Authorization: `Bearer ${ADMIN}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ tools, ...site }),
  }, env());
  return { status: res.status, body: await res.json() };
}
const calls = (path: string) => stripeCalls.filter((c) => c.path === path);

const OK_URLS = { successUrl: 'https://club.proappstore.online/paid', cancelUrl: 'https://club.proappstore.online/cart' };
async function checkout(body: Record<string, unknown>, appId = 'club', token: string | null = BUYER) {
  return app.request(`/v1/apps/${appId}/billing/checkout`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify({ product: 'child_term', subjects: ['kid-1', 'kid-2'], renew: false, ...OK_URLS, ...body }),
  }, env());
}

beforeEach(() => {
  sqlite = new DatabaseSync(':memory:');
  for (const f of readdirSync(MIGRATIONS).filter((n) => n.endsWith('.sql')).sort()) sqlite.exec(readFileSync(new URL(f, MIGRATIONS), 'utf8'));
  const now = Date.now();
  for (const id of ['club', 'other']) {
    sqlite.prepare("INSERT INTO apps (id, creator_id, created_at) VALUES (?, 'gh:admin', ?)").run(id, now);
  }
  stripeCalls = []; queries = []; authorizeRows = [{ allowed: 1 }]; authorizeStatus = 200; stripeFails = false; seq = 0; envOverrides = {};
  installFetch();
});

describe('migration 0118 (#507)', () => {
  it('is purely additive: it only creates tables and indexes, and the tables exist', () => {
    const sql = readFileSync(new URL('0118_app_billing.sql', MIGRATIONS), 'utf8').replace(/--.*$/gm, '');
    const statements = sql.split(';').map((s) => s.trim()).filter(Boolean);
    expect(statements.every((s) => /^CREATE (TABLE|INDEX) IF NOT EXISTS /i.test(s))).toBe(true);
    const names = rowsOf<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table'").map((r) => r.name);
    for (const t of ['purchases', 'app_products', 'app_product_prices', 'app_billing', 'billing_customers']) expect(names).toContain(t);
  });

  it('purchases stores the buyer, the product, the subjects as JSON, the Stripe session id, a pending default and created_at', () => {
    const cols = rowsOf<{ name: string; dflt_value: string | null }>('PRAGMA table_info(purchases)');
    const names = cols.map((c) => c.name);
    for (const c of ['id', 'app_id', 'product_key', 'buyer_user_id', 'subjects', 'stripe_session_id', 'status', 'created_at']) expect(names).toContain(c);
    expect(cols.find((c) => c.name === 'status')!.dflt_value).toBe("'pending'");
  });
});

describe('deploy-time Stripe upsert (#507)', () => {
  it('creates one Product and a Price per mode, with app_id/product_key metadata, interval and tax behaviour', async () => {
    const r = await deploy('club', { billing: billing() });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(calls('/v1/products')).toHaveLength(1);
    const product = calls('/v1/products')[0]!.form;
    expect(product.get('name')).toBe(term.name);
    expect(product.get('metadata[app_id]')).toBe('club');
    expect(product.get('metadata[product_key]')).toBe('child_term');
    const prices = calls('/v1/prices');
    expect(prices).toHaveLength(2);
    const oneTime = prices.find((p) => !p.form.has('recurring[interval]'))!.form;
    const recurring = prices.find((p) => p.form.has('recurring[interval]'))!.form;
    for (const f of [oneTime, recurring]) {
      expect(f.get('unit_amount')).toBe('1000');
      expect(f.get('currency')).toBe('aud');
      expect(f.get('tax_behavior')).toBe('inclusive');
      expect(f.get('metadata[app_id]')).toBe('club');
      expect(f.get('metadata[product_key]')).toBe('child_term');
    }
    expect(recurring.get('recurring[interval]')).toBe('month');
    expect(recurring.get('recurring[interval_count]')).toBe('3');
    expect(rowsOf("SELECT kind, version, active, archived FROM app_product_prices WHERE app_id = 'club' ORDER BY kind")).toEqual([
      { kind: 'one_time', version: 1, active: 1, archived: 0 },
      { kind: 'recurring', version: 1, active: 1, archived: 0 },
    ]);
  });

  it('a redeploy with the same amount creates nothing in Stripe', async () => {
    await deploy('club', { billing: billing() });
    expect(stripeCalls).toHaveLength(3);
    const again = await deploy('club', { billing: billing() });
    expect(again.status).toBe(200);
    expect(stripeCalls).toHaveLength(3);
    expect(get<{ n: number }>("SELECT COUNT(*) AS n FROM app_product_prices WHERE app_id = 'club'").n).toBe(2);
  });

  it('a changed amount creates a new Price (version 2) and archives the old one; the Product is reused, nothing is deleted', async () => {
    await deploy('club', { billing: billing() });
    const old = rowsOf<{ stripe_price_id: string }>("SELECT stripe_price_id FROM app_product_prices WHERE app_id = 'club'").map((r) => r.stripe_price_id);
    stripeCalls = [];
    const r = await deploy('club', { billing: billing({ ...term, amount: 1200 }) });
    expect(r.status).toBe(200);
    expect(calls('/v1/products')).toHaveLength(0);
    const created = calls('/v1/prices');
    expect(created).toHaveLength(2);
    expect(created.every((c) => c.form.get('unit_amount') === '1200')).toBe(true);
    const archived = stripeCalls.filter((c) => /^\/v1\/prices\/.+/.test(c.path));
    expect(archived.map((c) => c.path).sort()).toEqual(old.map((id) => `/v1/prices/${id}`).sort());
    expect(archived.every((c) => c.form.get('active') === 'false')).toBe(true);
    expect(stripeCalls.some((c) => /delete/i.test(c.path))).toBe(false);
    expect(rowsOf('SELECT kind, version, active, archived, amount FROM app_product_prices ORDER BY kind, version')).toEqual([
      { kind: 'one_time', version: 1, active: 0, archived: 1, amount: 1000 },
      { kind: 'one_time', version: 2, active: 1, archived: 0, amount: 1200 },
      { kind: 'recurring', version: 1, active: 0, archived: 1, amount: 1000 },
      { kind: 'recurring', version: 2, active: 1, archived: 0, amount: 1200 },
    ]);
    // 1000 -> 1200 -> 1000 again is a third version, never a reuse of an archived Price
    stripeCalls = [];
    await deploy('club', { billing: billing() });
    expect(calls('/v1/prices')).toHaveLength(2);
    expect(get<{ v: number }>("SELECT MAX(version) AS v FROM app_product_prices WHERE kind = 'one_time'").v).toBe(3);
  });

  it('a changed interval or tax behaviour also creates a new Price; a renamed product only renames', async () => {
    await deploy('club', { billing: billing() });
    stripeCalls = [];
    await deploy('club', { billing: billing({ ...term, interval: { unit: 'month', count: 6 } }) });
    expect(calls('/v1/prices')).toHaveLength(1); // only the recurring one carries the interval
    stripeCalls = [];
    await deploy('club', { billing: billing({ ...term, interval: { unit: 'month', count: 6 }, name: 'Renamed' }) });
    expect(calls('/v1/prices')).toHaveLength(0);
    expect(stripeCalls.map((c) => c.path)).toEqual(['/v1/products/prod_1']);
  });

  it('a product dropped from the manifest goes inactive without any Stripe call, and checkout refuses it', async () => {
    await deploy('club', { billing: billing() });
    stripeCalls = [];
    expect((await deploy('club', {})).status).toBe(200);
    expect(stripeCalls).toHaveLength(0);
    expect(get<{ active: number }>("SELECT active FROM app_products WHERE app_id = 'club'").active).toBe(0);
    expect((await checkout({})).status).toBe(400);
  });

  it.each([
    ['an authorize action that is not registered', { authorize_action: 'nope', products: [term] }, 'is not an action'],
    ['an authorize action without the billing caller', { authorize_action: 'plain', products: [term] }, 'must list "billing"'],
    ['a zero amount', billing({ ...term, amount: 0 }), 'amount'],
    ['recurring without an interval', billing({ ...term, interval: undefined }), 'interval is required'],
    ['an unknown mode', billing({ ...term, modes: ['payment'] }), 'modes'],
    ['a bad key', billing({ ...term, key: 'Child Term' }), 'key'],
  ])('refuses %s with 400 and writes nothing', async (_l, bad, fragment) => {
    const plain = { ...authorizeTool, name: 'plain', callers: undefined };
    const r = await deploy('club', { billing: bad }, [authorizeTool, plain]);
    expect(r.status).toBe(400);
    expect(r.body.error).toContain(fragment);
    expect(stripeCalls).toHaveLength(0);
    expect(get<{ n: number }>('SELECT COUNT(*) AS n FROM app_products').n).toBe(0);
  });

  it('without a Stripe key the products register with a warning, and the next deploy with a key syncs them', async () => {
    envOverrides = { STRIPE_SECRET_KEY: '' };
    const r = await deploy('club', { billing: billing() });
    expect(r.status).toBe(200);
    expect(r.body.warnings?.join(' ')).toContain('STRIPE_SECRET_KEY is not configured');
    expect(stripeCalls).toHaveLength(0);
    envOverrides = {};
    expect((await deploy('club', { billing: billing() })).status).toBe(200);
    expect(calls('/v1/prices')).toHaveLength(2);
  });

  it('a Stripe failure is a warning, not a failed deploy, and a redeploy retries', async () => {
    stripeFails = true;
    const r = await deploy('club', { billing: billing() });
    expect(r.status).toBe(200);
    expect(r.body.warnings?.join(' ')).toContain('not fully synced');
    stripeFails = false;
    stripeCalls = [];
    expect((await deploy('club', { billing: billing() })).status).toBe(200);
    expect(calls('/v1/prices')).toHaveLength(2);
  });
});

describe('POST /v1/apps/:appId/billing/checkout (#507)', () => {
  beforeEach(async () => {
    expect((await deploy('club', { billing: billing() })).status).toBe(200);
    stripeCalls = [];
  });

  it('runs the authorize action as the buyer, then opens Checkout for quantity = subjects, with the purchase id in the metadata', async () => {
    const res = await checkout({});
    expect(res.status, await res.clone().text()).toBe(200);
    const out = await res.json() as { url: string; purchaseId: string };
    expect(out.url).toMatch(/^https:\/\/checkout\.stripe\.test\/cs_/);
    // the authorize action ran for this app with the buyer, the product and the subjects as JSON
    expect(queries).toHaveLength(1);
    expect(queries[0]!.app).toBe('club');
    expect(queries[0]!.params).toEqual(['gh:buyer', 'child_term', '["kid-1","kid-2"]']);
    const session = calls('/v1/checkout/sessions')[0]!.form;
    expect(session.get('mode')).toBe('payment');
    expect(session.get('line_items[0][quantity]')).toBe('2');
    const priceId = get<{ stripe_price_id: string }>("SELECT stripe_price_id FROM app_product_prices WHERE kind = 'one_time' AND active = 1").stripe_price_id;
    expect(session.get('line_items[0][price]')).toBe(priceId);
    expect(session.get('metadata[purchase_id]')).toBe(out.purchaseId);
    expect(session.get('metadata[app_id]')).toBe('club');
    expect(session.get('metadata[product_key]')).toBe('child_term');
    expect(session.get('metadata[user_id]')).toBe('gh:buyer');
    expect(session.get('payment_intent_data[metadata][purchase_id]')).toBe(out.purchaseId);
    expect([...session.values()].some((v) => v.includes('kid-1'))).toBe(false); // subjects never go to Stripe
    const purchase = get<Record<string, unknown>>('SELECT * FROM purchases WHERE id = ?', out.purchaseId);
    expect(purchase).toMatchObject({
      app_id: 'club', product_key: 'child_term', buyer_user_id: 'gh:buyer', subjects: '["kid-1","kid-2"]', quantity: 2, renew: 0, mode: 'payment', status: 'pending',
    });
    expect(String(purchase.stripe_session_id)).toMatch(/^cs_/);
    // one Customer per user, reused by the next checkout
    await checkout({});
    expect(calls('/v1/customers')).toHaveLength(1);
  });

  it('the authorize call is made before any Stripe call', async () => {
    const order: string[] = [];
    const inner = globalThis.fetch;
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const host = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url).host;
      order.push(host.startsWith('pas-data-') ? 'authorize' : host);
      return inner(input, init);
    }) as unknown as typeof fetch;
    expect((await checkout({})).status).toBe(200);
    expect(order[0]).toBe('authorize');
    expect(order.indexOf('api.stripe.com')).toBeGreaterThan(0);
  });

  it('renew: true buys the recurring Price in subscription mode', async () => {
    const res = await checkout({ renew: true, subjects: ['kid-1'] });
    expect(res.status).toBe(200);
    const session = calls('/v1/checkout/sessions')[0]!.form;
    expect(session.get('mode')).toBe('subscription');
    expect(session.get('line_items[0][quantity]')).toBe('1');
    expect(session.get('subscription_data[metadata][app_id]')).toBe('club');
    const recurringId = get<{ stripe_price_id: string }>("SELECT stripe_price_id FROM app_product_prices WHERE kind = 'recurring' AND active = 1").stripe_price_id;
    expect(session.get('line_items[0][price]')).toBe(recurringId);
    expect(get('SELECT renew, mode FROM purchases')).toEqual({ renew: 1, mode: 'subscription' });
  });

  it('refuses a mode the product does not list', async () => {
    await deploy('club', { billing: billing({ ...term, modes: ['one_time'], interval: undefined }) });
    stripeCalls = [];
    const res = await checkout({ renew: true });
    expect(res.status).toBe(400);
    expect(stripeCalls).toHaveLength(0);
  });

  it.each([
    ['no row', []],
    ['allowed = 0', [{ allowed: 0 }]],
    ['two rows', [{ allowed: 1 }, { allowed: 1 }]],
    ['a row without allowed', [{ ok: 1 }]],
  ])('403 and no Stripe call when the authorize action returns %s', async (_l, rows) => {
    authorizeRows = rows;
    const res = await checkout({});
    expect(res.status).toBe(403);
    expect(stripeCalls).toHaveLength(0);
    expect(get<{ n: number }>('SELECT COUNT(*) AS n FROM purchases').n).toBe(0);
  });

  it('fails closed (502, no Stripe call) when the authorize action cannot run', async () => {
    authorizeStatus = 500;
    const res = await checkout({});
    expect(res.status).toBe(502);
    expect(stripeCalls).toHaveLength(0);
  });

  it("400 for an unknown product, and for another app's product key", async () => {
    expect((await checkout({ product: 'nope' })).status).toBe(400);
    await deploy('other', { billing: billing({ ...term, key: 'secret_pack', subject: 'none' }) });
    stripeCalls = [];
    const res = await checkout({ product: 'secret_pack', subjects: [] }, 'club');
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'unknown product' });
    expect(stripeCalls).toHaveLength(0);
    // ...while the owning app can sell it, with quantity 1 for a subject-less product
    const own = await checkout({ product: 'secret_pack', subjects: [], successUrl: 'https://other.proappstore.online/ok', cancelUrl: 'https://other.proappstore.online/no' }, 'other');
    expect(own.status, await own.clone().text()).toBe(200);
    expect(calls('/v1/checkout/sessions')[0]!.form.get('line_items[0][quantity]')).toBe('1');
  });

  it('400 for an empty or missing subject list on a subject-required product, and for subjects on a subject-less one', async () => {
    expect((await checkout({ subjects: [] })).status).toBe(400);
    expect((await checkout({ subjects: undefined })).status).toBe(400);
    expect((await checkout({ subjects: ['a', 'a'] })).status).toBe(400);
    await deploy('club', { billing: billing({ ...term, subject: 'none' }) });
    expect((await checkout({ subjects: ['kid-1'] })).status).toBe(400);
    expect(stripeCalls).toHaveLength(0);
    expect(queries).toHaveLength(0);
  });

  it("400 for a redirect URL outside the app's origins", async () => {
    for (const url of ['https://evil.example/x', 'https://other.proappstore.online/x', 'https://club.proappstore.online.evil.example/x', 'http://club.proappstore.online/x', 'https://x@evil.example/', 'javascript:alert(1)', 'not a url']) {
      expect((await checkout({ successUrl: url })).status, url).toBe(400);
      expect((await checkout({ cancelUrl: url })).status, url).toBe(400);
    }
    expect(stripeCalls).toHaveLength(0);
    expect(queries).toHaveLength(0);
  });

  it('accepts localhost, the PAS subdomain and an active custom domain with its subdomains, but not a pending one', async () => {
    sqlite.exec("INSERT INTO app_custom_domains (app_id, domain, status, added_at) VALUES ('club', 'chessclubs.online', 'active', 1), ('club', 'pending.example', 'pending', 1)");
    for (const url of ['http://localhost:5173/ok', 'https://club.proappstore.online/ok', 'https://chessclubs.online/ok', 'https://app.chessclubs.online/ok']) {
      expect((await checkout({ successUrl: url, cancelUrl: url })).status, url).toBe(200);
    }
    expect((await checkout({ successUrl: 'https://pending.example/ok' })).status).toBe(400);
  });

  it('401 without a session, before anything else', async () => {
    const res = await checkout({}, 'club', null);
    expect(res.status).toBe(401);
    expect(stripeCalls).toHaveLength(0);
    expect(queries).toHaveLength(0);
  });

  it('503 when the product has no Stripe Price yet (not synced)', async () => {
    sqlite.exec('DELETE FROM app_product_prices');
    const res = await checkout({});
    expect(res.status).toBe(503);
    expect(stripeCalls).toHaveLength(0);
  });

  it('the billing-only authorize action is not callable by a user through the actions route', async () => {
    const res = await app.request('/v1/apps/club/actions/billing_can_buy', {
      method: 'POST', headers: { Authorization: `Bearer ${BUYER}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ params: { product: 'child_term', subjects_json: '[]' } }),
    }, env());
    expect(res.status).toBe(403);
    expect(queries).toHaveLength(0);
  });

  it('Stripe failing to open the session marks the purchase failed and answers 502', async () => {
    stripeFails = '/v1/checkout/sessions';
    const res = await checkout({});
    expect(res.status).toBe(502);
    expect(get('SELECT status FROM purchases')).toEqual({ status: 'failed' });
  });

  it('Stripe failing to create the customer answers 502 and leaves no purchase', async () => {
    stripeFails = '/v1/customers';
    expect((await checkout({})).status).toBe(502);
    expect(get<{ n: number }>('SELECT COUNT(*) AS n FROM purchases').n).toBe(0);
  });
});
