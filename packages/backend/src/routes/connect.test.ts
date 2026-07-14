import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { app } from '../index.js';
import { testToken, TEST_SK, mockStmt, mockD1, makeEnv as sharedMakeEnv } from '../test-helpers.js';

const TOK = await testToken('gh:1');

function makeEnv(db?: ReturnType<typeof mockD1>, overrides: { stripeKey?: string | null } = {}) {
  return sharedMakeEnv(
    {
      STRIPE_SECRET_KEY: overrides.stripeKey === undefined ? 'sk_test' : (overrides.stripeKey ?? ''),
      VAPID_PUBLIC_KEY: 'p',
      VAPID_PRIVATE_KEY: 'q',
    },
    db,
  );
}

const originalFetch = globalThis.fetch;
function mockStripe(stripeResponses: Response[]) {
  let idx = 0;
  globalThis.fetch = vi.fn().mockImplementation(() => {
    const next = stripeResponses[idx++];
    if (!next) return Promise.resolve(new Response('{}', { status: 200 }));
    return Promise.resolve(next);
  }) as unknown as typeof fetch;
}
afterEach(() => { globalThis.fetch = originalFetch; });

describe('POST /v1/connect/onboard', () => {
  it('creates a Stripe Express account on first call and stores it', async () => {
    mockStripe([
      new Response(JSON.stringify({ id: 'acct_test_1', country: 'US' }), { status: 200 }),
      new Response(JSON.stringify({ url: 'https://connect.stripe.com/setup/x', expires_at: 1 }), { status: 200 }),
    ]);
    const existingRow = mockStmt({ first: null });
    const insert = mockStmt();
    const db = mockD1(existingRow, insert);

    const res = await app.request(
      '/v1/connect/onboard',
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${TOK}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          returnUrl: 'https://console.proappstore.online/?ret=ok',
          refreshUrl: 'https://console.proappstore.online/?retry=1',
        }),
      },
      makeEnv(db),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { url: string; stripeAccountId: string };
    expect(body.url).toContain('connect.stripe.com');
    expect(body.stripeAccountId).toBe('acct_test_1');
  });

  it('reuses the existing Stripe account on subsequent calls', async () => {
    mockStripe([
      // No /v1/accounts call expected — reuses row. Only /v1/account_links.
      new Response(JSON.stringify({ url: 'https://connect.stripe.com/setup/y', expires_at: 1 }), { status: 200 }),
    ]);
    const existing = mockStmt({
      first: {
        creator_id: 'gh:1',
        stripe_connect_account_id: 'acct_test_existing',
        charges_enabled: 0,
        payouts_enabled: 0,
        details_submitted: 0,
        country: 'US',
        created_at: 1,
        updated_at: 1,
      },
    });
    const db = mockD1(existing);

    const res = await app.request(
      '/v1/connect/onboard',
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${TOK}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          returnUrl: 'https://console.proappstore.online/?ret=ok',
          refreshUrl: 'https://console.proappstore.online/?retry=1',
        }),
      },
      makeEnv(db),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { stripeAccountId: string };
    expect(body.stripeAccountId).toBe('acct_test_existing');
  });

  it('rejects missing returnUrl / refreshUrl', async () => {
    const db = mockD1();
    const res = await app.request(
      '/v1/connect/onboard',
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${TOK}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      },
      makeEnv(db),
    );
    expect(res.status).toBe(400);
    expect(await res.text()).toMatch(/returnUrl.*refreshUrl/);
  });

  it('returns 503 when STRIPE_SECRET_KEY is not configured', async () => {
    const db = mockD1();
    const res = await app.request(
      '/v1/connect/onboard',
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${TOK}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          returnUrl: 'https://x/',
          refreshUrl: 'https://x/',
        }),
      },
      makeEnv(db, { stripeKey: '' }),
    );
    expect(res.status).toBe(503);
  });
});

describe('GET /v1/connect/status', () => {
  it('returns connected:false when no row exists', async () => {
    const noRow = mockStmt({ first: null });
    const db = mockD1(noRow);
    const res = await app.request(
      '/v1/connect/status',
      { headers: { Authorization: `Bearer ${TOK}` } },
      makeEnv(db),
    );
    expect(res.status).toBe(200);
    expect((await res.json()) as { connected: boolean }).toEqual({ connected: false });
  });

  it('refreshes the cached flags from Stripe and updates the row', async () => {
    mockStripe([
      // Stripe GET /v1/accounts/:id
      new Response(
        JSON.stringify({
          id: 'acct_t',
          country: 'US',
          charges_enabled: true,
          payouts_enabled: true,
          details_submitted: true,
        }),
        { status: 200 },
      ),
    ]);
    const existing = mockStmt({
      first: {
        creator_id: 'gh:1',
        stripe_connect_account_id: 'acct_t',
        charges_enabled: 0,
        payouts_enabled: 0,
        details_submitted: 0,
        country: 'US',
        created_at: 1,
        updated_at: 1,
      },
    });
    const update = mockStmt();
    const db = mockD1(existing, update);

    const res = await app.request(
      '/v1/connect/status',
      { headers: { Authorization: `Bearer ${TOK}` } },
      makeEnv(db),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      connected: boolean;
      chargesEnabled: boolean;
      payoutsEnabled: boolean;
      detailsSubmitted: boolean;
      needsAction: boolean;
    };
    expect(body.connected).toBe(true);
    expect(body.chargesEnabled).toBe(true);
    expect(body.payoutsEnabled).toBe(true);
    expect(body.detailsSubmitted).toBe(true);
    expect(body.needsAction).toBe(false);
  });

  it('falls back to cached row when Stripe call fails', async () => {
    mockStripe([new Response('boom', { status: 500 })]);
    const cached = mockStmt({
      first: {
        creator_id: 'gh:1',
        stripe_connect_account_id: 'acct_t',
        charges_enabled: 1,
        payouts_enabled: 0,
        details_submitted: 0,
        country: 'US',
        created_at: 1,
        updated_at: 1,
      },
    });
    const db = mockD1(cached);
    const res = await app.request(
      '/v1/connect/status',
      { headers: { Authorization: `Bearer ${TOK}` } },
      makeEnv(db),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { connected: boolean; chargesEnabled: boolean; needsAction: boolean };
    expect(body.connected).toBe(true);
    expect(body.chargesEnabled).toBe(true);
    expect(body.needsAction).toBe(true);
  });
});
