import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { app } from '../index.js';

const originalFetch = globalThis.fetch;

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
    SESSION_SIGNING_KEY: 'sign_key',
    FAS_API_BASE: 'https://api.freeappstore.online',
    CF_API_TOKEN: 'cf_tok',
    CF_ACCOUNT_ID: 'cf_acct',
    VAPID_PUBLIC_KEY: 'test-vapid-public',
    VAPID_PRIVATE_KEY: 'test-vapid-private',
    AI: { run: vi.fn() },
    ...overrides,
  };
}

function asUser(id = 'gh:1') {
  return vi.fn().mockResolvedValue(
    new Response(JSON.stringify({ id, login: 'tester', avatarUrl: null, roles: ['user'], appRoles: {} }), { status: 200 }),
  );
}

beforeEach(() => { globalThis.fetch = asUser(); });
afterEach(() => { globalThis.fetch = originalFetch; });

describe('GET /v1/services/developers', () => {
  it('returns 200 with empty list (no auth needed)', async () => {
    globalThis.fetch = originalFetch; // no mock needed, but we need D1 mock
    const db = mockD1(mockStmt({ all: { results: [] } }));
    // Use the original fetch for the API call
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ results: [] }), { status: 200 }),
    );
    const res = await app.request('/v1/services/developers', {}, env({}, db));
    expect(res.status).toBe(200);
    const body = await res.json() as { developers: unknown[] };
    expect(body.developers).toEqual([]);
  });
});

describe('GET /v1/services/profile', () => {
  it('returns 401 without auth', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(new Response('nope', { status: 401 }));
    const res = await app.request('/v1/services/profile', {}, env());
    expect(res.status).toBe(401);
  });

  it('returns exists:false when no profile exists', async () => {
    const db = mockD1(mockStmt({ first: null }));
    const res = await app.request('/v1/services/profile', {
      headers: { Authorization: 'Bearer tok' },
    }, env({}, db));
    expect(res.status).toBe(200);
    const body = await res.json() as { exists: boolean };
    expect(body.exists).toBe(false);
  });
});

describe('PUT /v1/services/profile', () => {
  it('validates rate range', async () => {
    const res = await app.request('/v1/services/profile', {
      method: 'PUT',
      headers: { Authorization: 'Bearer tok', 'Content-Type': 'application/json' },
      body: JSON.stringify({ promptRateCents: 5 }), // below min 10
    }, env());
    expect(res.status).toBe(400);
  });

  it('validates rate upper bound', async () => {
    const res = await app.request('/v1/services/profile', {
      method: 'PUT',
      headers: { Authorization: 'Bearer tok', 'Content-Type': 'application/json' },
      body: JSON.stringify({ promptRateCents: 10000 }), // above max 5000
    }, env());
    expect(res.status).toBe(400);
  });

  it('validates bio length', async () => {
    const res = await app.request('/v1/services/profile', {
      method: 'PUT',
      headers: { Authorization: 'Bearer tok', 'Content-Type': 'application/json' },
      body: JSON.stringify({ bioServices: 'x'.repeat(2001) }),
    }, env());
    expect(res.status).toBe(400);
  });
});

describe('GET /v1/services/balance', () => {
  it('returns 401 without auth', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(new Response('nope', { status: 401 }));
    const res = await app.request('/v1/services/balance', {}, env());
    expect(res.status).toBe(401);
  });

  it('returns 0 balance when no record exists', async () => {
    const db = mockD1(mockStmt({ first: null }));
    const res = await app.request('/v1/services/balance', {
      headers: { Authorization: 'Bearer tok' },
    }, env({}, db));
    expect(res.status).toBe(200);
    const body = await res.json() as { balanceCents: number };
    expect(body.balanceCents).toBe(0);
  });
});

describe('POST /v1/services/balance/deposit', () => {
  it('rejects amount below minimum', async () => {
    const res = await app.request('/v1/services/balance/deposit', {
      method: 'POST',
      headers: { Authorization: 'Bearer tok', 'Content-Type': 'application/json' },
      body: JSON.stringify({ amountCents: 500, successUrl: 'https://proappstore.online/app', cancelUrl: 'https://proappstore.online/app' }),
    }, env());
    expect(res.status).toBe(400);
  });

  it('rejects amount above maximum', async () => {
    const res = await app.request('/v1/services/balance/deposit', {
      method: 'POST',
      headers: { Authorization: 'Bearer tok', 'Content-Type': 'application/json' },
      body: JSON.stringify({ amountCents: 200000, successUrl: 'https://proappstore.online/app', cancelUrl: 'https://proappstore.online/app' }),
    }, env());
    expect(res.status).toBe(400);
  });

  it('rejects bad redirect URLs', async () => {
    const res = await app.request('/v1/services/balance/deposit', {
      method: 'POST',
      headers: { Authorization: 'Bearer tok', 'Content-Type': 'application/json' },
      body: JSON.stringify({ amountCents: 1000, successUrl: 'https://evil.com', cancelUrl: 'https://proappstore.online/app' }),
    }, env());
    expect(res.status).toBe(400);
  });
});

describe('POST /v1/services/recompute-stats', () => {
  it('rejects without internal token', async () => {
    const res = await app.request('/v1/services/recompute-stats', {
      method: 'POST',
    }, env());
    expect(res.status).toBe(403);
  });

  it('rejects with wrong token', async () => {
    const res = await app.request('/v1/services/recompute-stats', {
      method: 'POST',
      headers: { 'X-Internal-Token': 'wrong' },
    }, env({ INTERNAL_TOKEN: 'correct' }));
    expect(res.status).toBe(403);
  });
});
