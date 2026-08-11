import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { app } from '../index.js';
import { testToken, TEST_SK, mockStmt, makeEnv as sharedMakeEnv } from '../test-helpers.js';

const TOK = await testToken('gh:1');

function mockD1(...stmts: ReturnType<typeof mockStmt>[]) {
  const prepare = vi.fn();
  const queue = [...stmts];
  // Record the SQL so tests can assert on which statements a handler built —
  // the clawback ledger write (#85) is conditional, and its absence is as much
  // the behaviour under test as its presence.
  const sqlSeen: string[] = [];
  prepare.mockImplementation((sql: string) => {
    sqlSeen.push(sql);
    return queue.length ? queue.shift()! : mockStmt();
  });
  return { prepare, sqlSeen, batch: vi.fn().mockResolvedValue([{ meta: { changes: 1 } }]) };
}

function env(overrides: Record<string, unknown> = {}, db?: ReturnType<typeof mockD1>) {
  return sharedMakeEnv({ AI: { run: vi.fn() }, ...overrides }, db ?? mockD1());
}

describe('POST /v1/services/engagements', () => {
  it('returns 401 without auth', async () => {
    const res = await app.request('/v1/services/engagements', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ developerId: 'gh:2' }),
    }, env());
    expect(res.status).toBe(401);
  });

  it('rejects missing developerId', async () => {
    const res = await app.request('/v1/services/engagements', {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOK}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    }, env());
    expect(res.status).toBe(400);
  });

  it('rejects hiring yourself', async () => {
    const db = mockD1(
      mockStmt({ first: { prompt_rate_cents: 100, available: 1 } }), // dev profile
    );
    // User is gh:1, trying to hire gh:1
    const res = await app.request('/v1/services/engagements', {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOK}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ developerId: 'gh:1' }),
    }, env({}, db));
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toContain('yourself');
  });
});

describe('GET /v1/services/engagements', () => {
  it('returns 401 without auth', async () => {
    const res = await app.request('/v1/services/engagements', {}, env());
    expect(res.status).toBe(401);
  });

  it('returns empty list when no engagements', async () => {
    const db = mockD1(mockStmt({ all: { results: [] } }));
    const res = await app.request('/v1/services/engagements', {
      headers: { Authorization: `Bearer ${TOK}` },
    }, env({}, db));
    expect(res.status).toBe(200);
    const body = await res.json() as { engagements: unknown[] };
    expect(body.engagements).toEqual([]);
  });
});

describe('POST /v1/services/requests', () => {
  it('rejects empty title', async () => {
    const res = await app.request('/v1/services/requests', {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOK}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: '', description: 'stuff' }),
    }, env());
    expect(res.status).toBe(400);
  });

  it('rejects title too long', async () => {
    const res = await app.request('/v1/services/requests', {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOK}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'x'.repeat(201), description: 'stuff' }),
    }, env());
    expect(res.status).toBe(400);
  });
});

describe('GET /v1/services/requests', () => {
  it('returns 200 without auth (public)', async () => {
    // no fetch mock needed for public endpoint
    const db = mockD1(mockStmt({ all: { results: [] } }));
    globalThis.fetch = vi.fn().mockResolvedValue(new Response('', { status: 200 }));
    const res = await app.request('/v1/services/requests', {}, env({}, db));
    expect(res.status).toBe(200);
  });
});

describe('POST /v1/services/engagements/:id/messages', () => {
  it('rejects empty body', async () => {
    const db = mockD1(
      mockStmt({ first: { client_id: 'gh:2', developer_id: 'gh:1', status: 'active', prompt_rate_cents: 100 } }),
    );
    const res = await app.request('/v1/services/engagements/test-id/messages', {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOK}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ body: '' }),
    }, env({}, db));
    expect(res.status).toBe(400);
  });

  it('rejects message too long', async () => {
    const res = await app.request('/v1/services/engagements/test-id/messages', {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOK}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ body: 'x'.repeat(33000) }),
    }, env());
    // The engagement lookup will fail first, but the length check is after auth
    expect([400, 404, 413]).toContain(res.status);
  });
});

describe('POST /v1/services/engagements/:id/rate', () => {
  it('rejects score 0', async () => {
    const db = mockD1(
      mockStmt({ first: { client_id: 'gh:1', developer_id: 'gh:2', status: 'delivered' } }),
    );
    const res = await app.request('/v1/services/engagements/test-id/rate', {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOK}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ score: 0 }),
    }, env({}, db));
    expect(res.status).toBe(400);
  });

  it('rejects score 6', async () => {
    const db = mockD1(
      mockStmt({ first: { client_id: 'gh:1', developer_id: 'gh:2', status: 'delivered' } }),
    );
    const res = await app.request('/v1/services/engagements/test-id/rate', {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOK}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ score: 6 }),
    }, env({}, db));
    expect(res.status).toBe(400);
  });
});

describe('POST /v1/services/engagements/:id/rate', () => {
  it('rejects non-integer score', async () => {
    const db = mockD1(
      mockStmt({ first: { client_id: 'gh:1', developer_id: 'gh:2', status: 'delivered' } }),
    );
    const res = await app.request('/v1/services/engagements/test-id/rate', {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOK}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ score: 3.5 }),
    }, env({}, db));
    expect(res.status).toBe(400);
  });

  it('rejects comment too long', async () => {
    const db = mockD1(
      mockStmt({ first: { client_id: 'gh:1', developer_id: 'gh:2', status: 'delivered' } }),
    );
    const res = await app.request('/v1/services/engagements/test-id/rate', {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOK}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ score: 5, comment: 'x'.repeat(2001) }),
    }, env({}, db));
    expect(res.status).toBe(400);
  });

  it('rejects rating from non-client', async () => {
    // User is gh:1, developer is gh:1 — they are the dev, not the client
    const db = mockD1(
      mockStmt({ first: { client_id: 'gh:99', developer_id: 'gh:1', status: 'delivered' } }),
    );
    const res = await app.request('/v1/services/engagements/test-id/rate', {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOK}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ score: 5 }),
    }, env({}, db));
    expect(res.status).toBe(403);
  });

  it('rejects rating on active (non-delivered) engagement', async () => {
    const db = mockD1(
      mockStmt({ first: { client_id: 'gh:1', developer_id: 'gh:2', status: 'active' } }),
    );
    const res = await app.request('/v1/services/engagements/test-id/rate', {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOK}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ score: 5 }),
    }, env({}, db));
    expect(res.status).toBe(400);
  });
});

describe('PATCH /v1/services/engagements/:id', () => {
  it('rejects invalid status', async () => {
    const db = mockD1(
      mockStmt({ first: { client_id: 'gh:1', developer_id: 'gh:2', status: 'active' } }),
    );
    const res = await app.request('/v1/services/engagements/test-id', {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${TOK}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'bogus' }),
    }, env({}, db));
    expect(res.status).toBe(400);
  });

  it('rejects delivery by client (only dev can deliver)', async () => {
    // User gh:1 is the client, not the developer
    const db = mockD1(
      mockStmt({ first: { client_id: 'gh:1', developer_id: 'gh:2', status: 'active' } }),
    );
    const res = await app.request('/v1/services/engagements/test-id', {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${TOK}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'delivered' }),
    }, env({}, db));
    expect(res.status).toBe(403);
  });

  it('rejects status change on non-active engagement', async () => {
    const db = mockD1(
      mockStmt({ first: { client_id: 'gh:1', developer_id: 'gh:2', status: 'delivered' } }),
    );
    const res = await app.request('/v1/services/engagements/test-id', {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${TOK}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'cancelled' }),
    }, env({}, db));
    expect(res.status).toBe(400);
  });
});

describe('POST /v1/services/engagements/:id/refund', () => {
  it('rejects non-admin', async () => {
    const res = await app.request('/v1/services/engagements/test-id/refund', {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOK}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ amountCents: 100 }),
    }, env({ ADMIN_GITHUB_IDS: 'gh:99' }));
    expect(res.status).toBe(403);
  });

  it('rejects refund with no amount', async () => {
    // User gh:1 IS the admin
    const db = mockD1(
      mockStmt({ first: { client_id: 'gh:2', developer_id: 'gh:3', total_charged_cents: 500 } }),
    );
    const res = await app.request('/v1/services/engagements/test-id/refund', {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOK}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ amountCents: 0 }),
    }, env({ ADMIN_GITHUB_IDS: 'gh:1' }, db));
    expect(res.status).toBe(400);
  });

  it('reverses the developer earnings + platform fee so the payout cron does not pay refunded work', async () => {
    const select = mockStmt({
      first: {
        client_id: 'gh:2', developer_id: 'gh:3',
        total_charged_cents: 1000, total_dev_earned_cents: 900,
        total_platform_fee_cents: 100, total_refunded_cents: 0, payout_month: null,
      },
    });
    const creditClient = mockStmt();
    const insertTxn = mockStmt();
    const updateEng = mockStmt();
    const db = mockD1(select, creditClient, insertTxn, updateEng);

    const res = await app.request('/v1/services/engagements/test-id/refund', {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOK}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ amountCents: 1000 }),
    }, env({ ADMIN_GITHUB_IDS: 'gh:1' }, db));

    expect(res.status).toBe(200);
    const json = await res.json() as { devClawbackCents: number; clawbackAlreadyPaid: boolean };
    expect(json.devClawbackCents).toBe(900); // 90% of the $10 refund
    expect(json.clawbackAlreadyPaid).toBe(false);
    // UPDATE engagements binds (refund, devClawback, feeClawback, id)
    expect(updateEng.bind).toHaveBeenCalledWith(1000, 900, 100, 'test-id');
  });

  it('caps refunds against the remaining refundable, not the (never-decremented) total charged', async () => {
    const db = mockD1(
      mockStmt({
        first: {
          client_id: 'gh:2', developer_id: 'gh:3',
          total_charged_cents: 1000, total_dev_earned_cents: 900,
          total_platform_fee_cents: 100, total_refunded_cents: 800, payout_month: null,
        },
      }),
    );
    // Only $2 remains refundable (1000 - 800); asking for $4 must be rejected.
    const res = await app.request('/v1/services/engagements/test-id/refund', {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOK}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ amountCents: 400 }),
    }, env({ ADMIN_GITHUB_IDS: 'gh:1' }, db));
    expect(res.status).toBe(400);
  });

  it('flags clawbackAlreadyPaid when the engagement was already paid out', async () => {
    const db = mockD1(
      mockStmt({
        first: {
          client_id: 'gh:2', developer_id: 'gh:3',
          total_charged_cents: 1000, total_dev_earned_cents: 900,
          total_platform_fee_cents: 100, total_refunded_cents: 0, payout_month: '2026-07',
        },
      }),
    );
    const res = await app.request('/v1/services/engagements/test-id/refund', {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOK}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ amountCents: 500 }),
    }, env({ ADMIN_GITHUB_IDS: 'gh:1' }, db));
    expect(res.status).toBe(200);
    const json = await res.json() as { clawbackAlreadyPaid: boolean };
    expect(json.clawbackAlreadyPaid).toBe(true);
  });

  // #85: decrementing total_dev_earned_cents only recovers money while the
  // engagement is still unpaid — the payout cron sums `WHERE payout_month IS
  // NULL` and never reads a settled row again. What the decrement cannot
  // recover is banked against the developer instead of being lost.
  it('banks the FULL clawback as debt when the engagement was already paid', async () => {
    const db = mockD1(
      mockStmt({
        first: {
          client_id: 'gh:2', developer_id: 'gh:3',
          total_charged_cents: 1000, total_dev_earned_cents: 900,
          total_platform_fee_cents: 100, total_refunded_cents: 0, payout_month: '2026-07',
        },
      }),
    );
    const res = await app.request('/v1/services/engagements/test-id/refund', {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOK}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ amountCents: 1000 }),
    }, env({ ADMIN_GITHUB_IDS: 'gh:1' }, db));

    const json = await res.json() as { pendingClawbackCents: number };
    // The decrement "applies" 900, but recovers nothing — the row is settled.
    // Keying off the un-applied remainder would bank 0 and lose the money.
    expect(json.pendingClawbackCents).toBe(900);
    const ledgerWrite = db.sqlSeen.find((q) => /developer_clawbacks/i.test(q));
    expect(ledgerWrite).toBeDefined();
  });

  it('banks nothing when the engagement is unpaid — the decrement does the work', async () => {
    const db = mockD1(
      mockStmt({
        first: {
          client_id: 'gh:2', developer_id: 'gh:3',
          total_charged_cents: 1000, total_dev_earned_cents: 900,
          total_platform_fee_cents: 100, total_refunded_cents: 0, payout_month: null,
        },
      }),
    );
    const res = await app.request('/v1/services/engagements/test-id/refund', {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOK}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ amountCents: 1000 }),
    }, env({ ADMIN_GITHUB_IDS: 'gh:1' }, db));

    const json = await res.json() as { pendingClawbackCents: number };
    expect(json.pendingClawbackCents).toBe(0);
    expect(db.sqlSeen.some((q) => /developer_clawbacks/i.test(q))).toBe(false);
  });

  it('banks the clamped-off remainder on an unpaid engagement', async () => {
    // A prior partial refund already pulled the balance down, so the decrement
    // clamps. The old code dropped the difference silently.
    const db = mockD1(
      mockStmt({
        first: {
          client_id: 'gh:2', developer_id: 'gh:3',
          total_charged_cents: 1000, total_dev_earned_cents: 200,
          total_platform_fee_cents: 100, total_refunded_cents: 0, payout_month: null,
        },
      }),
    );
    const res = await app.request('/v1/services/engagements/test-id/refund', {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOK}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ amountCents: 1000 }),
    }, env({ ADMIN_GITHUB_IDS: 'gh:1' }, db));

    const json = await res.json() as { devClawbackCents: number; pendingClawbackCents: number };
    expect(json.devClawbackCents).toBe(200);      // all the row had left
    expect(json.pendingClawbackCents).toBe(700);  // 900 owed − 200 recovered
  });
});

describe('DELETE /v1/services/requests/:id', () => {
  it('returns 401 without auth', async () => {
    const res = await app.request('/v1/services/requests/test-id', {
      method: 'DELETE',
    }, env());
    expect(res.status).toBe(401);
  });
});
