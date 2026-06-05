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

function makeEnv(overrides: Record<string, unknown> = {}, db?: ReturnType<typeof mockD1>) {
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

// POST /v1/apps/:appId/logs — any authenticated user can ingest logs for any app

describe('POST /v1/apps/:appId/logs', () => {
  it('returns 401 without auth', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(new Response('nope', { status: 401 }));
    const res = await app.request('/v1/apps/myapp/logs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ entries: [] }),
    }, makeEnv());
    expect(res.status).toBe(401);
  });

  it('returns 400 when entries array is missing', async () => {
    const res = await app.request('/v1/apps/myapp/logs', {
      method: 'POST',
      headers: { Authorization: 'Bearer tok', 'Content-Type': 'application/json' },
      body: JSON.stringify({ notEntries: 'oops' }),
    }, makeEnv());
    expect(res.status).toBe(400);
  });

  it('returns 400 when entries is not an array', async () => {
    const res = await app.request('/v1/apps/myapp/logs', {
      method: 'POST',
      headers: { Authorization: 'Bearer tok', 'Content-Type': 'application/json' },
      body: JSON.stringify({ entries: 'a string' }),
    }, makeEnv());
    expect(res.status).toBe(400);
  });

  it('ingests valid entries and returns count', async () => {
    const db = mockD1();
    const entries = [
      { ts: Date.now(), level: 'info', category: 'app', message: 'hello world' },
      { ts: Date.now(), level: 'error', category: 'net', message: 'request failed', data: { status: 500 } },
    ];
    const res = await app.request('/v1/apps/myapp/logs', {
      method: 'POST',
      headers: { Authorization: 'Bearer tok', 'Content-Type': 'application/json' },
      body: JSON.stringify({ entries }),
    }, makeEnv({}, db));
    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean; ingested: number };
    expect(body.ok).toBe(true);
    expect(body.ingested).toBe(2);
  });

  it('silently filters entries that are missing required fields', async () => {
    const db = mockD1();
    const entries = [
      { ts: Date.now(), level: 'info', message: 'valid' },
      { ts: Date.now(), level: 'info' }, // missing message — filtered out
      { level: 'info', message: 'no ts' }, // missing ts — filtered out
    ];
    const res = await app.request('/v1/apps/myapp/logs', {
      method: 'POST',
      headers: { Authorization: 'Bearer tok', 'Content-Type': 'application/json' },
      body: JSON.stringify({ entries }),
    }, makeEnv({}, db));
    expect(res.status).toBe(200);
    const body = await res.json() as { ingested: number };
    expect(body.ingested).toBe(1);
  });

  it('caps batch at 100 entries silently', async () => {
    const db = mockD1();
    const entries = Array.from({ length: 150 }, (_, i) => ({
      ts: Date.now() + i,
      level: 'info',
      category: 'app',
      message: `msg ${i}`,
    }));
    const res = await app.request('/v1/apps/myapp/logs', {
      method: 'POST',
      headers: { Authorization: 'Bearer tok', 'Content-Type': 'application/json' },
      body: JSON.stringify({ entries }),
    }, makeEnv({}, db));
    expect(res.status).toBe(200);
    const body = await res.json() as { ingested: number };
    expect(body.ingested).toBe(100);
  });
});

// GET /v1/apps/:appId/logs — owner only

describe('GET /v1/apps/:appId/logs', () => {
  it('returns 401 without auth', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(new Response('nope', { status: 401 }));
    const res = await app.request('/v1/apps/myapp/logs', {
      headers: { Authorization: 'Bearer bad' },
    }, makeEnv());
    expect(res.status).toBe(401);
  });

  it('returns 404 when app does not exist', async () => {
    // requireAppOwner first queries apps table — return null to trigger 404
    const db = mockD1(mockStmt({ first: null }));
    const res = await app.request('/v1/apps/myapp/logs', {
      headers: { Authorization: 'Bearer tok' },
    }, makeEnv({}, db));
    expect(res.status).toBe(404);
  });

  it('returns 403 when user is not the owner', async () => {
    // App exists but creator_id is a different user
    const db = mockD1(mockStmt({ first: { creator_id: 'gh:99' } }));
    const res = await app.request('/v1/apps/myapp/logs', {
      headers: { Authorization: 'Bearer tok' },
    }, makeEnv({}, db));
    expect(res.status).toBe(403);
  });

  it('returns logs array for app owner', async () => {
    const db = mockD1(
      mockStmt({ first: { creator_id: 'gh:1' } }), // requireAppOwner
      mockStmt({ all: { results: [
        { ts: 1000, level: 'info', category: 'app', message: 'hello', data: null, user_id: 'gh:1', build_meta: null },
      ]}}),
    );
    const res = await app.request('/v1/apps/myapp/logs', {
      headers: { Authorization: 'Bearer tok' },
    }, makeEnv({}, db));
    expect(res.status).toBe(200);
    const body = await res.json() as { logs: unknown[] };
    expect(body.logs).toHaveLength(1);
  });

  it('parses data JSON field in log results', async () => {
    const db = mockD1(
      mockStmt({ first: { creator_id: 'gh:1' } }),
      mockStmt({ all: { results: [
        { ts: 1000, level: 'error', category: 'net', message: 'err', data: '{"status":500}', user_id: 'gh:1', build_meta: null },
      ]}}),
    );
    const res = await app.request('/v1/apps/myapp/logs', {
      headers: { Authorization: 'Bearer tok' },
    }, makeEnv({}, db));
    const body = await res.json() as { logs: { data: unknown }[] };
    expect(body.logs[0]!.data).toEqual({ status: 500 });
  });
});

// GET /v1/apps/:appId/logs/build — owner only

describe('GET /v1/apps/:appId/logs/build', () => {
  it('returns 403 when user is not the owner', async () => {
    const db = mockD1(mockStmt({ first: { creator_id: 'gh:99' } }));
    const res = await app.request('/v1/apps/myapp/logs/build', {
      headers: { Authorization: 'Bearer tok' },
    }, makeEnv({}, db));
    expect(res.status).toBe(403);
  });

  it('returns {build: null} when no build log exists', async () => {
    const db = mockD1(
      mockStmt({ first: { creator_id: 'gh:1' } }), // requireAppOwner
      mockStmt({ first: null }), // no build row
    );
    const res = await app.request('/v1/apps/myapp/logs/build', {
      headers: { Authorization: 'Bearer tok' },
    }, makeEnv({}, db));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ build: null });
  });

  it('returns parsed build metadata when a build log row exists', async () => {
    const buildMeta = { commit: 'abc123', branch: 'main', duration: 42 };
    const db = mockD1(
      mockStmt({ first: { creator_id: 'gh:1' } }),
      mockStmt({ first: { build_meta: JSON.stringify(buildMeta), ts: 9999 } }),
    );
    const res = await app.request('/v1/apps/myapp/logs/build', {
      headers: { Authorization: 'Bearer tok' },
    }, makeEnv({}, db));
    expect(res.status).toBe(200);
    const body = await res.json() as { build: unknown; ts: number };
    expect(body.build).toEqual(buildMeta);
    expect(body.ts).toBe(9999);
  });
});
