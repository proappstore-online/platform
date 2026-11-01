/**
 * Tests for webhook.ts — the Stripe webhook handler.
 *
 * The core signature-verification unit tests and the primary event handlers
 * (checkout.session.completed, customer.subscription.deleted,
 * invoice.payment_failed, unknown events) are covered by stripe.test.ts.
 *
 * This file covers the remaining untested event: customer.subscription.updated.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { app } from '../index.js';
import { testToken, TEST_SK, mockStmt, mockD1, makeEnv } from '../test-helpers.js';
import { sqliteD1 } from '../sqlite-d1.js';

const TOK = await testToken('gh:1');

async function buildStripeSignature(payload: string, secret: string): Promise<string> {
  const ts = Math.floor(Date.now() / 1000);
  const signedPayload = `${ts}.${payload}`;
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sigBytes = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(signedPayload));
  const sig = Array.from(new Uint8Array(sigBytes))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  return `t=${ts},v1=${sig}`;
}

beforeEach(() => {
  globalThis.fetch = vi.fn().mockResolvedValue(
    new Response(JSON.stringify({ id: 'gh:1', login: 'tester', avatarUrl: null, roles: ['user'], appRoles: {} }), { status: 200 }),
  );
});
describe('POST /webhooks/stripe — customer.subscription.updated', () => {
  it('updates status, price_id, and period end in DB', async () => {
    const futureTs = Math.floor(Date.now() / 1000) + 86400; // 1 day from now (Unix seconds)
    const payload = JSON.stringify({
      type: 'customer.subscription.updated',
      data: {
        object: {
          id: 'sub_updated123',
          status: 'active',
          cancel_at_period_end: false,
          current_period_end: futureTs,
          items: { data: [{ price: { id: 'price_pro_monthly' } }] },
        },
      },
    });
    const signature = await buildStripeSignature(payload, 'whsec_test');
    const updateStmt = mockStmt({ run: { meta: { changes: 1 } } });
    const db = mockD1(updateStmt);

    const res = await app.request('/webhooks/stripe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'stripe-signature': signature },
      body: payload,
    }, makeEnv({}, db));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ received: true });
    const sql = db.prepare.mock.calls[0][0] as string;
    expect(sql).toContain('UPDATE subscriptions');
    expect(sql).toContain('status = ?');
    expect(updateStmt.bind).toHaveBeenCalledWith(
      'active',
      'price_pro_monthly',
      futureTs * 1000, // converted to ms
      0, // cancel_at_period_end false → 0
      expect.any(Number),
      'sub_updated123',
    );
  });

  it("guards on status != 'canceled' so a late event can't resurrect a canceled sub", async () => {
    const payload = JSON.stringify({
      type: 'customer.subscription.updated',
      data: {
        object: {
          id: 'sub_zombie',
          status: 'active',
          cancel_at_period_end: false,
          current_period_end: Math.floor(Date.now() / 1000) + 86400,
          items: { data: [] },
        },
      },
    });
    const signature = await buildStripeSignature(payload, 'whsec_test');
    const updateStmt = mockStmt({ run: { meta: { changes: 0 } } });
    const db = mockD1(updateStmt);

    const res = await app.request('/webhooks/stripe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'stripe-signature': signature },
      body: payload,
    }, makeEnv({}, db));

    expect(res.status).toBe(200);
    const sql = db.prepare.mock.calls[0][0] as string;
    expect(sql).toContain("status != 'canceled'"); // terminal-cancel guard
  });

  it('sets cancel_at_period_end=1 when subscription will cancel', async () => {
    const futureTs = Math.floor(Date.now() / 1000) + 86400;
    const payload = JSON.stringify({
      type: 'customer.subscription.updated',
      data: {
        object: {
          id: 'sub_canceling',
          status: 'active',
          cancel_at_period_end: true,
          current_period_end: futureTs,
          items: { data: [] },
        },
      },
    });
    const signature = await buildStripeSignature(payload, 'whsec_test');
    const updateStmt = mockStmt({ run: { meta: { changes: 1 } } });
    const db = mockD1(updateStmt);

    const res = await app.request('/webhooks/stripe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'stripe-signature': signature },
      body: payload,
    }, makeEnv({}, db));

    expect(res.status).toBe(200);
    expect(updateStmt.bind).toHaveBeenCalledWith(
      'active',
      null, // no price_id (empty items.data)
      futureTs * 1000,
      1, // cancel_at_period_end true → 1
      expect.any(Number),
      'sub_canceling',
    );
  });
});

// #519: the webhook route serves both Stripe identities on one URL. Whichever secret verifies decides the event's
// env, Stripe's own `livemode` must then agree, and a test-mode event can never reach the Pro subscription switch
// or mutate a purchase made under the other env. Real SQL on in-memory SQLite (app-billing-handler.test.ts covers
// the fact/entitlement pipeline directly; this covers the HTTP route's own env resolution).

const LIVE_SECRET = 'whsec_test';
const TEST_SECRET = 'whsec_test_mode';

let envDb: ReturnType<typeof sqliteD1>;
let envVars: ReturnType<typeof makeEnv>;

beforeEach(() => {
  envDb = sqliteD1();
  envVars = makeEnv({ DB: envDb, STRIPE_WEBHOOK_SECRET: LIVE_SECRET, STRIPE_TEST_WEBHOOK_SECRET: TEST_SECRET });
});

async function sign(payload: string, secret: string): Promise<string> {
  const t = Math.floor(Date.now() / 1000);
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${t}.${payload}`)));
  const hex = [...mac].map((b) => b.toString(16).padStart(2, '0')).join('');
  return `t=${t},v1=${hex}`;
}

async function post(event: Record<string, unknown>, secret: string): Promise<Response> {
  const body = JSON.stringify(event);
  return app.request('/webhooks/stripe', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'stripe-signature': await sign(body, secret) }, body,
  }, envVars as never);
}

let n = 0;
const ours = (app_id = 'club', purchase_id = 'pur_1') => ({ app_id, user_id: 'gh:2', purchase_id });
/** `objectOver` merges into the Stripe object (data.object); `eventOver` merges into the event envelope itself
 *  (e.g. `livemode`, which Stripe sends alongside `id`/`type`/`created`, not inside the object). */
const checkoutEvent = (objectOver: Record<string, unknown> = {}, eventOver: Record<string, unknown> = {}) => ({
  id: `evt_${++n}`, type: 'checkout.session.completed', created: Math.floor(Date.now() / 1000),
  data: { object: { id: 'cs_1', mode: 'payment', payment_status: 'paid', amount_total: 1000, currency: 'aud', payment_intent: 'pi_1', metadata: ours(), ...objectOver } },
  ...eventOver,
});
const proEvent = (eventOver: Record<string, unknown> = {}) => ({
  id: `evt_${++n}`, type: 'checkout.session.completed', created: Math.floor(Date.now() / 1000),
  data: { object: { id: 'cs_pro', mode: 'subscription', metadata: { user_id: 'gh:9' }, customer: 'cus_9', subscription: 'sub_9' } },
  ...eventOver,
});

async function seedPurchase(id: string, stripeEnv: 'live' | 'test', appId = 'club') {
  await envDb.prepare(
    `INSERT INTO app_purchases (id, app_id, product_key, buyer_user_id, subjects, quantity, mode, status, stripe_env, created_at, updated_at)
     VALUES (?, ?, 'term', 'gh:2', '["kid"]', 1, 'one_time', 'pending', ?, 1, 1)`,
  ).bind(id, appId, stripeEnv).run();
}
const entitlementCount = async () => (await envDb.prepare('SELECT COUNT(*) AS n FROM app_entitlements').first<{ n: number }>())!.n;

describe('signature verification resolves the env (#519)', () => {
  it('a live-signed event with no test secret configured behaves exactly as before', async () => {
    envVars.STRIPE_TEST_WEBHOOK_SECRET = undefined;
    await seedPurchase('pur_1', 'live');
    expect((await post(checkoutEvent(), LIVE_SECRET)).status).toBe(200);
    expect(await entitlementCount()).toBe(1);
  });

  it('a test-signed event is accepted and processed when a test purchase matches it', async () => {
    await seedPurchase('pur_1', 'test');
    const res = await post(checkoutEvent(), TEST_SECRET);
    expect(res.status).toBe(200);
    expect(await entitlementCount()).toBe(1);
    expect((await envDb.prepare("SELECT stripe_env FROM app_entitlements").first<{ stripe_env: string }>())!.stripe_env).toBe('test');
  });

  it('is 401 when neither secret verifies the signature', async () => {
    await seedPurchase('pur_1', 'live');
    expect((await post(checkoutEvent(), 'whsec_wrong')).status).toBe(401);
    expect(await entitlementCount()).toBe(0);
  });

  it('is 401 without a test secret configured, even if the payload happens to verify against it elsewhere', async () => {
    envVars.STRIPE_TEST_WEBHOOK_SECRET = undefined;
    await seedPurchase('pur_1', 'test');
    expect((await post(checkoutEvent(), TEST_SECRET)).status).toBe(401);
  });
});

describe('livemode must agree with the verifying secret (#519)', () => {
  it('rejects a live-signed event that claims livemode: false', async () => {
    await seedPurchase('pur_1', 'live');
    const res = await post(checkoutEvent({}, { livemode: false }), LIVE_SECRET);
    expect(res.status).toBe(401);
    expect(await entitlementCount()).toBe(0);
  });

  it('rejects a test-signed event that claims livemode: true', async () => {
    await seedPurchase('pur_1', 'test');
    const res = await post(checkoutEvent({}, { livemode: true }), TEST_SECRET);
    expect(res.status).toBe(401);
    expect(await entitlementCount()).toBe(0);
  });

  it('accepts events whose livemode agrees with the secret', async () => {
    await seedPurchase('pur_1', 'live');
    expect((await post(checkoutEvent({}, { livemode: true }), LIVE_SECRET)).status).toBe(200);
  });
});

describe('a test-mode event can never reach the Pro subscription handler or a live purchase (#519)', () => {
  it('a test-signed event with none of our app metadata is dropped, not applied as a Pro upgrade', async () => {
    const res = await post(proEvent(), TEST_SECRET);
    expect(res.status).toBe(200);
    expect((await envDb.prepare('SELECT COUNT(*) AS n FROM subscriptions').first<{ n: number }>())!.n).toBe(0);
  });

  it('the same event signed live IS applied as a Pro upgrade (sanity: the drop above is env-specific, not a general bug)', async () => {
    const res = await post(proEvent(), LIVE_SECRET);
    expect(res.status).toBe(200);
    expect((await envDb.prepare('SELECT COUNT(*) AS n FROM subscriptions').first<{ n: number }>())!.n).toBe(1);
  });

  it("a test-signed event naming a purchase that was bought LIVE is ignored, not applied to it", async () => {
    await seedPurchase('pur_1', 'live');
    const res = await post(checkoutEvent(), TEST_SECRET);
    expect(res.status).toBe(200); // acknowledged so Stripe does not redeliver forever
    expect(await entitlementCount()).toBe(0); // but never applied: the purchase's own env did not match the secret
  });
});
