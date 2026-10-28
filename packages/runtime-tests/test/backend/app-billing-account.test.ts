import { SELF, env as providedEnv, fetchMock } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Env } from '../../../backend/src/types';
import { fillChargeFees } from '../../../backend/src/lib/billing-ledger';
import { BASE, mockNetwork, resetTables, seedApp, seedUser, session } from './helpers';

const env = providedEnv as unknown as Env;

// #509 (epic #506) on real D1 and the real migrations: what a buyer sees of their own purchases, the customer portal, the owner's
// revenue ledger, and the admin's switch. Only Stripe is intercepted.

const get = async (path: string, uid: string | null, roles?: string[]) =>
  SELF.fetch(`${BASE}/v1${path}`, { headers: uid ? { Authorization: `Bearer ${await session(uid, roles ? { roles } : {})}` } : {} });
const send = async (method: string, path: string, uid: string, body: unknown, roles?: string[]) =>
  SELF.fetch(`${BASE}/v1${path}`, { method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${await session(uid, roles ? { roles } : {})}` }, body: JSON.stringify(body) });
const ADMIN = ['user', 'admin'];

async function purchase(id: string, buyer: string, over: { app?: string; status?: string; subjects?: string[]; cancel?: number } = {}) {
  await env.DB.prepare(
    `INSERT INTO app_purchases (id, app_id, product_key, buyer_user_id, subjects, quantity, mode, status, sub_cancel_at_period_end, created_at, updated_at)
     VALUES (?, ?, 'term', ?, ?, 1, 'one_time', ?, ?, 1000, 1000)`,
  ).bind(id, over.app ?? 'club', buyer, JSON.stringify(over.subjects ?? ['kid-a']), over.status ?? 'paid', over.cancel ?? 0).run();
}
const payment = (id: string, purchaseId: string, amount: number) =>
  env.DB.prepare("INSERT INTO app_billing_payments (id, purchase_id, paid_at, amount, currency, created_at) VALUES (?, ?, 1000, ?, 'aud', 1000)").bind(id, purchaseId, amount).run();
const ref = (r: string, purchaseId: string) => env.DB.prepare('INSERT OR IGNORE INTO app_billing_payment_refs (ref, purchase_id) VALUES (?, ?)').bind(r, purchaseId).run();
const entitlement = (product: string, subject: string, buyer: string, status = 'active') =>
  env.DB.prepare(
    `INSERT INTO app_entitlements (app_id, product_key, subject, status, period_start, period_end, renews, buyer_user_id, purchase_id, created_at, updated_at)
     VALUES ('club', ?, ?, ?, 1000, 9000, 0, ?, 'pur', 1000, 1000)`,
  ).bind(product, subject, status, buyer).run();

async function signedPost(payload: unknown, secret = 'whsec_runtime'): Promise<Response> {
  const body = JSON.stringify(payload);
  const t = Math.floor(Date.now() / 1000);
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${t}.${body}`)));
  const v1 = [...mac].map((b) => b.toString(16).padStart(2, '0')).join('');
  return SELF.fetch('https://api.test/webhooks/stripe', { method: 'POST', headers: { 'stripe-signature': `t=${t},v1=${v1}`, 'Content-Type': 'application/json' }, body });
}
let n = 0;
const chargeEvent = (type: string, over: Record<string, unknown> = {}) => ({
  id: `evt_${++n}`, type, created: 1_800_000_000,
  data: { object: { id: 'ch_1', amount: 2000, currency: 'aud', amount_refunded: 0, payment_intent: 'pi_1', invoice: null, balance_transaction: 'txn_1', ...over } },
});
const stripe = () => fetchMock.get('https://api.stripe.com');

afterEach(() => fetchMock.assertNoPendingInterceptors());
beforeEach(async () => {
  mockNetwork();
  await resetTables();
  for (const t of ['app_billing', 'app_billing_products', 'app_purchases', 'app_entitlements', 'app_billing_payments', 'app_billing_payment_refs', 'app_billing_charges', 'billing_customers', 'app_custom_domains']) {
    await env.DB.prepare(`DELETE FROM ${t}`).run();
  }
  for (const [uid, login] of [['gh:owner', 'owner'], ['gh:2', 'buyer'], ['gh:3', 'other-buyer'], ['gh:9', 'stranger']] as const) await seedUser(uid, login);
  await seedApp('club', 'gh:owner');
  await seedApp('other', 'gh:owner');
  await env.DB.prepare("INSERT INTO app_billing (app_id, authorize_action, enabled, created_at, updated_at) VALUES ('club', 'may_buy', 0, 1, 1)").run();
});

describe('products', () => {
  const product = (key: string, active: number) => env.DB.prepare(
    `INSERT INTO app_billing_products (app_id, product_key, name, amount, currency, modes, interval_unit, interval_count, grace_days, subject, active, created_at, updated_at)
     VALUES ('club', ?, ?, 1000, 'aud', '["one_time","recurring"]', 'month', 3, 5, 'required', ?, 1, 1)`,
  ).bind(key, `Product ${key}`, active).run();

  it('are refused until billing is enabled, then list the active ones only', async () => {
    await product('term', 1);
    await product('old', 0);
    const refused = await get('/apps/club/billing/products', 'gh:2');
    expect(refused.status).toBe(403);
    expect(((await refused.json()) as { error: string }).error).toBe('billing is not enabled for this app');

    await env.DB.prepare("UPDATE app_billing SET enabled = 1 WHERE app_id = 'club'").run();
    const res = await get('/apps/club/billing/products', 'gh:2');
    expect(res.status).toBe(200);
    expect(((await res.json()) as { products: unknown[] }).products).toEqual([
      { key: 'term', name: 'Product term', amount: 1000, currency: 'aud', taxBehavior: 'unspecified', modes: ['one_time', 'recurring'], interval: { unit: 'month', count: 3 }, graceDays: 5, subject: 'required' },
    ]);
  });

  it('need a signed-in user', async () => {
    expect((await get('/apps/club/billing/products', null)).status).toBe(401);
  });
});

describe("a buyer sees only their own purchases and entitlements", () => {
  beforeEach(async () => {
    await purchase('pur_2', 'gh:2', { subjects: ['kid-a'], cancel: 1 });
    await purchase('pur_3', 'gh:3', { subjects: ['kid-b'] });
    await purchase('pur_pending', 'gh:2', { status: 'pending' });
    await purchase('pur_elsewhere', 'gh:2', { app: 'other' });
    await payment('purchase:pur_2', 'pur_2', 2000);
    await payment('purchase:pur_3', 'pur_3', 3000);
    await entitlement('term', 'kid-a', 'gh:2');
    await entitlement('term', 'kid-b', 'gh:3');
    await entitlement('extra', 'kid-a', 'gh:3');
  });

  it("entitlements: each buyer gets their own rows, never another buyer's, even when they name the other's subject", async () => {
    const mine = (await (await get('/apps/club/billing/entitlements', 'gh:2')).json()) as { entitlements: { product: string; subject: string; status: string; renews: boolean }[] };
    expect(mine.entitlements.map((e) => `${e.product}/${e.subject}`)).toEqual(['term/kid-a']);
    expect(mine.entitlements[0]).toMatchObject({ status: 'active', periodEnd: 9000, renews: false });
    expect(JSON.stringify(mine)).not.toContain('gh:');

    const theirs = (await (await get('/apps/club/billing/entitlements', 'gh:3')).json()) as { entitlements: { product: string; subject: string }[] };
    expect(theirs.entitlements.map((e) => `${e.product}/${e.subject}`)).toEqual(['extra/kid-a', 'term/kid-b']);

    const probing = (await (await get('/apps/club/billing/entitlements?subjects=kid-b', 'gh:2')).json()) as { entitlements: unknown[] };
    expect(probing.entitlements).toEqual([]);
    const narrowed = (await (await get('/apps/club/billing/entitlements?subjects=kid-a,kid-b', 'gh:3')).json()) as { entitlements: unknown[] };
    expect(narrowed.entitlements).toHaveLength(2);
    expect(((await (await get('/apps/club/billing/entitlements', 'gh:9')).json()) as { entitlements: unknown[] }).entitlements).toEqual([]);
  });

  it('purchases: only the caller’s, in this app, paid ones, with what they paid and whether renewal is cancelled', async () => {
    const mine = (await (await get('/apps/club/billing/purchases', 'gh:2')).json()) as { purchases: { id: string; paid: number; cancelAtPeriodEnd: boolean }[] };
    expect(mine.purchases.map((p) => p.id)).toEqual(['pur_2']);
    expect(mine.purchases[0]).toMatchObject({ paid: 2000, currency: 'aud', cancelAtPeriodEnd: true });
    expect(((await (await get('/apps/club/billing/purchases', 'gh:3')).json()) as { purchases: { id: string }[] }).purchases.map((p) => p.id)).toEqual(['pur_3']);
  });

  it('need a signed-in user, and an app that exists', async () => {
    expect((await get('/apps/club/billing/entitlements', null)).status).toBe(401);
    expect((await get('/apps/club/billing/purchases', null)).status).toBe(401);
    expect((await get('/apps/nope/billing/entitlements', 'gh:2')).status).toBe(404);
  });
});

describe('the customer portal', () => {
  const RETURN = 'https://club.proappstore.online/account';
  beforeEach(async () => {
    await purchase('pur_2', 'gh:2');
    await env.DB.prepare("INSERT INTO billing_customers (user_id, stripe_customer_id, created_at) VALUES ('gh:2', 'cus_buyer', 1), ('gh:3', 'cus_other', 1)").run();
  });

  it("is opened for the caller's own Stripe customer, whatever the request says", async () => {
    let body = new URLSearchParams();
    stripe().intercept({ path: '/v1/billing_portal/sessions', method: 'POST' }).reply(200, (req) => { body = new URLSearchParams(String(req.body)); return { id: 'bps_1', url: 'https://billing.stripe.test/p/1' }; });
    const res = await send('POST', '/apps/club/billing/portal', 'gh:2', { returnUrl: RETURN, customer: 'cus_other', userId: 'gh:3' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ url: 'https://billing.stripe.test/p/1' });
    expect(body.get('customer')).toBe('cus_buyer');
    expect(body.get('return_url')).toBe(RETURN);
  });

  it('is refused, with no Stripe call, for someone with a customer but no purchase here, and for someone with no customer', async () => {
    expect((await send('POST', '/apps/club/billing/portal', 'gh:3', { returnUrl: RETURN })).status).toBe(404);
    await purchase('pur_9', 'gh:9');
    expect((await send('POST', '/apps/club/billing/portal', 'gh:9', { returnUrl: RETURN })).status).toBe(404);
  });

  it("refuses a return URL off the app's own origins, and a missing one", async () => {
    expect((await send('POST', '/apps/club/billing/portal', 'gh:2', { returnUrl: 'https://evil.example/x' })).status).toBe(400);
    expect((await send('POST', '/apps/club/billing/portal', 'gh:2', {})).status).toBe(400);
  });

  it('needs a signed-in user', async () => {
    const res = await SELF.fetch(`${BASE}/v1/apps/club/billing/portal`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ returnUrl: RETURN }) });
    expect(res.status).toBe(401);
  });

  it('answers 502 when Stripe refuses', async () => {
    stripe().intercept({ path: '/v1/billing_portal/sessions', method: 'POST' }).reply(400, { error: { message: 'no configuration' } });
    expect((await send('POST', '/apps/club/billing/portal', 'gh:2', { returnUrl: RETURN })).status).toBe(502);
  });
});

describe('the revenue ledger', () => {
  interface Ledger { purchases: { purchaseId: string; gross: number; refunded: number; fee: number | null; net: number }[]; totals: { currency: string; gross: number; refunded: number; fee: number; net: number }[] }
  const ledger = async () => (await (await get('/apps/club/billing/owner/purchases', 'gh:owner')).json()) as Ledger;

  beforeEach(async () => {
    await purchase('pur_2', 'gh:2');
    await payment('purchase:pur_2', 'pur_2', 2000);
    await ref('pi_1', 'pur_2');
  });

  it('records the fee and the refunds of a purchase, and the owner reads them', async () => {
    expect((await signedPost(chargeEvent('charge.succeeded'))).status).toBe(200);
    expect((await ledger()).purchases[0]).toMatchObject({ gross: 2000, refunded: 0, fee: null, net: 2000 });

    stripe().intercept({ path: '/v1/balance_transactions/txn_1', method: 'GET' }).reply(200, { id: 'txn_1', fee: 88, currency: 'aud' });
    expect(await fillChargeFees(env)).toBe(1);
    expect((await ledger()).purchases[0]).toMatchObject({ gross: 2000, refunded: 0, fee: 88, net: 1912 });

    expect((await signedPost(chargeEvent('charge.refunded', { amount_refunded: 500 }))).status).toBe(200);
    const after = await ledger();
    expect(after.purchases[0]).toMatchObject({ gross: 2000, refunded: 500, fee: 88, net: 1412 });
    expect(after.totals).toEqual([{ currency: 'aud', gross: 2000, refunded: 500, fee: 88, net: 1412 }]);
  });

  it('a replay changes nothing, and a refund total never goes down', async () => {
    const refund = chargeEvent('charge.refunded', { amount_refunded: 800 });
    await signedPost(refund);
    await signedPost(refund);
    await signedPost(chargeEvent('charge.updated', { amount_refunded: 300 }));
    expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM app_billing_charges').first<{ n: number }>())!.n).toBe(1);
    expect((await ledger()).purchases[0]).toMatchObject({ refunded: 800 });
  });

  it('is the same whether the charge or the purchase arrives first', async () => {
    await env.DB.prepare('DELETE FROM app_billing_payment_refs').run();
    await signedPost(chargeEvent('charge.refunded', { amount_refunded: 2000 }));
    expect((await ledger()).purchases[0]).toMatchObject({ refunded: 0 });
    await ref('pi_1', 'pur_2');
    expect((await ledger()).purchases[0]).toMatchObject({ refunded: 2000, net: 0 });
  });

  it('ties a subscription renewal charge through its invoice', async () => {
    await purchase('pur_sub', 'gh:2', { subjects: ['kid-z'] });
    await payment('in:in_7', 'pur_sub', 1500);
    await ref('in_7', 'pur_sub');
    await signedPost(chargeEvent('charge.refunded', { id: 'ch_sub', payment_intent: 'pi_sub', invoice: 'in_7', amount: 1500, amount_refunded: 1500, balance_transaction: null }));
    const row = (await ledger()).purchases.find((p) => p.purchaseId === 'pur_sub');
    expect(row).toMatchObject({ gross: 1500, refunded: 1500 });
  });

  it("never looks up the fee of a charge that is not an app purchase's (a Pro subscription's)", async () => {
    await signedPost(chargeEvent('charge.succeeded', { id: 'ch_pro', payment_intent: 'pi_pro', balance_transaction: 'txn_pro' }));
    expect(await fillChargeFees(env)).toBe(0);
  });

  it('a failed fee lookup leaves the charge for the next tick', async () => {
    await signedPost(chargeEvent('charge.succeeded'));
    stripe().intercept({ path: '/v1/balance_transactions/txn_1', method: 'GET' }).reply(500, { error: {} });
    expect(await fillChargeFees(env)).toBe(0);
    expect((await ledger()).purchases[0]!.fee).toBeNull();
  });

  it('is visible to the owner and a platform admin, and to no one else', async () => {
    expect((await get('/apps/club/billing/owner/purchases', 'gh:owner')).status).toBe(200);
    expect((await get('/apps/club/billing/owner/purchases', 'gh:99', ADMIN)).status).toBe(200);
    expect((await get('/apps/club/billing/owner/purchases', 'gh:2')).status).toBe(403);
    expect((await get('/apps/club/billing/owner/purchases', 'gh:9')).status).toBe(403);
    expect((await get('/apps/club/billing/owner/purchases', null)).status).toBe(401);
    // Another app's ledger is not reachable through this app's id.
    await purchase('pur_o', 'gh:3', { app: 'other' });
    await payment('purchase:pur_o', 'pur_o', 7000);
    expect((await ledger()).purchases.map((p) => p.purchaseId)).toEqual(['pur_2']);
  });

  it('owner products and entitlements are owner-only too', async () => {
    await entitlement('term', 'kid-a', 'gh:2');
    const products = await get('/apps/club/billing/owner/products', 'gh:owner');
    expect(await products.json()).toEqual({ enabled: false, authorizeAction: 'may_buy', products: [] });
    const ents = (await (await get('/apps/club/billing/owner/entitlements?product=term', 'gh:owner')).json()) as { entitlements: { buyerUserId: string }[] };
    expect(ents.entitlements).toMatchObject([{ buyerUserId: 'gh:2' }]);
    expect((await get('/apps/club/billing/owner/products', 'gh:2')).status).toBe(403);
    expect((await get('/apps/club/billing/owner/entitlements', 'gh:2')).status).toBe(403);
  });
});

describe('the enable flag', () => {
  const flag = async () => (await env.DB.prepare("SELECT enabled FROM app_billing WHERE app_id = 'club'").first<{ enabled: number }>())!.enabled;

  it('is off by default, and only a platform admin turns it on or off', async () => {
    expect(await flag()).toBe(0);
    expect((await send('PUT', '/admin/apps/club/billing', 'gh:owner', { enabled: true })).status).toBe(403);
    expect(await flag()).toBe(0);
    const on = await send('PUT', '/admin/apps/club/billing', 'gh:99', { enabled: true }, ADMIN);
    expect(on.status).toBe(200);
    expect(await on.json()).toEqual({ ok: true, enabled: true });
    expect(await flag()).toBe(1);
    expect(await (await get('/admin/apps/club/billing', 'gh:99', ADMIN)).json()).toEqual({ enabled: true, authorizeAction: 'may_buy' });
    expect((await get('/admin/apps/club/billing', 'gh:owner')).status).toBe(403);
    await send('PUT', '/admin/apps/club/billing', 'gh:99', { enabled: false }, ADMIN);
    expect(await flag()).toBe(0);
  });

  it('refuses a malformed body, an unknown app, and an app that declares no billing', async () => {
    expect((await send('PUT', '/admin/apps/club/billing', 'gh:99', { enabled: 'yes' }, ADMIN)).status).toBe(400);
    expect((await send('PUT', '/admin/apps/nope/billing', 'gh:99', { enabled: true }, ADMIN)).status).toBe(404);
    expect((await send('PUT', '/admin/apps/other/billing', 'gh:99', { enabled: true }, ADMIN)).status).toBe(404);
  });

  it('is what checkout answers to: off is 403 "billing is not enabled for this app"', async () => {
    const body = { product: 'term', subjects: ['kid-a'], successUrl: 'https://club.proappstore.online/ok', cancelUrl: 'https://club.proappstore.online/' };
    const res = await send('POST', '/apps/club/billing/checkout', 'gh:2', body);
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toBe('billing is not enabled for this app');
  });
});
