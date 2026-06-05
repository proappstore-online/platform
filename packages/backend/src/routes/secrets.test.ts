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
  return { prepare, batch: vi.fn().mockResolvedValue([]) };
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

// GET /v1/apps/:appId/secrets

describe('GET /v1/apps/:appId/secrets', () => {
  it('returns 401 without auth', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(new Response('nope', { status: 401 }));
    const res = await app.request('/v1/apps/myapp/secrets', {
      headers: { Authorization: 'Bearer bad' },
    }, makeEnv());
    expect(res.status).toBe(401);
  });

  it('returns 404 when app does not exist', async () => {
    const db = mockD1(mockStmt({ first: null })); // apps table lookup returns null
    const res = await app.request('/v1/apps/myapp/secrets', {
      headers: { Authorization: 'Bearer tok' },
    }, makeEnv({}, db));
    expect(res.status).toBe(404);
  });

  it('returns 403 when user is not the owner', async () => {
    const db = mockD1(mockStmt({ first: { creator_id: 'gh:99' } }));
    const res = await app.request('/v1/apps/myapp/secrets', {
      headers: { Authorization: 'Bearer tok' },
    }, makeEnv({}, db));
    expect(res.status).toBe(403);
  });

  it('returns empty secrets list for app owner', async () => {
    const db = mockD1(
      mockStmt({ first: { creator_id: 'gh:1' } }), // requireAppOwner
      mockStmt({ all: { results: [] } }), // secrets query
    );
    const res = await app.request('/v1/apps/myapp/secrets', {
      headers: { Authorization: 'Bearer tok' },
    }, makeEnv({}, db));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ secrets: [] });
  });

  it('returns secret names with timestamps but no values', async () => {
    const db = mockD1(
      mockStmt({ first: { creator_id: 'gh:1' } }),
      mockStmt({ all: { results: [{ name: 'OPENWEATHER_KEY', created_at: 1000, last_used_at: null }] } }),
    );
    const res = await app.request('/v1/apps/myapp/secrets', {
      headers: { Authorization: 'Bearer tok' },
    }, makeEnv({}, db));
    expect(res.status).toBe(200);
    const body = await res.json() as { secrets: { name: string }[] };
    expect(body.secrets[0]!.name).toBe('OPENWEATHER_KEY');
  });
});

// PUT /v1/apps/:appId/secrets/:name

describe('PUT /v1/apps/:appId/secrets/:name', () => {
  it('returns 401 without auth', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(new Response('nope', { status: 401 }));
    const res = await app.request('/v1/apps/myapp/secrets/API_KEY', {
      method: 'PUT',
      headers: { Authorization: 'Bearer bad', 'Content-Type': 'application/json' },
      body: JSON.stringify({ value: 'secret-value' }),
    }, makeEnv());
    expect(res.status).toBe(401);
  });

  it('returns 400 for invalid secret name (lowercase)', async () => {
    const res = await app.request('/v1/apps/myapp/secrets/bad_name', {
      method: 'PUT',
      headers: { Authorization: 'Bearer tok', 'Content-Type': 'application/json' },
      body: JSON.stringify({ value: 'secret-value' }),
    }, makeEnv());
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toContain('uppercase');
  });

  it('returns 400 for invalid secret name (starts with digit)', async () => {
    const res = await app.request('/v1/apps/myapp/secrets/1INVALID', {
      method: 'PUT',
      headers: { Authorization: 'Bearer tok', 'Content-Type': 'application/json' },
      body: JSON.stringify({ value: 'secret-value' }),
    }, makeEnv());
    expect(res.status).toBe(400);
  });

  it('returns 400 when value is empty string', async () => {
    // Name passes validation; owner check passes; then value check fires
    const db = mockD1(
      mockStmt({ first: { creator_id: 'gh:1' } }), // requireAppOwner
    );
    const res = await app.request('/v1/apps/myapp/secrets/API_KEY', {
      method: 'PUT',
      headers: { Authorization: 'Bearer tok', 'Content-Type': 'application/json' },
      body: JSON.stringify({ value: '' }),
    }, makeEnv({ APP_SECRET_KEK: btoa('a'.repeat(32)) }, db));
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toContain('non-empty string');
  });

  it('returns 400 when value exceeds 4096 chars', async () => {
    const db = mockD1(
      mockStmt({ first: { creator_id: 'gh:1' } }),
    );
    const res = await app.request('/v1/apps/myapp/secrets/API_KEY', {
      method: 'PUT',
      headers: { Authorization: 'Bearer tok', 'Content-Type': 'application/json' },
      body: JSON.stringify({ value: 'x'.repeat(4097) }),
    }, makeEnv({ APP_SECRET_KEK: btoa('a'.repeat(32)) }, db));
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toContain('too long');
  });

  it('returns 503 when APP_SECRET_KEK is not configured', async () => {
    const db = mockD1(
      mockStmt({ first: { creator_id: 'gh:1' } }),
    );
    const res = await app.request('/v1/apps/myapp/secrets/API_KEY', {
      method: 'PUT',
      headers: { Authorization: 'Bearer tok', 'Content-Type': 'application/json' },
      body: JSON.stringify({ value: 'some-value' }),
    }, makeEnv({}, db)); // no APP_SECRET_KEK
    expect(res.status).toBe(503);
  });

  it('returns 409 when app has reached the secrets cap', async () => {
    const db = mockD1(
      mockStmt({ first: { creator_id: 'gh:1' } }), // requireAppOwner
      mockStmt({ first: null }), // secret does not exist yet (new entry)
      mockStmt({ first: { n: 5 } }), // count = 5 (at the cap)
    );
    const res = await app.request('/v1/apps/myapp/secrets/NEW_KEY', {
      method: 'PUT',
      headers: { Authorization: 'Bearer tok', 'Content-Type': 'application/json' },
      body: JSON.stringify({ value: 'value' }),
    }, makeEnv({ APP_SECRET_KEK: btoa('a'.repeat(32)) }, db));
    expect(res.status).toBe(409);
  });
});

// DELETE /v1/apps/:appId/secrets/:name

describe('DELETE /v1/apps/:appId/secrets/:name', () => {
  it('returns 401 without auth', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(new Response('nope', { status: 401 }));
    const res = await app.request('/v1/apps/myapp/secrets/API_KEY', {
      method: 'DELETE',
      headers: { Authorization: 'Bearer bad' },
    }, makeEnv());
    expect(res.status).toBe(401);
  });

  it('returns 404 when secret does not exist', async () => {
    const db = mockD1(
      mockStmt({ first: { creator_id: 'gh:1' } }), // requireAppOwner
      mockStmt({ run: { meta: { changes: 0 } } }), // DELETE returns 0 changes
    );
    const res = await app.request('/v1/apps/myapp/secrets/MISSING_KEY', {
      method: 'DELETE',
      headers: { Authorization: 'Bearer tok' },
    }, makeEnv({}, db));
    expect(res.status).toBe(404);
  });

  it('returns 204 on successful delete', async () => {
    const db = mockD1(
      mockStmt({ first: { creator_id: 'gh:1' } }),
      mockStmt({ run: { meta: { changes: 1 } } }),
    );
    const res = await app.request('/v1/apps/myapp/secrets/OLD_KEY', {
      method: 'DELETE',
      headers: { Authorization: 'Bearer tok' },
    }, makeEnv({}, db));
    expect(res.status).toBe(204);
  });
});

// GET /v1/apps/:appId/allowlist

describe('GET /v1/apps/:appId/allowlist', () => {
  it('returns 403 when user is not the owner', async () => {
    const db = mockD1(mockStmt({ first: { creator_id: 'gh:99' } }));
    const res = await app.request('/v1/apps/myapp/allowlist', {
      headers: { Authorization: 'Bearer tok' },
    }, makeEnv({}, db));
    expect(res.status).toBe(403);
  });

  it('returns empty rules array for app owner', async () => {
    const db = mockD1(
      mockStmt({ first: { creator_id: 'gh:1' } }),
      mockStmt({ all: { results: [] } }),
    );
    const res = await app.request('/v1/apps/myapp/allowlist', {
      headers: { Authorization: 'Bearer tok' },
    }, makeEnv({}, db));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ rules: [] });
  });
});

// PUT /v1/apps/:appId/allowlist

describe('PUT /v1/apps/:appId/allowlist', () => {
  it('returns 400 when pattern does not start with https://', async () => {
    const db = mockD1(mockStmt({ first: { creator_id: 'gh:1' } }));
    const res = await app.request('/v1/apps/myapp/allowlist', {
      method: 'PUT',
      headers: { Authorization: 'Bearer tok', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        pattern: 'http://api.example.com',
        injectKind: 'header',
        injectName: 'X-Api-Key',
        secretName: 'API_KEY',
        methods: ['GET'],
      }),
    }, makeEnv({}, db));
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toContain('https://');
  });

  it('returns 400 for invalid injectKind', async () => {
    const db = mockD1(mockStmt({ first: { creator_id: 'gh:1' } }));
    const res = await app.request('/v1/apps/myapp/allowlist', {
      method: 'PUT',
      headers: { Authorization: 'Bearer tok', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        pattern: 'https://api.example.com',
        injectKind: 'magic', // invalid
        injectName: 'X-Api-Key',
        secretName: 'API_KEY',
        methods: ['GET'],
      }),
    }, makeEnv({}, db));
    expect(res.status).toBe(400);
  });

  it('returns 400 when referenced secret does not exist', async () => {
    const db = mockD1(
      mockStmt({ first: { creator_id: 'gh:1' } }), // requireAppOwner
      mockStmt({ first: null }), // secret lookup: not found
    );
    const res = await app.request('/v1/apps/myapp/allowlist', {
      method: 'PUT',
      headers: { Authorization: 'Bearer tok', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        pattern: 'https://api.example.com',
        injectKind: 'bearer',
        injectName: '',
        secretName: 'MISSING_KEY',
        methods: ['GET'],
      }),
    }, makeEnv({}, db));
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toContain('not found');
  });

  it('returns 400 when methods array is empty', async () => {
    const db = mockD1(mockStmt({ first: { creator_id: 'gh:1' } }));
    const res = await app.request('/v1/apps/myapp/allowlist', {
      method: 'PUT',
      headers: { Authorization: 'Bearer tok', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        pattern: 'https://api.example.com',
        injectKind: 'bearer',
        injectName: '',
        secretName: 'API_KEY',
        methods: [], // empty — invalid
      }),
    }, makeEnv({}, db));
    expect(res.status).toBe(400);
  });
});

// DELETE /v1/apps/:appId/allowlist

describe('DELETE /v1/apps/:appId/allowlist', () => {
  it('returns 400 when pattern is not provided', async () => {
    const db = mockD1(mockStmt({ first: { creator_id: 'gh:1' } }));
    const res = await app.request('/v1/apps/myapp/allowlist', {
      method: 'DELETE',
      headers: { Authorization: 'Bearer tok', 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    }, makeEnv({}, db));
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toContain('pattern is required');
  });

  it('returns 404 when rule does not exist', async () => {
    const db = mockD1(
      mockStmt({ first: { creator_id: 'gh:1' } }),
      mockStmt({ run: { meta: { changes: 0 } } }),
    );
    const res = await app.request('/v1/apps/myapp/allowlist', {
      method: 'DELETE',
      headers: { Authorization: 'Bearer tok', 'Content-Type': 'application/json' },
      body: JSON.stringify({ pattern: 'https://api.example.com' }),
    }, makeEnv({}, db));
    expect(res.status).toBe(404);
  });

  it('returns 204 on successful delete', async () => {
    const db = mockD1(
      mockStmt({ first: { creator_id: 'gh:1' } }),
      mockStmt({ run: { meta: { changes: 1 } } }),
    );
    const res = await app.request('/v1/apps/myapp/allowlist', {
      method: 'DELETE',
      headers: { Authorization: 'Bearer tok', 'Content-Type': 'application/json' },
      body: JSON.stringify({ pattern: 'https://api.example.com' }),
    }, makeEnv({}, db));
    expect(res.status).toBe(204);
  });
});
