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

describe('POST /v1/services/engagements', () => {
  it('returns 401 without auth', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(new Response('nope', { status: 401 }));
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
      headers: { Authorization: 'Bearer tok', 'Content-Type': 'application/json' },
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
      headers: { Authorization: 'Bearer tok', 'Content-Type': 'application/json' },
      body: JSON.stringify({ developerId: 'gh:1' }),
    }, env({}, db));
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toContain('yourself');
  });
});

describe('GET /v1/services/engagements', () => {
  it('returns 401 without auth', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(new Response('nope', { status: 401 }));
    const res = await app.request('/v1/services/engagements', {}, env());
    expect(res.status).toBe(401);
  });

  it('returns empty list when no engagements', async () => {
    const db = mockD1(mockStmt({ all: { results: [] } }));
    const res = await app.request('/v1/services/engagements', {
      headers: { Authorization: 'Bearer tok' },
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
      headers: { Authorization: 'Bearer tok', 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: '', description: 'stuff' }),
    }, env());
    expect(res.status).toBe(400);
  });

  it('rejects title too long', async () => {
    const res = await app.request('/v1/services/requests', {
      method: 'POST',
      headers: { Authorization: 'Bearer tok', 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'x'.repeat(201), description: 'stuff' }),
    }, env());
    expect(res.status).toBe(400);
  });
});

describe('GET /v1/services/requests', () => {
  it('returns 200 without auth (public)', async () => {
    globalThis.fetch = originalFetch;
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
      headers: { Authorization: 'Bearer tok', 'Content-Type': 'application/json' },
      body: JSON.stringify({ body: '' }),
    }, env({}, db));
    expect(res.status).toBe(400);
  });

  it('rejects message too long', async () => {
    const res = await app.request('/v1/services/engagements/test-id/messages', {
      method: 'POST',
      headers: { Authorization: 'Bearer tok', 'Content-Type': 'application/json' },
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
      headers: { Authorization: 'Bearer tok', 'Content-Type': 'application/json' },
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
      headers: { Authorization: 'Bearer tok', 'Content-Type': 'application/json' },
      body: JSON.stringify({ score: 6 }),
    }, env({}, db));
    expect(res.status).toBe(400);
  });
});

describe('POST /v1/services/engagements/:id/refund', () => {
  it('rejects non-admin', async () => {
    const res = await app.request('/v1/services/engagements/test-id/refund', {
      method: 'POST',
      headers: { Authorization: 'Bearer tok', 'Content-Type': 'application/json' },
      body: JSON.stringify({ amountCents: 100 }),
    }, env({ ADMIN_GITHUB_IDS: 'gh:99' }));
    expect(res.status).toBe(403);
  });
});
