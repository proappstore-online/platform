import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { app } from '../index.js';
import { testToken, TEST_SK, mockStmt, makeEnv as sharedMakeEnv } from '../test-helpers.js';

const TOK = await testToken('gh:1');

/**
 * Positional statement mock, with one exception: the developer_clawbacks debt
 * lookup (#85) is answered out-of-band rather than consuming a slot. These tests
 * describe a sequence of payout queries, and threading a "no debt" row through
 * every one of them would obscure what each case is actually about. Pass
 * `debtCents` to opt a test into having outstanding debt.
 */
function mockD1(...stmts: ReturnType<typeof mockStmt>[]) {
  return mockD1WithDebt(0, ...stmts);
}

function mockD1WithDebt(debtCents: number, ...stmts: ReturnType<typeof mockStmt>[]) {
  const prepare = vi.fn();
  const queue = [...stmts];
  const sqlSeen: string[] = [];
  prepare.mockImplementation((sql: string) => {
    sqlSeen.push(sql);
    if (/developer_clawbacks/i.test(sql)) {
      return mockStmt({ first: debtCents > 0 ? { pending_clawback_cents: debtCents } : null });
    }
    return queue.length ? queue.shift()! : mockStmt();
  });
  return {
    prepare,
    sqlSeen,
    batch: vi.fn().mockResolvedValue([{ meta: { changes: 1 } }]),
  };
}

function env(overrides: Record<string, unknown> = {}, db?: ReturnType<typeof mockD1>) {
  return sharedMakeEnv(
    { AI: { run: vi.fn() }, INTERNAL_TOKEN: 'secret-cron-token', ...overrides },
    db ?? mockD1(),
  );
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
      totalClawbackRecoveredCents: 0,
      totalClawbackOutstandingCents: 0,
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

  it('marks only the engagements captured in the snapshot as paid (not a fresh scan)', async () => {
    const insertPayout = mockStmt();
    const updateEng = mockStmt();
    const db = mockD1(
      mockStmt({ all: { results: [{ developer_id: 'gh:10', total_cents: 4500, eng_count: 2, eng_ids: 'eng-a,eng-b' }] } }),
      mockStmt({ first: { stripe_connect_account_id: 'acct_abc', payouts_enabled: 1 } }),
      mockStmt({ first: null }), // idempotency check
      insertPayout, // batch[0]: INSERT service_payouts
      updateEng,    // batch[1]: UPDATE engagements
    );
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ id: 'tr_x', amount: 4500, currency: 'usd', destination: 'acct_abc' }), { status: 200 }),
    );

    const res = await app.request('/v1/internal/payouts/run', {
      method: 'POST',
      headers: { 'X-Internal-Token': 'secret-cron-token' },
    }, env({}, db));
    expect(res.status).toBe(200);
    // The UPDATE is scoped to the exact snapshot ids + payout_month, so an
    // engagement that flips to 'delivered' mid-run isn't swept in and underpaid.
    const bindArgs = updateEng.bind.mock.calls[0];
    expect(bindArgs).toContain('eng-a');
    expect(bindArgs).toContain('eng-b');
    // month + 2 ids
    expect(bindArgs).toHaveLength(3);
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

// #85: a refund on an already-settled engagement can't be recovered by
// decrementing that engagement — this cron never reads settled rows again — so
// the shortfall is banked against the developer and netted here.
describe('POST /v1/internal/payouts/run — clawback netting (#85)', () => {
  const okTransfer = () =>
    vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ id: 'tr_net', amount: 1, currency: 'usd', destination: 'acct_abc' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

  it('nets debt off the transfer when earnings exceed it', async () => {
    const db = mockD1WithDebt(
      1500,
      mockStmt({ all: { results: [{ developer_id: 'gh:10', total_cents: 4500, eng_count: 3, eng_ids: 'e1,e2,e3' }] } }),
      mockStmt({ first: { stripe_connect_account_id: 'acct_abc', payouts_enabled: 1 } }),
      mockStmt({ first: null }),
    );
    globalThis.fetch = okTransfer();

    const res = await app.request('/v1/internal/payouts/run', {
      method: 'POST', headers: { 'X-Internal-Token': 'secret-cron-token' },
    }, env({}, db));

    const body = await res.json() as {
      succeeded: { amountCents: number; clawbackAppliedCents?: number }[];
      summary: Record<string, number>;
    };
    expect(body.succeeded[0].amountCents).toBe(3000); // 4500 earned − 1500 debt
    expect(body.succeeded[0].clawbackAppliedCents).toBe(1500);
    expect(body.summary.totalClawbackRecoveredCents).toBe(1500);
  });

  it('transfers the NET amount to Stripe, not the gross earnings', async () => {
    // The whole point: the developer must not receive money already refunded.
    const db = mockD1WithDebt(
      1500,
      mockStmt({ all: { results: [{ developer_id: 'gh:10', total_cents: 4500, eng_count: 3, eng_ids: 'e1' }] } }),
      mockStmt({ first: { stripe_connect_account_id: 'acct_abc', payouts_enabled: 1 } }),
      mockStmt({ first: null }),
    );
    globalThis.fetch = okTransfer();

    await app.request('/v1/internal/payouts/run', {
      method: 'POST', headers: { 'X-Internal-Token': 'secret-cron-token' },
    }, env({}, db));

    const transferCall = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls
      .find(([u]) => String(u).includes('/v1/transfers'));
    expect(String((transferCall![1] as RequestInit).body)).toContain('amount=3000');
  });

  it('makes no transfer when debt swallows the whole month, and carries the rest forward', async () => {
    const db = mockD1WithDebt(
      7000,
      mockStmt({ all: { results: [{ developer_id: 'gh:10', total_cents: 4500, eng_count: 2, eng_ids: 'e1,e2' }] } }),
    );
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('no transfer should be attempted'));

    const res = await app.request('/v1/internal/payouts/run', {
      method: 'POST', headers: { 'X-Internal-Token': 'secret-cron-token' },
    }, env({}, db));

    const body = await res.json() as {
      succeeded: unknown[];
      clawbackSettlements: { developerId: string; remainingClawbackCents: number; clawbackAppliedCents: number }[];
      summary: Record<string, number>;
    };
    expect(body.succeeded).toHaveLength(0);
    expect(body.clawbackSettlements).toHaveLength(1);
    expect(body.clawbackSettlements[0].clawbackAppliedCents).toBe(4500);
    expect(body.clawbackSettlements[0].remainingClawbackCents).toBe(2500); // 7000 − 4500
    expect(body.summary.totalClawbackOutstandingCents).toBe(2500);
  });

  it('still settles the engagements when debt swallows the month', async () => {
    // Leaving them unpaid would re-count them next month against a debt those
    // same earnings had already reduced — paying twice for refunded work.
    const db = mockD1WithDebt(
      7000,
      mockStmt({ all: { results: [{ developer_id: 'gh:10', total_cents: 4500, eng_count: 2, eng_ids: 'e1,e2' }] } }),
    );
    await app.request('/v1/internal/payouts/run', {
      method: 'POST', headers: { 'X-Internal-Token': 'secret-cron-token' },
    }, env({}, db));

    expect(db.batch).toHaveBeenCalledTimes(1);
    const stamped = db.sqlSeen.some((s) => /UPDATE engagements/i.test(s) && /payout_month/i.test(s));
    expect(stamped).toBe(true);
  });

  it('guards the debt write on the value it netted against', async () => {
    // Compare-and-swap: two concurrent runs must not both subtract the same
    // earnings from the same debt. Stripe idempotency guards the money; this
    // guards the ledger.
    const db = mockD1WithDebt(
      7000,
      mockStmt({ all: { results: [{ developer_id: 'gh:10', total_cents: 4500, eng_count: 1, eng_ids: 'e1' }] } }),
    );
    await app.request('/v1/internal/payouts/run', {
      method: 'POST', headers: { 'X-Internal-Token': 'secret-cron-token' },
    }, env({}, db));

    const debtUpdate = db.sqlSeen.find((s) => /UPDATE developer_clawbacks/i.test(s));
    expect(debtUpdate).toBeDefined();
    expect(debtUpdate).toMatch(/WHERE\s+developer_id\s*=\s*\?\s+AND\s+pending_clawback_cents\s*=\s*\?/i);
  });

  it('leaves a debt-free developer completely unaffected', async () => {
    const db = mockD1(
      mockStmt({ all: { results: [{ developer_id: 'gh:10', total_cents: 4500, eng_count: 3, eng_ids: 'e1' }] } }),
      mockStmt({ first: { stripe_connect_account_id: 'acct_abc', payouts_enabled: 1 } }),
      mockStmt({ first: null }),
    );
    globalThis.fetch = okTransfer();

    const res = await app.request('/v1/internal/payouts/run', {
      method: 'POST', headers: { 'X-Internal-Token': 'secret-cron-token' },
    }, env({}, db));

    const body = await res.json() as {
      succeeded: { amountCents: number; clawbackAppliedCents?: number }[];
      summary: Record<string, number>;
    };
    expect(body.succeeded[0].amountCents).toBe(4500);
    expect(body.succeeded[0].clawbackAppliedCents).toBeUndefined();
    expect(body.summary.totalClawbackRecoveredCents).toBe(0);
    expect(db.sqlSeen.some((s) => /UPDATE developer_clawbacks/i.test(s))).toBe(false);
  });
});
