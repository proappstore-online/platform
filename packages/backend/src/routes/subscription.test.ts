import { describe, expect, it, vi } from 'vitest';
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

describe('GET /v1/pricing', () => {
  it('returns null proMonthly when STRIPE_PRO_MONTHLY_PRICE_ID is not set', async () => {
    const res = await app.request('/v1/pricing', {}, makeEnv());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ proMonthly: null });
  });

  it('returns pricing when STRIPE_PRO_MONTHLY_PRICE_ID is configured', async () => {
    const res = await app.request(
      '/v1/pricing',
      {},
      makeEnv({ STRIPE_PRO_MONTHLY_PRICE_ID: 'price_abc123' }),
    );
    expect(res.status).toBe(200);
    const body = await res.json() as { proMonthly: Record<string, unknown> | null };
    expect(body.proMonthly).toEqual({ priceId: 'price_abc123', currency: 'usd', dollars: 9 });
  });

  it('is publicly accessible without auth', async () => {
    // Override fetch to reject — pricing must not touch auth
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('should not call fetch'));
    const res = await app.request('/v1/pricing', {}, makeEnv());
    expect(res.status).toBe(200);
  });
});

describe('GET /v1/subscription', () => {
  it('returns 401 without auth', async () => {
    const res = await app.request(
      '/v1/subscription',
      { headers: { Authorization: 'Bearer bad' } },
      makeEnv(),
    );
    expect(res.status).toBe(401);
  });

  it('returns 404 when no subscription row exists', async () => {
    const subStmt = mockStmt({ first: null });
    const db = mockD1(subStmt);
    const res = await app.request(
      '/v1/subscription',
      { headers: { Authorization: `Bearer ${TOK}` } },
      makeEnv({}, db),
    );
    expect(res.status).toBe(404);
    expect(await res.json()).toBeNull();
  });

  it('returns 404 when subscription status is canceled', async () => {
    const subStmt = mockStmt({
      first: {
        user_id: 'gh:1',
        stripe_customer_id: 'cus_1',
        stripe_subscription_id: 'sub_1',
        status: 'canceled',
        tier: 'pro',
        price_id: 'price_abc',
        current_period_end: Date.now() + 86400000,
        cancel_at_period_end: 0,
      },
    });
    const db = mockD1(subStmt);
    const res = await app.request(
      '/v1/subscription',
      { headers: { Authorization: `Bearer ${TOK}` } },
      makeEnv({}, db),
    );
    expect(res.status).toBe(404);
  });

  it('returns subscription when active', async () => {
    const periodEnd = Date.now() + 86400000;
    const subStmt = mockStmt({
      first: {
        user_id: 'gh:1',
        stripe_customer_id: 'cus_1',
        stripe_subscription_id: 'sub_1',
        status: 'active',
        tier: 'pro',
        price_id: 'price_abc',
        current_period_end: periodEnd,
        cancel_at_period_end: 0,
      },
    });
    const db = mockD1(subStmt);
    const res = await app.request(
      '/v1/subscription',
      { headers: { Authorization: `Bearer ${TOK}` } },
      makeEnv({}, db),
    );
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body.status).toBe('active');
    expect(body.tier).toBe('pro');
    expect(body.priceId).toBe('price_abc');
    expect(body.currentPeriodEnd).toBe(periodEnd);
    expect(body.cancelAtPeriodEnd).toBe(false);
  });

  it('maps cancel_at_period_end integer 1 to boolean true', async () => {
    const subStmt = mockStmt({
      first: {
        user_id: 'gh:1',
        stripe_customer_id: 'cus_1',
        stripe_subscription_id: 'sub_1',
        status: 'active',
        tier: 'pro',
        price_id: 'price_abc',
        current_period_end: Date.now() + 86400000,
        cancel_at_period_end: 1,
      },
    });
    const db = mockD1(subStmt);
    const res = await app.request(
      '/v1/subscription',
      { headers: { Authorization: `Bearer ${TOK}` } },
      makeEnv({}, db),
    );
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body.cancelAtPeriodEnd).toBe(true);
  });
});

describe('POST /v1/checkout', () => {
  it('returns 401 without auth', async () => {
    const res = await app.request(
      '/v1/checkout',
      {
        method: 'POST',
        headers: { Authorization: 'Bearer bad', 'Content-Type': 'application/json' },
        body: JSON.stringify({
          priceId: 'price_abc',
          successUrl: 'https://proappstore.online/success',
          cancelUrl: 'https://proappstore.online/cancel',
        }),
      },
      makeEnv(),
    );
    expect(res.status).toBe(401);
  });

  it('returns 400 when required fields are missing', async () => {
    const res = await app.request(
      '/v1/checkout',
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${TOK}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ priceId: 'price_abc' }),
      },
      makeEnv(),
    );
    expect(res.status).toBe(400);
  });

  it('creates checkout session using existing Stripe customer and returns url', async () => {
    const stripeMock = vi.fn().mockImplementation((url: string) => {
      if (url.includes('stripe.com/v1/checkout/sessions')) {
        return Promise.resolve(
          new Response(JSON.stringify({ id: 'cs_1', url: 'https://checkout.stripe.com/pay/cs_1' }), { status: 200 }),
        );
      }
      return Promise.resolve(new Response('{}', { status: 200 }));
    });
    globalThis.fetch = vi.fn().mockImplementation((url: string) => stripeMock(url));

    // Return existing customer row
    const subStmt = mockStmt({ first: { stripe_customer_id: 'cus_existing' } });
    const db = mockD1(subStmt);
    const res = await app.request(
      '/v1/checkout',
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${TOK}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          priceId: 'price_abc',
          successUrl: 'https://proappstore.online/success',
          cancelUrl: 'https://proappstore.online/cancel',
        }),
      },
      makeEnv({}, db),
    );
    expect(res.status).toBe(200);
    const body = await res.json() as { url: string };
    expect(body.url).toBe('https://checkout.stripe.com/pay/cs_1');
  });

  it('creates a new Stripe customer when no subscription row exists, then creates checkout session', async () => {
    const stripeMock = vi.fn().mockImplementation((url: string) => {
      if (url.includes('stripe.com/v1/customers')) {
        return Promise.resolve(
          new Response(JSON.stringify({ id: 'cus_new' }), { status: 200 }),
        );
      }
      if (url.includes('stripe.com/v1/checkout/sessions')) {
        return Promise.resolve(
          new Response(JSON.stringify({ id: 'cs_2', url: 'https://checkout.stripe.com/pay/cs_2' }), { status: 200 }),
        );
      }
      return Promise.resolve(new Response('{}', { status: 200 }));
    });
    globalThis.fetch = vi.fn().mockImplementation((url: string) => stripeMock(url));

    // No existing customer
    const subStmt = mockStmt({ first: null });
    const upsertStmt = mockStmt();
    const db = mockD1(subStmt, upsertStmt);
    const res = await app.request(
      '/v1/checkout',
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${TOK}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          priceId: 'price_abc',
          successUrl: 'https://proappstore.online/success',
          cancelUrl: 'https://proappstore.online/cancel',
        }),
      },
      makeEnv({}, db),
    );
    expect(res.status).toBe(200);
    const body = await res.json() as { url: string };
    expect(body.url).toBe('https://checkout.stripe.com/pay/cs_2');
    // Customer creation was called
    expect(stripeMock).toHaveBeenCalledWith(expect.stringContaining('stripe.com/v1/customers'));
  });
});

describe('POST /v1/portal', () => {
  it('returns 401 without auth', async () => {
    const res = await app.request(
      '/v1/portal',
      {
        method: 'POST',
        headers: { Authorization: 'Bearer bad', 'Content-Type': 'application/json' },
        body: JSON.stringify({ returnUrl: 'https://proappstore.online' }),
      },
      makeEnv(),
    );
    expect(res.status).toBe(401);
  });

  it('returns 400 when returnUrl is missing', async () => {
    const res = await app.request(
      '/v1/portal',
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${TOK}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      },
      makeEnv(),
    );
    expect(res.status).toBe(400);
  });

  it('returns 404 when user has no Stripe customer', async () => {
    const subStmt = mockStmt({ first: null });
    const db = mockD1(subStmt);
    const res = await app.request(
      '/v1/portal',
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${TOK}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ returnUrl: 'https://proappstore.online' }),
      },
      makeEnv({}, db),
    );
    expect(res.status).toBe(404);
  });

  it('returns billing portal url when customer exists', async () => {
    const stripeMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({ url: 'https://billing.stripe.com/session/bps_1' }),
        { status: 200 },
      ),
    );
    globalThis.fetch = vi.fn().mockImplementation((url: string) => stripeMock(url));

    const subStmt = mockStmt({ first: { stripe_customer_id: 'cus_abc' } });
    const db = mockD1(subStmt);
    const res = await app.request(
      '/v1/portal',
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${TOK}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ returnUrl: 'https://proappstore.online/account' }),
      },
      makeEnv({}, db),
    );
    expect(res.status).toBe(200);
    const body = await res.json() as { url: string };
    expect(body.url).toBe('https://billing.stripe.com/session/bps_1');
    expect(stripeMock).toHaveBeenCalledWith(
      expect.stringContaining('stripe.com/v1/billing_portal/sessions'),
    );
  });
});
