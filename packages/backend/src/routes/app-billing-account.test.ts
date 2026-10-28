import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { app } from '../index.js';
import { forgetAppVisibility } from '../lib/visibility.js';
import { recordChargeEvent } from '../lib/billing-ledger.js';
import { sqliteD1 } from '../sqlite-d1.js';
import { makeEnv, testToken } from '../test-helpers.js';

// #509: what a buyer sees of their own purchases, the customer portal, the owner's ledger and the admin's switch. Real SQL (the
// platform's migrations on in-memory SQLite); the same behaviour runs on real D1 in packages/runtime-tests.

let db: ReturnType<typeof sqliteD1>;
let env: ReturnType<typeof makeEnv>;
beforeEach(async () => {
  db = sqliteD1();
  env = makeEnv({ DB: db });
  forgetAppVisibility();
  for (const id of ['club', 'other']) await seedApp(id, 'gh:owner');
  await db.prepare("INSERT INTO app_billing (app_id, authorize_action, enabled, created_at, updated_at) VALUES ('club', 'may_buy', 0, 1, 1)").run();
});
afterEach(() => vi.unstubAllGlobals());

async function seedApp(id: string, creator: string) {
  const cols = (await db.prepare('PRAGMA table_info(apps)').all<{ name: string; notnull: number; dflt_value: string | null }>()).results;
  const required = cols.filter((c) => c.notnull && c.dflt_value === null && !['id', 'creator_id'].includes(c.name)).map((c) => c.name);
  const names = ['id', 'creator_id', ...required];
  const values = [id, creator, ...required.map((c) => (/_at$/.test(c) ? 1 : `${id}-${c}`))];
  await db.prepare(`INSERT INTO apps (${names.join(', ')}) VALUES (${names.map(() => '?').join(', ')})`).bind(...values).run();
}

const tokens = new Map<string, string>();
async function req(method: string, path: string, uid: string | null, body?: unknown, roles?: string[]) {
  const key = `${uid}|${roles?.join()}`;
  if (uid && !tokens.has(key)) tokens.set(key, await testToken(uid, roles ? { roles } : {}));
  return app.request(`/v1${path}`, {
    method,
    headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(uid ? { Authorization: `Bearer ${tokens.get(key)}` } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  }, env as never);
}
const ADMIN = ['user', 'admin'];
const json = async <T>(res: Response) => (await res.json()) as T;

async function purchase(id: string, buyer: string, over: { app?: string; status?: string; subjects?: string[]; cancel?: number } = {}) {
  await db.prepare(
    `INSERT INTO app_purchases (id, app_id, product_key, buyer_user_id, subjects, quantity, mode, status, sub_cancel_at_period_end, created_at, updated_at)
     VALUES (?, ?, 'term', ?, ?, 1, 'one_time', ?, ?, 1000, 1000)`,
  ).bind(id, over.app ?? 'club', buyer, JSON.stringify(over.subjects ?? ['kid-a']), over.status ?? 'paid', over.cancel ?? 0).run();
}
const payment = (id: string, purchaseId: string, amount: number) =>
  db.prepare("INSERT INTO app_billing_payments (id, purchase_id, paid_at, amount, currency, created_at) VALUES (?, ?, 1000, ?, 'aud', 1000)").bind(id, purchaseId, amount).run();
const entitlement = (product: string, subject: string, buyer: string) =>
  db.prepare(
    `INSERT INTO app_entitlements (app_id, product_key, subject, status, period_start, period_end, renews, buyer_user_id, purchase_id, created_at, updated_at)
     VALUES ('club', ?, ?, 'active', 1000, 9000, 0, ?, 'pur', 1000, 1000)`,
  ).bind(product, subject, buyer).run();

describe('products', () => {
  const product = (key: string, active: number) => db.prepare(
    `INSERT INTO app_billing_products (app_id, product_key, name, amount, currency, modes, interval_unit, interval_count, grace_days, subject, active, created_at, updated_at)
     VALUES ('club', ?, ?, 1000, 'aud', '["one_time","recurring"]', 'month', 3, 5, 'required', ?, 1, 1)`,
  ).bind(key, `Product ${key}`, active).run();

  it('are refused until billing is enabled, then list the active ones only', async () => {
    await product('term', 1);
    await product('old', 0);
    const refused = await req('GET', '/apps/club/billing/products', 'gh:2');
    expect(refused.status).toBe(403);
    expect((await json<{ error: string }>(refused)).error).toBe('billing is not enabled for this app');
    await db.prepare("UPDATE app_billing SET enabled = 1 WHERE app_id = 'club'").run();
    const res = await req('GET', '/apps/club/billing/products', 'gh:2');
    expect((await json<{ products: unknown[] }>(res)).products).toEqual([
      { key: 'term', name: 'Product term', amount: 1000, currency: 'aud', taxBehavior: 'unspecified', modes: ['one_time', 'recurring'], interval: { unit: 'month', count: 3 }, graceDays: 5, subject: 'required' },
    ]);
  });

  it('need a signed-in user and an app that exists', async () => {
    expect((await req('GET', '/apps/club/billing/products', null)).status).toBe(401);
    expect((await req('GET', '/apps/nope/billing/products', 'gh:2')).status).toBe(404);
    expect((await req('GET', '/apps/Bad_Id/billing/products', 'gh:2')).status).toBe(404);
  });

  it('an app that declares no billing answers 403 too', async () => {
    expect((await req('GET', '/apps/other/billing/products', 'gh:2')).status).toBe(403);
  });
});

describe('a buyer sees only their own purchases and entitlements', () => {
  beforeEach(async () => {
    await purchase('pur_2', 'gh:2', { cancel: 1 });
    await purchase('pur_3', 'gh:3', { subjects: ['kid-b'] });
    await purchase('pur_pending', 'gh:2', { status: 'pending' });
    await purchase('pur_failed', 'gh:2', { status: 'failed' });
    await purchase('pur_elsewhere', 'gh:2', { app: 'other' });
    await payment('purchase:pur_2', 'pur_2', 2000);
    await entitlement('term', 'kid-a', 'gh:2');
    await entitlement('term', 'kid-b', 'gh:3');
    await entitlement('extra', 'kid-a', 'gh:3');
  });

  it("entitlements: each buyer gets their own rows, never another buyer's, even for the other's subject", async () => {
    type Ents = { entitlements: { product: string; subject: string; status: string; renews: boolean }[] };
    const mine = await json<Ents>(await req('GET', '/apps/club/billing/entitlements', 'gh:2'));
    expect(mine.entitlements.map((e) => `${e.product}/${e.subject}`)).toEqual(['term/kid-a']);
    expect(mine.entitlements[0]).toMatchObject({ status: 'active', periodEnd: 9000, renews: false });
    expect(JSON.stringify(mine)).not.toContain('gh:');
    expect((await json<Ents>(await req('GET', '/apps/club/billing/entitlements', 'gh:3'))).entitlements.map((e) => `${e.product}/${e.subject}`)).toEqual(['extra/kid-a', 'term/kid-b']);
    expect((await json<Ents>(await req('GET', '/apps/club/billing/entitlements?subjects=kid-b', 'gh:2'))).entitlements).toEqual([]);
    expect((await json<Ents>(await req('GET', '/apps/club/billing/entitlements?subjects=kid-a,kid-b', 'gh:3'))).entitlements).toHaveLength(2);
    expect((await json<Ents>(await req('GET', '/apps/club/billing/entitlements', 'gh:9'))).entitlements).toEqual([]);
  });

  it('entitlements: an empty subject list matches nothing, and an oversized one is refused', async () => {
    expect((await json<{ entitlements: unknown[] }>(await req('GET', '/apps/club/billing/entitlements?subjects=', 'gh:2'))).entitlements).toEqual([]);
    const many = Array.from({ length: 51 }, (_, i) => `s${i}`).join(',');
    expect((await req('GET', `/apps/club/billing/entitlements?subjects=${many}`, 'gh:2')).status).toBe(400);
  });

  it('purchases: only the caller\'s, in this app, paid ones, with what they paid and the renewal state', async () => {
    const mine = await json<{ purchases: { id: string; paid: number; cancelAtPeriodEnd: boolean }[] }>(await req('GET', '/apps/club/billing/purchases', 'gh:2'));
    expect(mine.purchases.map((p) => p.id)).toEqual(['pur_2']);
    expect(mine.purchases[0]).toMatchObject({ paid: 2000, currency: 'aud', cancelAtPeriodEnd: true, subjects: ['kid-a'] });
    expect((await json<{ purchases: { id: string }[] }>(await req('GET', '/apps/club/billing/purchases', 'gh:3'))).purchases.map((p) => p.id)).toEqual(['pur_3']);
  });

  it('need a signed-in user, and an app that exists', async () => {
    expect((await req('GET', '/apps/club/billing/entitlements', null)).status).toBe(401);
    expect((await req('GET', '/apps/club/billing/purchases', null)).status).toBe(401);
    expect((await req('GET', '/apps/nope/billing/entitlements', 'gh:2')).status).toBe(404);
  });
});

describe('the customer portal', () => {
  const RETURN = 'https://club.proappstore.online/account';
  beforeEach(async () => {
    await purchase('pur_2', 'gh:2');
    await db.prepare("INSERT INTO billing_customers (user_id, stripe_customer_id, created_at) VALUES ('gh:2', 'cus_buyer', 1), ('gh:3', 'cus_other', 1)").run();
  });

  it("is opened for the caller's own Stripe customer, whatever the request says", async () => {
    const sent: URLSearchParams[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => { sent.push(new URLSearchParams(String(init.body))); return new Response(JSON.stringify({ id: 'bps_1', url: 'https://billing.stripe.test/p/1' }), { status: 200 }); }));
    const res = await req('POST', '/apps/club/billing/portal', 'gh:2', { returnUrl: RETURN, customer: 'cus_other', userId: 'gh:3' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ url: 'https://billing.stripe.test/p/1' });
    expect(sent[0]!.get('customer')).toBe('cus_buyer');
    expect(sent[0]!.get('return_url')).toBe(RETURN);
  });

  it('is refused, with no Stripe call, for a customer with no purchase here and for a buyer with no customer', async () => {
    const f = vi.fn();
    vi.stubGlobal('fetch', f);
    expect((await req('POST', '/apps/club/billing/portal', 'gh:3', { returnUrl: RETURN })).status).toBe(404);
    await purchase('pur_9', 'gh:9');
    expect((await req('POST', '/apps/club/billing/portal', 'gh:9', { returnUrl: RETURN })).status).toBe(404);
    expect(f).not.toHaveBeenCalled();
  });

  it("refuses a return URL off the app's own origins, a missing one, and a missing session", async () => {
    expect((await req('POST', '/apps/club/billing/portal', 'gh:2', { returnUrl: 'https://evil.example/x' })).status).toBe(400);
    expect((await req('POST', '/apps/club/billing/portal', 'gh:2', {})).status).toBe(400);
    expect((await req('POST', '/apps/club/billing/portal', 'gh:2', { returnUrl: 'http://club.proappstore.online/x' })).status).toBe(400);
    expect((await req('POST', '/apps/club/billing/portal', null, { returnUrl: RETURN })).status).toBe(401);
  });

  it('answers 502 when Stripe refuses', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{"error":{"message":"no configuration"}}', { status: 400 })));
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect((await req('POST', '/apps/club/billing/portal', 'gh:2', { returnUrl: RETURN })).status).toBe(502);
    err.mockRestore();
  });
});

describe('the revenue ledger and the owner views', () => {
  beforeEach(async () => {
    await purchase('pur_2', 'gh:2');
    await payment('purchase:pur_2', 'pur_2', 2000);
    await db.prepare("INSERT INTO app_billing_payment_refs (ref, purchase_id) VALUES ('pi_1', 'pur_2')").run();
    await recordChargeEvent(db, { type: 'charge.refunded', data: { object: { id: 'ch_1', amount: 2000, currency: 'aud', amount_refunded: 500, payment_intent: 'pi_1', balance_transaction: 'txn_1' } } });
    await db.prepare("UPDATE app_billing_charges SET fee = 88, fee_currency = 'aud'").run();
  });

  it('shows the owner gross, refunds, fee and net per purchase, and totals', async () => {
    const res = await req('GET', '/apps/club/billing/owner/purchases', 'gh:owner');
    expect(res.status).toBe(200);
    const ledger = await json<{ purchases: Record<string, unknown>[]; totals: unknown[] }>(res);
    expect(ledger.purchases[0]).toMatchObject({ purchaseId: 'pur_2', gross: 2000, refunded: 500, fee: 88, net: 1412 });
    expect(ledger.totals).toEqual([{ currency: 'aud', gross: 2000, refunded: 500, fee: 88, net: 1412 }]);
  });

  it('is visible to the owner and a platform admin, and to no one else', async () => {
    expect((await req('GET', '/apps/club/billing/owner/purchases', 'gh:99', undefined, ADMIN)).status).toBe(200);
    for (const uid of ['gh:2', 'gh:9']) expect((await req('GET', '/apps/club/billing/owner/purchases', uid)).status).toBe(403);
    expect((await req('GET', '/apps/club/billing/owner/purchases', null)).status).toBe(401);
    expect((await req('GET', '/apps/nope/billing/owner/purchases', 'gh:owner')).status).toBe(404);
  });

  it('owner products and entitlements are owner-only too', async () => {
    await entitlement('term', 'kid-a', 'gh:2');
    await entitlement('other', 'kid-a', 'gh:2');
    expect(await (await req('GET', '/apps/club/billing/owner/products', 'gh:owner')).json()).toEqual({ enabled: false, authorizeAction: 'may_buy', products: [] });
    const ents = await json<{ entitlements: { buyerUserId: string }[] }>(await req('GET', '/apps/club/billing/owner/entitlements?product=term', 'gh:owner'));
    expect(ents.entitlements).toMatchObject([{ buyerUserId: 'gh:2' }]);
    expect((await json<{ entitlements: unknown[] }>(await req('GET', '/apps/club/billing/owner/entitlements', 'gh:owner'))).entitlements).toHaveLength(2);
    expect((await req('GET', '/apps/club/billing/owner/products', 'gh:2')).status).toBe(403);
    expect((await req('GET', '/apps/club/billing/owner/entitlements', 'gh:2')).status).toBe(403);
  });

  it('owner products carry the sync state of inactive and failing products', async () => {
    await db.prepare("INSERT INTO app_billing_products (app_id, product_key, name, amount, currency, modes, grace_days, subject, active, sync_error, created_at, updated_at) VALUES ('club', 'old', 'Old', 100, 'aud', '[\"one_time\"]', 0, 'none', 0, 'stripe down', 1, 1)").run();
    const body = await json<{ products: { key: string; active: boolean; syncError: string | null; interval: unknown }[] }>(await req('GET', '/apps/club/billing/owner/products', 'gh:owner'));
    expect(body.products).toMatchObject([{ key: 'old', active: false, syncError: 'stripe down', interval: null }]);
  });
});

describe('the enable flag', () => {
  const flag = async () => (await db.prepare("SELECT enabled FROM app_billing WHERE app_id = 'club'").first<{ enabled: number }>())!.enabled;

  it('is off by default, and only a platform admin turns it on or off', async () => {
    expect(await flag()).toBe(0);
    expect((await req('PUT', '/admin/apps/club/billing', 'gh:owner', { enabled: true })).status).toBe(403);
    expect(await flag()).toBe(0);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const on = await req('PUT', '/admin/apps/club/billing', 'gh:99', { enabled: true }, ADMIN);
    expect(await on.json()).toEqual({ ok: true, enabled: true });
    expect(await flag()).toBe(1);
    expect(await (await req('GET', '/admin/apps/club/billing', 'gh:99', undefined, ADMIN)).json()).toEqual({ enabled: true, authorizeAction: 'may_buy' });
    expect((await req('GET', '/admin/apps/club/billing', 'gh:owner')).status).toBe(403);
    await req('PUT', '/admin/apps/club/billing', 'gh:99', { enabled: false }, ADMIN);
    expect(await flag()).toBe(0);
    warn.mockRestore();
  });

  it('refuses a malformed body, an unknown app, and an app that declares no billing', async () => {
    expect((await req('PUT', '/admin/apps/club/billing', 'gh:99', { enabled: 'yes' }, ADMIN)).status).toBe(400);
    expect((await req('PUT', '/admin/apps/nope/billing', 'gh:99', { enabled: true }, ADMIN)).status).toBe(404);
    expect((await req('PUT', '/admin/apps/other/billing', 'gh:99', { enabled: true }, ADMIN)).status).toBe(404);
    expect((await req('GET', '/admin/apps/other/billing', 'gh:99', undefined, ADMIN)).status).toBe(404);
  });
});
