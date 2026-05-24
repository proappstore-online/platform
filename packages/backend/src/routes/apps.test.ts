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
  return { prepare };
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
    new Response(JSON.stringify({ id, login: 'tester', avatarUrl: null }), { status: 200 }),
  );
}

beforeEach(() => {
  globalThis.fetch = asUser();
});
afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('GET /v1/apps', () => {
  it('returns 401 without auth', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(new Response('', { status: 401 }));
    const res = await app.request(
      '/v1/apps',
      { headers: { Authorization: 'Bearer bad' } },
      makeEnv(),
    );
    expect(res.status).toBe(401);
  });

  it('returns empty apps array when no apps exist', async () => {
    const appsStmt = mockStmt({ all: { results: [] } });
    const db = mockD1(appsStmt);
    const res = await app.request(
      '/v1/apps',
      { headers: { Authorization: 'Bearer tok' } },
      makeEnv({}, db),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ apps: [] });
  });

  it('returns apps enriched with title-cased name when no submission exists', async () => {
    const appsStmt = mockStmt({
      all: {
        results: [
          { id: 'my-cool-app', creator_id: 'gh:1', d1_database_id: 'db1', created_at: 1000 },
        ],
      },
    });
    // submissions query returns nothing
    const subsStmt = mockStmt({ all: { results: [] } });
    const db = mockD1(appsStmt, subsStmt);
    const res = await app.request(
      '/v1/apps',
      { headers: { Authorization: 'Bearer tok' } },
      makeEnv({}, db),
    );
    expect(res.status).toBe(200);
    const body = await res.json() as { apps: { name: string; has_submission: boolean }[] };
    expect(body.apps[0].name).toBe('My Cool App');
    expect(body.apps[0].has_submission).toBe(false);
  });

  it('returns apps enriched with submission metadata when a submission exists', async () => {
    const appsStmt = mockStmt({
      all: {
        results: [
          { id: 'some-app', creator_id: 'gh:1', d1_database_id: 'db1', created_at: 1000 },
        ],
      },
    });
    const subsStmt = mockStmt({
      all: {
        results: [
          {
            app_id: 'some-app',
            name: 'Some App',
            category: 'productivity',
            description: 'Does things',
            icon: null,
            icon_bg: null,
            pro_features: '["rooms"]',
            status: 'approved',
            suggested_monthly_price_cents: 900,
            created_at: 2000,
          },
        ],
      },
    });
    const db = mockD1(appsStmt, subsStmt);
    const res = await app.request(
      '/v1/apps',
      { headers: { Authorization: 'Bearer tok' } },
      makeEnv({}, db),
    );
    expect(res.status).toBe(200);
    const body = await res.json() as { apps: Record<string, unknown>[] };
    const a = body.apps[0];
    expect(a.name).toBe('Some App');
    expect(a.category).toBe('productivity');
    expect(a.pro_features).toEqual(['rooms']);
    expect(a.has_submission).toBe(true);
    expect(a.submission_status).toBe('approved');
  });

  it('does not expose other creators apps to regular users', async () => {
    // The route filters by creator_id; we trust DB does the filtering.
    // Verify the query is bound with the user id by checking the call went through.
    const appsStmt = mockStmt({ all: { results: [] } });
    const db = mockD1(appsStmt);
    await app.request(
      '/v1/apps',
      { headers: { Authorization: 'Bearer tok' } },
      makeEnv({}, db),
    );
    // prepare was called once for apps query; bind was called with creator id
    expect(db.prepare).toHaveBeenCalledWith(
      expect.stringContaining('WHERE creator_id = ?'),
    );
    expect(appsStmt.bind).toHaveBeenCalledWith('gh:1');
  });

  it('admin with ?all=true fetches all apps without a creator filter', async () => {
    globalThis.fetch = asUser('gh:99');
    const appsStmt = mockStmt({ all: { results: [] } });
    const db = mockD1(appsStmt);
    const res = await app.request(
      '/v1/apps?all=true',
      { headers: { Authorization: 'Bearer tok' } },
      makeEnv({ ADMIN_GITHUB_IDS: 'gh:99' }, db),
    );
    expect(res.status).toBe(200);
    // The admin path uses a query without WHERE creator_id
    expect(db.prepare).toHaveBeenCalledWith(
      expect.stringContaining('SELECT * FROM apps ORDER BY created_at DESC'),
    );
  });

  it('non-admin requesting ?all=true still only sees own apps', async () => {
    const appsStmt = mockStmt({ all: { results: [] } });
    const db = mockD1(appsStmt);
    await app.request(
      '/v1/apps?all=true',
      { headers: { Authorization: 'Bearer tok' } },
      makeEnv({ ADMIN_GITHUB_IDS: 'gh:other' }, db),
    );
    expect(db.prepare).toHaveBeenCalledWith(
      expect.stringContaining('WHERE creator_id = ?'),
    );
  });
});

describe('DELETE /v1/apps/:id', () => {
  it('returns 401 without auth', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(new Response('', { status: 401 }));
    const res = await app.request(
      '/v1/apps/myapp',
      { method: 'DELETE', headers: { Authorization: 'Bearer bad' } },
      makeEnv(),
    );
    expect(res.status).toBe(401);
  });

  it('returns 404 when app does not exist', async () => {
    const lookupStmt = mockStmt({ first: null });
    const db = mockD1(lookupStmt);
    const res = await app.request(
      '/v1/apps/ghost-app',
      { method: 'DELETE', headers: { Authorization: 'Bearer tok' } },
      makeEnv({}, db),
    );
    expect(res.status).toBe(404);
  });

  it('returns 403 when caller does not own the app', async () => {
    const lookupStmt = mockStmt({ first: { creator_id: 'gh:other' } });
    const db = mockD1(lookupStmt);
    const res = await app.request(
      '/v1/apps/someapp',
      { method: 'DELETE', headers: { Authorization: 'Bearer tok' } },
      makeEnv({}, db),
    );
    expect(res.status).toBe(403);
  });

  it('deletes the app row and returns ok when caller is the owner', async () => {
    const lookupStmt = mockStmt({ first: { creator_id: 'gh:1' } });
    const deleteStmt = mockStmt({ run: { meta: { changes: 1 } } });
    const db = mockD1(lookupStmt, deleteStmt);
    const res = await app.request(
      '/v1/apps/myapp',
      { method: 'DELETE', headers: { Authorization: 'Bearer tok' } },
      makeEnv({}, db),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it('allows admin to delete any app', async () => {
    globalThis.fetch = asUser('gh:admin');
    const lookupStmt = mockStmt({ first: { creator_id: 'gh:other' } });
    const deleteStmt = mockStmt({ run: { meta: { changes: 1 } } });
    const db = mockD1(lookupStmt, deleteStmt);
    const res = await app.request(
      '/v1/apps/anyapp',
      { method: 'DELETE', headers: { Authorization: 'Bearer tok' } },
      makeEnv({ ADMIN_GITHUB_IDS: 'gh:admin' }, db),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });
});
