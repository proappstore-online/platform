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
  return { prepare, batch: vi.fn().mockResolvedValue([{ meta: { changes: 1 } }]) };
}

function env(overrides: Record<string, unknown> = {}, db?: ReturnType<typeof mockD1>) {
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
    AI: { run: vi.fn() },
    INTERNAL_TOKEN: 'secret-cron-token',
    ...overrides,
  };
}

describe('POST /v1/internal/payouts/run', () => {
  it('returns 403 without INTERNAL_TOKEN', async () => {
    const res = await app.request('/v1/internal/payouts/run', {
      method: 'POST',
    }, env());
    expect(res.status).toBe(403);
  });

  it('returns 403 with wrong token', async () => {
    const res = await app.request('/v1/internal/payouts/run', {
      method: 'POST',
      headers: { 'X-Internal-Token': 'wrong-token' },
    }, env());
    expect(res.status).toBe(403);
  });

  it('returns 403 when INTERNAL_TOKEN is not set', async () => {
    const res = await app.request('/v1/internal/payouts/run', {
      method: 'POST',
      headers: { 'X-Internal-Token': 'anything' },
    }, env({ INTERNAL_TOKEN: undefined }));
    expect(res.status).toBe(403);
  });

  it('returns 503 when Stripe is not configured', async () => {
    const res = await app.request('/v1/internal/payouts/run', {
      method: 'POST',
      headers: { 'X-Internal-Token': 'secret-cron-token' },
    }, env({ STRIPE_SECRET_KEY: '' }));
    expect(res.status).toBe(503);
  });

  it('returns empty summary when no unpaid engagements', async () => {
    const db = mockD1(
      mockStmt({ all: { results: [] } }), // unpaid query returns nothing
    );
    const res = await app.request('/v1/internal/payouts/run', {
      method: 'POST',
      headers: { 'X-Internal-Token': 'secret-cron-token' },
    }, env({}, db));
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body.summary).toEqual({
      totalTransferred: 0,
      totalAmountCents: 0,
      totalSkipped: 0,
      totalFailed: 0,
    });
  });

  it('skips developers without Connect account', async () => {
    const db = mockD1(
      // 1. Unpaid aggregation query
      mockStmt({ all: { results: [{ developer_id: 'gh:10', total_cents: 5000, eng_count: 3 }] } }),
      // 2. creator_payouts lookup -> null (no connect account)
      mockStmt({ first: null }),
    );
    const res = await app.request('/v1/internal/payouts/run', {
      method: 'POST',
      headers: { 'X-Internal-Token': 'secret-cron-token' },
    }, env({}, db));
    expect(res.status).toBe(200);
    const body = await res.json() as { skipped: { developerId: string; reason: string }[]; summary: Record<string, number> };
    expect(body.skipped).toHaveLength(1);
    expect(body.skipped[0].reason).toContain('no Stripe Connect');
    expect(body.summary.totalTransferred).toBe(0);
  });

  it('skips developers with payouts not enabled', async () => {
    const db = mockD1(
      mockStmt({ all: { results: [{ developer_id: 'gh:10', total_cents: 5000, eng_count: 2 }] } }),
      mockStmt({ first: { stripe_connect_account_id: 'acct_123', payouts_enabled: 0 } }),
    );
    const res = await app.request('/v1/internal/payouts/run', {
      method: 'POST',
      headers: { 'X-Internal-Token': 'secret-cron-token' },
    }, env({}, db));
    expect(res.status).toBe(200);
    const body = await res.json() as { skipped: { developerId: string; reason: string }[] };
    expect(body.skipped).toHaveLength(1);
    expect(body.skipped[0].reason).toContain('payouts not enabled');
  });

  it('skips developers already paid this month', async () => {
    const db = mockD1(
      mockStmt({ all: { results: [{ developer_id: 'gh:10', total_cents: 5000, eng_count: 2 }] } }),
      mockStmt({ first: { stripe_connect_account_id: 'acct_123', payouts_enabled: 1 } }),
      // idempotency check: already has a payout record
      mockStmt({ first: { id: 'existing-payout-id' } }),
    );
    const res = await app.request('/v1/internal/payouts/run', {
      method: 'POST',
      headers: { 'X-Internal-Token': 'secret-cron-token' },
    }, env({}, db));
    expect(res.status).toBe(200);
    const body = await res.json() as { skipped: { developerId: string; reason: string }[] };
    expect(body.skipped).toHaveLength(1);
    expect(body.skipped[0].reason).toContain('already paid');
  });

  it('succeeds for a valid developer and records the payout', async () => {
    const db = mockD1(
      mockStmt({ all: { results: [{ developer_id: 'gh:10', total_cents: 4500, eng_count: 3 }] } }),
      mockStmt({ first: { stripe_connect_account_id: 'acct_abc', payouts_enabled: 1 } }),
      mockStmt({ first: null }), // idempotency check: no existing payout
    );

    // Mock the Stripe Transfer API call
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ id: 'tr_mock_123', amount: 4500, currency: 'usd', destination: 'acct_abc' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    const res = await app.request('/v1/internal/payouts/run', {
      method: 'POST',
      headers: { 'X-Internal-Token': 'secret-cron-token' },
    }, env({}, db));
    expect(res.status).toBe(200);
    const body = await res.json() as {
      succeeded: { developerId: string; amountCents: number; stripeTransferId: string }[];
      summary: Record<string, number>;
    };
    expect(body.succeeded).toHaveLength(1);
    expect(body.succeeded[0].developerId).toBe('gh:10');
    expect(body.succeeded[0].amountCents).toBe(4500);
    expect(body.succeeded[0].stripeTransferId).toBe('tr_mock_123');
    expect(body.summary.totalTransferred).toBe(1);
    expect(body.summary.totalAmountCents).toBe(4500);

    // Verify batch was called (payout record + engagement update)
    expect(db.batch).toHaveBeenCalledTimes(1);

    // The transfer MUST carry a per-developer-per-month idempotency key, so two
    // concurrent cron runs can't double-pay (the DB check is not atomic w/ Stripe).
    const transferCall = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls
      .find(([u]) => String(u).includes('/v1/transfers'));
    expect(transferCall).toBeDefined();
    const headers = (transferCall![1] as RequestInit).headers as Record<string, string>;
    expect(headers['Idempotency-Key']).toMatch(/^payout:gh:10:\d{4}-\d{2}$/);
  });

  it('reports Stripe failures without crashing', async () => {
    const db = mockD1(
      mockStmt({ all: { results: [{ developer_id: 'gh:10', total_cents: 2000, eng_count: 1 }] } }),
      mockStmt({ first: { stripe_connect_account_id: 'acct_bad', payouts_enabled: 1 } }),
      mockStmt({ first: null }), // idempotency check
    );

    // Stripe returns an error
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: { message: 'Insufficient funds' } }), { status: 402 }),
    );

    const res = await app.request('/v1/internal/payouts/run', {
      method: 'POST',
      headers: { 'X-Internal-Token': 'secret-cron-token' },
    }, env({}, db));
    expect(res.status).toBe(200);
    const body = await res.json() as { failed: { developerId: string; error: string }[]; summary: Record<string, number> };
    expect(body.failed).toHaveLength(1);
    expect(body.failed[0].developerId).toBe('gh:10');
    expect(body.summary.totalFailed).toBe(1);
    expect(body.summary.totalTransferred).toBe(0);
  });

  it('processes multiple developers in one run', async () => {
    const db = mockD1(
      // Unpaid aggregation
      mockStmt({
        all: {
          results: [
            { developer_id: 'gh:10', total_cents: 3000, eng_count: 2 },
            { developer_id: 'gh:20', total_cents: 7500, eng_count: 5 },
          ],
        },
      }),
      // Dev 1: connect lookup
      mockStmt({ first: { stripe_connect_account_id: 'acct_a', payouts_enabled: 1 } }),
      // Dev 1: idempotency check
      mockStmt({ first: null }),
      // Dev 1: batch -> INSERT service_payouts (prepare consumed by batch array)
      mockStmt(),
      // Dev 1: batch -> UPDATE engagements (prepare consumed by batch array)
      mockStmt(),
      // Dev 2: connect lookup
      mockStmt({ first: { stripe_connect_account_id: 'acct_b', payouts_enabled: 1 } }),
      // Dev 2: idempotency check
      mockStmt({ first: null }),
      // Dev 2: batch -> INSERT service_payouts
      mockStmt(),
      // Dev 2: batch -> UPDATE engagements
      mockStmt(),
    );

    globalThis.fetch = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: 'tr_1', amount: 3000, currency: 'usd', destination: 'acct_a' }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: 'tr_2', amount: 7500, currency: 'usd', destination: 'acct_b' }), { status: 200 }));

    const res = await app.request('/v1/internal/payouts/run', {
      method: 'POST',
      headers: { 'X-Internal-Token': 'secret-cron-token' },
    }, env({}, db));
    expect(res.status).toBe(200);
    const body = await res.json() as { succeeded: unknown[]; skipped: unknown[]; failed: unknown[]; summary: Record<string, number> };
    expect(body.succeeded).toHaveLength(2);
    expect(body.summary.totalTransferred).toBe(2);
    expect(body.summary.totalAmountCents).toBe(10500);
  });
});
