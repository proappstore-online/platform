import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { app } from '../index.js';
import { verifyWebhookSignature } from '../lib/stripe.js';
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

beforeEach(() => {
  globalThis.fetch = vi.fn().mockResolvedValue(
    new Response(
      JSON.stringify({ id: 'gh:1', login: 'tester', avatarUrl: null, roles: ['user'], appRoles: {} }),
      { status: 200 },
    ),
  );
});
/** Build a valid Stripe-style signature header for the given payload and secret. */
async function buildStripeSignature(payload: string, secret: string, timestamp?: number): Promise<string> {
  const ts = timestamp ?? Math.floor(Date.now() / 1000);
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

// --- Unit tests for verifyWebhookSignature ---

describe('verifyWebhookSignature', () => {
  it('returns true for a correct HMAC-SHA256 signature', async () => {
    const secret = 'whsec_testsecret';
    const payload = JSON.stringify({ type: 'checkout.session.completed', data: { object: {} } });
    const signature = await buildStripeSignature(payload, secret);

    const result = await verifyWebhookSignature(payload, signature, secret);
    expect(result).toBe(true);
  });

  it('returns false for a wrong signature value', async () => {
    const secret = 'whsec_testsecret';
    const payload = JSON.stringify({ type: 'test', data: { object: {} } });
    const ts = Math.floor(Date.now() / 1000);
    const badSig = `t=${ts},v1=${'0'.repeat(64)}`;

    const result = await verifyWebhookSignature(payload, badSig, secret);
    expect(result).toBe(false);
  });

  it('returns false when signature header is missing timestamp', async () => {
    const result = await verifyWebhookSignature('payload', 'v1=abc123', 'secret');
    expect(result).toBe(false);
  });

  it('returns false when signature header has no v1 part', async () => {
    const result = await verifyWebhookSignature('payload', 't=1234567890', 'secret');
    expect(result).toBe(false);
  });

  it('returns false for an entirely empty signature string', async () => {
    const result = await verifyWebhookSignature('payload', '', 'secret');
    expect(result).toBe(false);
  });

  it('returns false when the payload has been tampered with', async () => {
    const secret = 'whsec_testsecret';
    const original = JSON.stringify({ type: 'checkout.session.completed', data: { object: {} } });
    const tampered = JSON.stringify({ type: 'checkout.session.completed', data: { object: { injected: true } } });
    const signature = await buildStripeSignature(original, secret);

    const result = await verifyWebhookSignature(tampered, signature, secret);
    expect(result).toBe(false);
  });

  it('returns false when wrong secret is used to verify', async () => {
    const correctSecret = 'whsec_correct';
    const wrongSecret = 'whsec_wrong';
    const payload = JSON.stringify({ type: 'test', data: { object: {} } });
    const signature = await buildStripeSignature(payload, correctSecret);

    const result = await verifyWebhookSignature(payload, signature, wrongSecret);
    expect(result).toBe(false);
  });

  it('timing-safe: signatures of different length return false without short-circuit', async () => {
    // sig.length !== expected.length must return false (not throw or panic)
    const secret = 'whsec_test';
    const payload = 'body';
    const ts = Math.floor(Date.now() / 1000);
    // Signature that is shorter than 64 hex chars
    const shortSig = `t=${ts},v1=deadbeef`;

    const result = await verifyWebhookSignature(payload, shortSig, secret);
    expect(result).toBe(false);
  });

  it('accepts signature when multiple v1 values are present and one matches', async () => {
    const secret = 'whsec_rollover';
    const payload = JSON.stringify({ type: 'invoice.payment_failed', data: { object: {} } });
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
    const correctSig = Array.from(new Uint8Array(sigBytes))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');

    // Stripe sends multiple v1 during key rotation
    const multiSig = `t=${ts},v1=${'0'.repeat(64)},v1=${correctSig}`;
    const result = await verifyWebhookSignature(payload, multiSig, secret);
    expect(result).toBe(true);
  });
});

// --- Integration tests for POST /webhooks/stripe ---

describe('POST /webhooks/stripe', () => {
  it('returns 400 when stripe-signature header is missing', async () => {
    const payload = JSON.stringify({ type: 'test', data: { object: {} } });
    const res = await app.request(
      '/webhooks/stripe',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: payload,
      },
      makeEnv(),
    );
    expect(res.status).toBe(400);
    expect(await res.text()).toContain('missing stripe-signature');
  });

  it('returns 401 when stripe-signature is wrong', async () => {
    const payload = JSON.stringify({ type: 'test', data: { object: {} } });
    const ts = Math.floor(Date.now() / 1000);
    const res = await app.request(
      '/webhooks/stripe',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'stripe-signature': `t=${ts},v1=${'0'.repeat(64)}`,
        },
        body: payload,
      },
      makeEnv(),
    );
    expect(res.status).toBe(401);
    expect(await res.text()).toContain('invalid signature');
  });

  it('returns 200 and {received:true} for a correctly signed payload', async () => {
    const payload = JSON.stringify({ type: 'checkout.session.completed', data: { object: {} } });
    const signature = await buildStripeSignature(payload, 'whsec_test');

    const res = await app.request(
      '/webhooks/stripe',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'stripe-signature': signature,
        },
        body: payload,
      },
      makeEnv(),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ received: true });
  });

  it('handles checkout.session.completed and upserts subscription', async () => {
    const payload = JSON.stringify({
      type: 'checkout.session.completed',
      data: {
        object: {
          metadata: { user_id: 'gh:42' },
          customer: 'cus_test123',
          subscription: 'sub_test456',
        },
      },
    });
    const signature = await buildStripeSignature(payload, 'whsec_test');
    const upsertStmt = mockStmt({ run: { meta: { changes: 1 } } });
    const db = mockD1(upsertStmt);

    const res = await app.request(
      '/webhooks/stripe',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'stripe-signature': signature,
        },
        body: payload,
      },
      makeEnv({}, db),
    );
    expect(res.status).toBe(200);
    expect(db.prepare).toHaveBeenCalledTimes(1);
    const sql = db.prepare.mock.calls[0][0] as string;
    expect(sql).toContain('INSERT INTO subscriptions');
    expect(sql).toContain('ON CONFLICT');
    expect(upsertStmt.bind).toHaveBeenCalledWith(
      'gh:42',
      'cus_test123',
      'sub_test456',
      expect.any(Number),
      expect.any(Number),
    );
  });

  it('handles customer.subscription.deleted and marks canceled', async () => {
    const payload = JSON.stringify({
      type: 'customer.subscription.deleted',
      data: {
        object: { id: 'sub_cancel999' },
      },
    });
    const signature = await buildStripeSignature(payload, 'whsec_test');
    const updateStmt = mockStmt({ run: { meta: { changes: 1 } } });
    const db = mockD1(updateStmt);

    const res = await app.request(
      '/webhooks/stripe',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'stripe-signature': signature,
        },
        body: payload,
      },
      makeEnv({}, db),
    );
    expect(res.status).toBe(200);
    const sql = db.prepare.mock.calls[0][0] as string;
    expect(sql).toContain("status = 'canceled'");
    expect(sql).toContain("tier = 'free'");
    expect(updateStmt.bind).toHaveBeenCalledWith(expect.any(Number), 'sub_cancel999');
  });

  it('handles invoice.payment_failed and marks past_due', async () => {
    const payload = JSON.stringify({
      type: 'invoice.payment_failed',
      data: {
        object: { subscription: 'sub_overdue77' },
      },
    });
    const signature = await buildStripeSignature(payload, 'whsec_test');
    const updateStmt = mockStmt({ run: { meta: { changes: 1 } } });
    const db = mockD1(updateStmt);

    const res = await app.request(
      '/webhooks/stripe',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'stripe-signature': signature,
        },
        body: payload,
      },
      makeEnv({}, db),
    );
    expect(res.status).toBe(200);
    const sql = db.prepare.mock.calls[0][0] as string;
    expect(sql).toContain("status = 'past_due'");
    expect(updateStmt.bind).toHaveBeenCalledWith(expect.any(Number), 'sub_overdue77');
  });

  it('returns 200 for unknown event types without touching DB', async () => {
    const payload = JSON.stringify({
      type: 'some.unknown.event',
      data: { object: {} },
    });
    const signature = await buildStripeSignature(payload, 'whsec_test');
    const db = mockD1();

    const res = await app.request(
      '/webhooks/stripe',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'stripe-signature': signature,
        },
        body: payload,
      },
      makeEnv({}, db),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ received: true });
    expect(db.prepare).not.toHaveBeenCalled();
  });
});
