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

/** Mocks the ADMIN service binding. Calls record (method, path, body); responses
 *  are pulled from a FIFO queue. Unmatched calls return 500 so tests fail loudly. */
function mockAdmin(responses: Array<{ status: number; body: unknown }>) {
  const calls: Array<{ method: string; path: string; body: unknown }> = [];
  const queue = [...responses];
  const fetcher = {
    fetch: vi.fn(async (urlOrReq: string | Request, init?: RequestInit) => {
      const url = typeof urlOrReq === 'string' ? urlOrReq : urlOrReq.url;
      const path = new URL(url).pathname;
      const method = init?.method || 'GET';
      let body: unknown = null;
      if (init?.body) {
        try {
          body = JSON.parse(init.body as string);
        } catch {
          body = init.body;
        }
      }
      calls.push({ method, path, body });
      const next = queue.shift();
      if (!next) return new Response('{"error":"unexpected admin call"}', { status: 500 });
      return new Response(JSON.stringify(next.body), { status: next.status });
    }),
  };
  return { fetcher: fetcher as unknown as Fetcher, calls };
}

function makeEnv(opts: {
  db?: ReturnType<typeof mockD1>;
  admin?: Fetcher;
} = {}) {
  return {
    DB: (opts.db ?? mockD1()) as unknown as D1Database,
    STORAGE: { put: vi.fn() } as unknown as R2Bucket,
    STRIPE_SECRET_KEY: 'sk_test',
    STRIPE_WEBHOOK_SECRET: 'whsec_test',
    SESSION_SIGNING_KEY: 'sign_key',
    FAS_API_BASE: 'https://api.freeappstore.online',
    CF_API_TOKEN: 'cf_tok',
    CF_ACCOUNT_ID: 'cf_acct',
    VAPID_PUBLIC_KEY: 'p',
    VAPID_PRIVATE_KEY: 'q',
    ADMIN: opts.admin,
  };
}

function mockUserAuth(user = { id: 'gh:1', login: 'testuser' }) {
  globalThis.fetch = vi.fn().mockResolvedValue(
    new Response(JSON.stringify({ id: user.id, login: user.login, avatarUrl: null }), { status: 200 }),
  );
}

beforeEach(() => mockUserAuth());
afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe('POST /v1/apps/:appId/domains', () => {
  it('attaches a valid domain and persists pending state', async () => {
    const ownerCheck = mockStmt({ first: { creator_id: 'gh:1' } });
    const upsert = mockStmt({ run: { meta: { changes: 1 } } });
    const readBack = mockStmt({
      first: {
        app_id: 'meetup',
        domain: 'meetup.example.com',
        status: 'pending',
        cf_status: 'pending',
        cf_payload: JSON.stringify({
          verification_data: { status: 'pending' },
          validation_data: { method: 'txt', status: 'pending', txt_name: '_acme.meetup.example.com', txt_value: 'abc' },
        }),
        added_at: 1000,
        verified_at: null,
      },
    });
    const db = mockD1(ownerCheck, upsert, readBack);

    const admin = mockAdmin([
      {
        status: 200,
        body: {
          success: true,
          result: {
            name: 'meetup.example.com',
            status: 'pending',
            verification_data: { status: 'pending' },
            validation_data: { method: 'txt', status: 'pending', txt_name: '_acme.meetup.example.com', txt_value: 'abc' },
          },
        },
      },
    ]);

    const res = await app.request(
      '/v1/apps/meetup/domains',
      {
        method: 'POST',
        headers: { Authorization: 'Bearer t', 'Content-Type': 'application/json' },
        body: JSON.stringify({ domain: 'meetup.example.com' }),
      },
      makeEnv({ db, admin: admin.fetcher }),
    );

    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      domain: { domain: string; status: string; verificationData: unknown; validationData: any };
    };
    expect(body.domain.domain).toBe('meetup.example.com');
    expect(body.domain.status).toBe('pending');
    expect(body.domain.validationData?.txt_name).toBe('_acme.meetup.example.com');
    // Admin was called with the project-named path.
    expect(admin.calls[0]?.path).toBe('/api/apps/proappstore-meetup/domains');
    expect(admin.calls[0]?.method).toBe('POST');
    expect(admin.calls[0]?.body).toEqual({ name: 'meetup.example.com' });
  });

  it('rejects platform-managed domains', async () => {
    const ownerCheck = mockStmt({ first: { creator_id: 'gh:1' } });
    const db = mockD1(ownerCheck);
    const admin = mockAdmin([]);
    const res = await app.request(
      '/v1/apps/meetup/domains',
      {
        method: 'POST',
        headers: { Authorization: 'Bearer t', 'Content-Type': 'application/json' },
        body: JSON.stringify({ domain: 'evil.proappstore.online' }),
      },
      makeEnv({ db, admin: admin.fetcher }),
    );
    expect(res.status).toBe(400);
    expect(admin.calls).toHaveLength(0);
  });

  it('rejects malformed hostnames', async () => {
    const ownerCheck = mockStmt({ first: { creator_id: 'gh:1' } });
    const db = mockD1(ownerCheck);
    const admin = mockAdmin([]);
    const res = await app.request(
      '/v1/apps/meetup/domains',
      {
        method: 'POST',
        headers: { Authorization: 'Bearer t', 'Content-Type': 'application/json' },
        body: JSON.stringify({ domain: 'not a domain!!' }),
      },
      makeEnv({ db, admin: admin.fetcher }),
    );
    expect(res.status).toBe(400);
    expect(admin.calls).toHaveLength(0);
  });

  it('rejects IP addresses', async () => {
    const ownerCheck = mockStmt({ first: { creator_id: 'gh:1' } });
    const db = mockD1(ownerCheck);
    const admin = mockAdmin([]);
    const res = await app.request(
      '/v1/apps/meetup/domains',
      {
        method: 'POST',
        headers: { Authorization: 'Bearer t', 'Content-Type': 'application/json' },
        body: JSON.stringify({ domain: '203.0.113.7' }),
      },
      makeEnv({ db, admin: admin.fetcher }),
    );
    expect(res.status).toBe(400);
    expect(admin.calls).toHaveLength(0);
  });

  it('403s when caller is not the app owner', async () => {
    // requireAppOwner: row exists but creator_id is someone else.
    const ownerCheck = mockStmt({ first: { creator_id: 'gh:somebody-else' } });
    const db = mockD1(ownerCheck);
    const admin = mockAdmin([]);
    const res = await app.request(
      '/v1/apps/meetup/domains',
      {
        method: 'POST',
        headers: { Authorization: 'Bearer t', 'Content-Type': 'application/json' },
        body: JSON.stringify({ domain: 'meetup.example.com' }),
      },
      makeEnv({ db, admin: admin.fetcher }),
    );
    expect(res.status).toBe(403);
    expect(admin.calls).toHaveLength(0);
  });

  it('surfaces CF errors (e.g. domain already attached elsewhere)', async () => {
    const ownerCheck = mockStmt({ first: { creator_id: 'gh:1' } });
    const db = mockD1(ownerCheck);
    const admin = mockAdmin([
      {
        status: 409,
        body: { success: false, errors: [{ code: 8000037, message: 'Domain is already attached to another project' }] },
      },
    ]);
    const res = await app.request(
      '/v1/apps/meetup/domains',
      {
        method: 'POST',
        headers: { Authorization: 'Bearer t', 'Content-Type': 'application/json' },
        body: JSON.stringify({ domain: 'taken.example.com' }),
      },
      makeEnv({ db, admin: admin.fetcher }),
    );
    expect(res.status).toBe(409);
    const text = await res.text();
    expect(text).toContain('already attached');
  });
});

describe('GET /v1/apps/:appId/domains', () => {
  it('returns all attached domains', async () => {
    const ownerCheck = mockStmt({ first: { creator_id: 'gh:1' } });
    const list = mockStmt({
      all: {
        results: [
          {
            app_id: 'meetup',
            domain: 'meetup.example.com',
            status: 'active',
            cf_status: 'active',
            cf_payload: '{}',
            added_at: 1000,
            verified_at: 2000,
          },
          {
            app_id: 'meetup',
            domain: 'meetup.example.org',
            status: 'pending',
            cf_status: 'pending',
            cf_payload: '{"verification_data":{"txt_name":"_x","txt_value":"y"}}',
            added_at: 3000,
            verified_at: null,
          },
        ],
      },
    });
    const db = mockD1(ownerCheck, list);
    const res = await app.request('/v1/apps/meetup/domains', { headers: { Authorization: 'Bearer t' } }, makeEnv({ db }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { domains: Array<{ domain: string; status: string }> };
    expect(body.domains).toHaveLength(2);
    expect(body.domains[0]?.status).toBe('active');
    expect(body.domains[1]?.status).toBe('pending');
  });
});

describe('POST /v1/apps/:appId/domains/:domain/verify', () => {
  it('re-checks CF and flips status to active', async () => {
    const ownerCheck = mockStmt({ first: { creator_id: 'gh:1' } });
    const update = mockStmt({ run: { meta: { changes: 1 } } });
    const readBack = mockStmt({
      first: {
        app_id: 'meetup',
        domain: 'meetup.example.com',
        status: 'active',
        cf_status: 'active',
        cf_payload: '{}',
        added_at: 1000,
        verified_at: 5000,
      },
    });
    const db = mockD1(ownerCheck, update, readBack);
    const admin = mockAdmin([
      // PATCH returns the latest Domain object — no follow-up GET needed.
      { status: 200, body: { success: true, result: { name: 'meetup.example.com', status: 'active' } } },
    ]);
    const res = await app.request(
      '/v1/apps/meetup/domains/meetup.example.com/verify',
      { method: 'POST', headers: { Authorization: 'Bearer t' } },
      makeEnv({ db, admin: admin.fetcher }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { domain: { status: string } };
    expect(body.domain.status).toBe('active');
    expect(admin.calls.map((c) => c.method)).toEqual(['PATCH']);
  });

  // Regression for the field-name bug: CF Pages returns `status`, not
  // `verification_status`. Earlier code read the wrong field, so domains
  // never flipped from pending → active.
  it('reads CF Domain.status (not verification_status)', async () => {
    const ownerCheck = mockStmt({ first: { creator_id: 'gh:1' } });
    const update = mockStmt({ run: { meta: { changes: 1 } } });
    const readBack = mockStmt({
      first: {
        app_id: 'meetup',
        domain: 'meetup.example.com',
        status: 'active',
        cf_status: 'active',
        cf_payload: '{}',
        added_at: 1000,
        verified_at: 5000,
      },
    });
    const db = mockD1(ownerCheck, update, readBack);
    const admin = mockAdmin([
      { status: 200, body: { success: true, result: { status: 'active' } } },
    ]);
    const res = await app.request(
      '/v1/apps/meetup/domains/meetup.example.com/verify',
      { method: 'POST', headers: { Authorization: 'Bearer t' } },
      makeEnv({ db, admin: admin.fetcher }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { domain: { status: string } };
    expect(body.domain.status).toBe('active');
  });
});

describe('DELETE /v1/apps/:appId/domains/:domain', () => {
  it('removes the row and calls admin DELETE', async () => {
    const ownerCheck = mockStmt({ first: { creator_id: 'gh:1' } });
    const del = mockStmt({ run: { meta: { changes: 1 } } });
    const db = mockD1(ownerCheck, del);
    const admin = mockAdmin([{ status: 200, body: { success: true } }]);
    const res = await app.request(
      '/v1/apps/meetup/domains/meetup.example.com',
      { method: 'DELETE', headers: { Authorization: 'Bearer t' } },
      makeEnv({ db, admin: admin.fetcher }),
    );
    expect(res.status).toBe(200);
    expect(admin.calls[0]?.method).toBe('DELETE');
    expect(admin.calls[0]?.path).toBe('/api/apps/proappstore-meetup/domains/meetup.example.com');
  });
});
