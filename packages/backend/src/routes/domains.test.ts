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
  return { prepare };
}

function makeEnv(opts: { db?: ReturnType<typeof mockD1> } = {}) {
  return {
    DB: (opts.db ?? mockD1()) as unknown as D1Database,
    STORAGE: { put: vi.fn() } as unknown as R2Bucket,
    STRIPE_SECRET_KEY: 'sk_test',
    STRIPE_WEBHOOK_SECRET: 'whsec_test',
    SESSION_SIGNING_KEY: TEST_SK,
    CF_API_TOKEN: 'cf_tok',
    CF_ACCOUNT_ID: 'cf_acct',
    VAPID_PUBLIC_KEY: 'p',
    VAPID_PRIVATE_KEY: 'q',
  };
}

const originalFetch = globalThis.fetch;
/** Mock fetch for CF Pages API calls. */
function mockFetchWithCf(cfResponses: Array<{ status: number; body: unknown }> = []) {
  const cfCalls: Array<{ method: string; url: string; body: unknown }> = [];
  const queue = [...cfResponses];
  return {
    cfCalls,
    install: () => {
      globalThis.fetch = vi.fn().mockImplementation(async (url: string | URL | Request, init?: RequestInit) => {
        const urlStr = typeof url === 'string' ? url : url instanceof URL ? url.toString() : url.url;
        if (urlStr.includes('api.cloudflare.com')) {
          let body: unknown = null;
          if (init?.body) try { body = JSON.parse(init.body as string); } catch {}
          cfCalls.push({ method: init?.method || 'GET', url: urlStr, body });
          const next = queue.shift();
          if (!next) return new Response(JSON.stringify({ success: true, result: {} }), { status: 200 });
          return new Response(JSON.stringify(next.body), { status: next.status });
        }
        return new Response('unexpected', { status: 500 });
      });
    },
  };
}

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
        app_id: 'meetup', domain: 'meetup.example.com', status: 'pending',
        cf_status: 'pending',
        cf_payload: JSON.stringify({
          verification_data: { status: 'pending' },
          validation_data: { method: 'txt', status: 'pending', txt_name: '_acme.meetup.example.com', txt_value: 'abc' },
        }),
        added_at: 1000, verified_at: null,
      },
    });
    const db = mockD1(ownerCheck, upsert, readBack);

    const mock = mockFetchWithCf([{
      status: 200,
      body: {
        success: true,
        result: {
          name: 'meetup.example.com', status: 'pending',
          verification_data: { status: 'pending' },
          validation_data: { method: 'txt', status: 'pending', txt_name: '_acme.meetup.example.com', txt_value: 'abc' },
        },
      },
    }]);
    mock.install();

    const res = await app.request('/v1/apps/meetup/domains', {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOK}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ domain: 'meetup.example.com' }),
    }, makeEnv({ db }));

    expect(res.status).toBe(201);
    const body = (await res.json()) as { domain: { domain: string; status: string; validationData: any } };
    expect(body.domain.domain).toBe('meetup.example.com');
    expect(body.domain.status).toBe('pending');
    expect(body.domain.validationData?.txt_name).toBe('_acme.meetup.example.com');
    // CF API was called with POST to pages/projects/proappstore-meetup/domains
    expect(mock.cfCalls[0]?.method).toBe('POST');
    expect(mock.cfCalls[0]?.url).toContain('proappstore-meetup/domains');
    expect(mock.cfCalls[0]?.body).toEqual({ name: 'meetup.example.com' });
  });

  it('rejects platform-managed domains', async () => {
    const ownerCheck = mockStmt({ first: { creator_id: 'gh:1' } });
    const db = mockD1(ownerCheck);
    const mock = mockFetchWithCf([]);
    mock.install();
    const res = await app.request('/v1/apps/meetup/domains', {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOK}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ domain: 'evil.proappstore.online' }),
    }, makeEnv({ db }));
    expect(res.status).toBe(400);
    expect(mock.cfCalls).toHaveLength(0);
  });

  it('rejects malformed hostnames', async () => {
    const ownerCheck = mockStmt({ first: { creator_id: 'gh:1' } });
    const db = mockD1(ownerCheck);
    const mock = mockFetchWithCf([]);
    mock.install();
    const res = await app.request('/v1/apps/meetup/domains', {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOK}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ domain: 'not a domain!!' }),
    }, makeEnv({ db }));
    expect(res.status).toBe(400);
    expect(mock.cfCalls).toHaveLength(0);
  });

  it('rejects non-string domain (e.g. {domain: 123})', async () => {
    const ownerCheck = mockStmt({ first: { creator_id: 'gh:1' } });
    const db = mockD1(ownerCheck);
    const mock = mockFetchWithCf([]);
    mock.install();
    const res = await app.request('/v1/apps/meetup/domains', {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOK}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ domain: 123 }),
    }, makeEnv({ db }));
    expect(res.status).toBe(400);
    expect(mock.cfCalls).toHaveLength(0);
  });

  it('rejects labels with leading or trailing hyphens', async () => {
    const mock = mockFetchWithCf([]);
    mock.install();
    for (const bad of ['foo.-bar.com', 'foo.bar-.com', '-foo.com', 'foo-.com']) {
      const res = await app.request('/v1/apps/meetup/domains', {
        method: 'POST',
        headers: { Authorization: `Bearer ${TOK}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ domain: bad }),
      }, makeEnv({ db: mockD1(mockStmt({ first: { creator_id: 'gh:1' } })) }));
      expect(res.status, `expected 400 for ${bad}`).toBe(400);
    }
    expect(mock.cfCalls).toHaveLength(0);
  });

  it('rejects IP addresses', async () => {
    const ownerCheck = mockStmt({ first: { creator_id: 'gh:1' } });
    const db = mockD1(ownerCheck);
    const mock = mockFetchWithCf([]);
    mock.install();
    const res = await app.request('/v1/apps/meetup/domains', {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOK}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ domain: '203.0.113.7' }),
    }, makeEnv({ db }));
    expect(res.status).toBe(400);
    expect(mock.cfCalls).toHaveLength(0);
  });

  it('403s when caller is not the app owner', async () => {
    const ownerCheck = mockStmt({ first: { creator_id: 'gh:somebody-else' } });
    const db = mockD1(ownerCheck);
    const mock = mockFetchWithCf([]);
    mock.install();
    const res = await app.request('/v1/apps/meetup/domains', {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOK}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ domain: 'meetup.example.com' }),
    }, makeEnv({ db }));
    expect(res.status).toBe(403);
    expect(mock.cfCalls).toHaveLength(0);
  });

  it('surfaces CF errors (e.g. domain already attached elsewhere)', async () => {
    const ownerCheck = mockStmt({ first: { creator_id: 'gh:1' } });
    const db = mockD1(ownerCheck);
    const mock = mockFetchWithCf([{
      status: 409,
      body: { success: false, errors: [{ code: 8000037, message: 'Domain is already attached to another project' }] },
    }]);
    mock.install();
    const res = await app.request('/v1/apps/meetup/domains', {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOK}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ domain: 'taken.example.com' }),
    }, makeEnv({ db }));
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
          { app_id: 'meetup', domain: 'meetup.example.com', status: 'active', cf_status: 'active', cf_payload: '{}', added_at: 1000, verified_at: 2000 },
          { app_id: 'meetup', domain: 'meetup.example.org', status: 'pending', cf_status: 'pending', cf_payload: '{"verification_data":{"txt_name":"_x","txt_value":"y"}}', added_at: 3000, verified_at: null },
        ],
      },
    });
    const db = mockD1(ownerCheck, list);
    const mock = mockFetchWithCf([]);
    mock.install();
    const res = await app.request('/v1/apps/meetup/domains', { headers: { Authorization: `Bearer ${TOK}` } }, makeEnv({ db }));
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
      first: { app_id: 'meetup', domain: 'meetup.example.com', status: 'active', cf_status: 'active', cf_payload: '{}', added_at: 1000, verified_at: 5000 },
    });
    const db = mockD1(ownerCheck, update, readBack);
    const mock = mockFetchWithCf([
      { status: 200, body: { success: true, result: { name: 'meetup.example.com', status: 'active' } } },
    ]);
    mock.install();
    const res = await app.request('/v1/apps/meetup/domains/meetup.example.com/verify', { method: 'POST', headers: { Authorization: `Bearer ${TOK}` } }, makeEnv({ db }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { domain: { status: string } };
    expect(body.domain.status).toBe('active');
    expect(mock.cfCalls[0]?.method).toBe('PATCH');
  });

  it('does NOT downgrade an active row when CF returns empty result', async () => {
    const ownerCheck = mockStmt({ first: { creator_id: 'gh:1' } });
    const readBack = mockStmt({
      first: { app_id: 'meetup', domain: 'meetup.example.com', status: 'active', cf_status: 'active', cf_payload: '{}', added_at: 1000, verified_at: 5000 },
    });
    const db = mockD1(ownerCheck, readBack);
    const mock = mockFetchWithCf([
      { status: 200, body: { success: true, result: null } },
    ]);
    mock.install();
    const res = await app.request('/v1/apps/meetup/domains/meetup.example.com/verify', { method: 'POST', headers: { Authorization: `Bearer ${TOK}` } }, makeEnv({ db }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { domain: { status: string } };
    expect(body.domain.status).toBe('active');
    expect(db.prepare).toHaveBeenCalledTimes(2);
  });

  it('reads CF Domain.status (not verification_status)', async () => {
    const ownerCheck = mockStmt({ first: { creator_id: 'gh:1' } });
    const update = mockStmt({ run: { meta: { changes: 1 } } });
    const readBack = mockStmt({
      first: { app_id: 'meetup', domain: 'meetup.example.com', status: 'active', cf_status: 'active', cf_payload: '{}', added_at: 1000, verified_at: 5000 },
    });
    const db = mockD1(ownerCheck, update, readBack);
    const mock = mockFetchWithCf([
      { status: 200, body: { success: true, result: { status: 'active' } } },
    ]);
    mock.install();
    const res = await app.request('/v1/apps/meetup/domains/meetup.example.com/verify', { method: 'POST', headers: { Authorization: `Bearer ${TOK}` } }, makeEnv({ db }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { domain: { status: string } };
    expect(body.domain.status).toBe('active');
  });
});

describe('DELETE /v1/apps/:appId/domains/:domain', () => {
  it('removes the row and calls CF DELETE', async () => {
    const ownerCheck = mockStmt({ first: { creator_id: 'gh:1' } });
    const del = mockStmt({ run: { meta: { changes: 1 } } });
    const db = mockD1(ownerCheck, del);
    const mock = mockFetchWithCf([{ status: 200, body: { success: true } }]);
    mock.install();
    const res = await app.request('/v1/apps/meetup/domains/meetup.example.com', { method: 'DELETE', headers: { Authorization: `Bearer ${TOK}` } }, makeEnv({ db }));
    expect(res.status).toBe(200);
    expect(mock.cfCalls[0]?.method).toBe('DELETE');
    expect(mock.cfCalls[0]?.url).toContain('proappstore-meetup/domains/meetup.example.com');
  });

  it('does NOT delete the DB row when CF returns 4xx', async () => {
    const ownerCheck = mockStmt({ first: { creator_id: 'gh:1' } });
    const del = mockStmt({ run: { meta: { changes: 1 } } });
    const db = mockD1(ownerCheck, del);
    const mock = mockFetchWithCf([
      { status: 403, body: { success: false, errors: [{ code: 0, message: 'Domain is locked' }] } },
    ]);
    mock.install();
    const res = await app.request('/v1/apps/meetup/domains/meetup.example.com', { method: 'DELETE', headers: { Authorization: `Bearer ${TOK}` } }, makeEnv({ db }));
    expect(res.status).toBe(403);
    expect(db.prepare).toHaveBeenCalledTimes(1);
  });

  it('rejects malformed :domain in the URL without calling CF', async () => {
    const ownerCheck = mockStmt({ first: { creator_id: 'gh:1' } });
    const db = mockD1(ownerCheck);
    const mock = mockFetchWithCf([]);
    mock.install();
    const res = await app.request('/v1/apps/meetup/domains/not-a-domain', { method: 'DELETE', headers: { Authorization: `Bearer ${TOK}` } }, makeEnv({ db }));
    expect(res.status).toBe(400);
    expect(mock.cfCalls).toHaveLength(0);
  });
});
