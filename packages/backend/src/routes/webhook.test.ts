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
import { testToken, TEST_SK } from '../test-helpers.js';

const TOK = await testToken('gh:1');

function mockStmt(opts: { first?: unknown; all?: unknown; run?: unknown } = {}) {
  return {
    bind: vi.fn().mockReturnThis(),
    first: vi.fn().mockResolvedValue(opts.first ?? null),
    all: vi.fn().mockResolvedValue(opts.all ?? { results: [] }),
    run: vi.fn().mockResolvedValue(opts.run ?? { meta: { changes: 0 } }),
  };
}

function mockD1(...stmts: ReturnType<typeof mockStmt>[]) {
  const prepare = vi.fn();
  for (const stmt of stmts) prepare.mockReturnValueOnce(stmt);
  prepare.mockReturnValue(mockStmt());
  return { prepare };
}

function makeEnv(overrides: Record<string, unknown> = {}, db?: ReturnType<typeof mockD1>) {
  return {
    DB: (db ?? mockD1()) as unknown as D1Database,
    STORAGE: {} as R2Bucket,
    STRIPE_SECRET_KEY: 'sk_test',
    STRIPE_WEBHOOK_SECRET: 'whsec_test',
    SESSION_SIGNING_KEY: TEST_SK,
    CF_API_TOKEN: 'cf_tok',
    CF_ACCOUNT_ID: 'cf_acct',
    VAPID_PUBLIC_KEY: 'test-vapid-public',
    VAPID_PRIVATE_KEY: 'test-vapid-private',
    ...overrides,
  };
}

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
