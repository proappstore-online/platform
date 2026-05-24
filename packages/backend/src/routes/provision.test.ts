import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { app } from '../index.js';

const originalFetch = globalThis.fetch;

function mockStmt(opts: { first?: unknown; all?: unknown; run?: unknown } = {}) {
  return {
    bind: vi.fn().mockReturnThis(),
    first: vi.fn().mockResolvedValue(opts.first ?? null),
    all: vi.fn().mockResolvedValue(opts.all ?? { results: [] }),
    run: vi.fn().mockResolvedValue(opts.run ?? { meta: { changes: 1 } }),
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

// Mock fetch that handles both FAS auth AND CF API calls
function multiFetch(cfResponses: Record<string, { status: number; body: unknown }> = {}) {
  return vi.fn().mockImplementation(async (url: string | URL | Request, init?: RequestInit) => {
    const urlStr = typeof url === 'string' ? url : url instanceof URL ? url.toString() : url.url;

    // FAS auth — any call to freeappstore.online returns a valid user
    if (urlStr.includes('freeappstore.online')) {
      return new Response(JSON.stringify({ id: 'gh:1', login: 'tester', avatarUrl: null }), { status: 200 });
    }

    // CF API — match by URL pattern
    for (const [pattern, resp] of Object.entries(cfResponses)) {
      if (urlStr.includes(pattern)) {
        return new Response(JSON.stringify(resp.body), { status: resp.status });
      }
    }

    // Default: success for any unmatched CF API call
    return new Response(JSON.stringify({ success: true, result: { uuid: 'test-uuid' } }), { status: 200 });
  });
}

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('POST /v1/provision', () => {
  it('returns 401 without auth', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(new Response('', { status: 401 }));
    const res = await app.request('/v1/provision', {
      method: 'POST',
      headers: { Authorization: 'Bearer bad', 'Content-Type': 'application/json' },
      body: JSON.stringify({ appId: 'test-app', skipCompliance: true, skipPublish: true }),
    }, makeEnv());
    expect(res.status).toBe(401);
  });

  it('returns 400 for invalid app ID', async () => {
    globalThis.fetch = multiFetch();
    const res = await app.request('/v1/provision', {
      method: 'POST',
      headers: { Authorization: 'Bearer tok', 'Content-Type': 'application/json' },
      body: JSON.stringify({ appId: 'INVALID', skipCompliance: true, skipPublish: true }),
    }, makeEnv());
    expect(res.status).toBe(400);
  });

  it('returns 400 for empty app ID', async () => {
    globalThis.fetch = multiFetch();
    const res = await app.request('/v1/provision', {
      method: 'POST',
      headers: { Authorization: 'Bearer tok', 'Content-Type': 'application/json' },
      body: JSON.stringify({ appId: '', skipCompliance: true }),
    }, makeEnv());
    expect(res.status).toBe(400);
  });

  it('returns 503 when CF credentials missing', async () => {
    globalThis.fetch = multiFetch();
    const res = await app.request('/v1/provision', {
      method: 'POST',
      headers: { Authorization: 'Bearer tok', 'Content-Type': 'application/json' },
      body: JSON.stringify({ appId: 'test-app', skipCompliance: true }),
    }, makeEnv({ CF_API_TOKEN: '', CF_ACCOUNT_ID: '' }));
    expect(res.status).toBe(503);
  });

  it('provisions with skipPublish + skipCompliance (D1 + worker + app record only)', async () => {
    const db = mockD1();
    globalThis.fetch = multiFetch();
    const res = await app.request('/v1/provision', {
      method: 'POST',
      headers: { Authorization: 'Bearer tok', 'Content-Type': 'application/json' },
      body: JSON.stringify({ appId: 'test-app', skipCompliance: true, skipPublish: true }),
    }, makeEnv({}, db));

    expect(res.status).toBe(200);
    const data = await res.json() as { success: boolean; steps: { name: string; status: string }[] };
    expect(data.success).toBe(true);

    const stepNames = data.steps.map((s: any) => s.name);
    expect(stepNames).toContain('compliance');
    expect(stepNames).toContain('create_d1');
    expect(stepNames).toContain('record_app');
    // No Pages/DNS steps when skipPublish
    expect(stepNames).not.toContain('CF Pages project');
    expect(stepNames).not.toContain('DNS');
  });

  it('provisions full flow (Pages + DNS + custom domain + D1 + worker + record)', async () => {
    const db = mockD1();
    globalThis.fetch = multiFetch({
      'pages/projects': { status: 200, body: { success: true, result: { subdomain: 'proappstore-myapp.pages.dev' } } },
      'dns_records': { status: 200, body: { success: true, result: { id: 'dns-1' } } },
      'domains': { status: 200, body: { success: true, result: { name: 'myapp.proappstore.online' } } },
      'd1/database': { status: 200, body: { success: true, result: { uuid: 'db-uuid-123' } } },
    });
    const res = await app.request('/v1/provision', {
      method: 'POST',
      headers: { Authorization: 'Bearer tok', 'Content-Type': 'application/json' },
      body: JSON.stringify({ appId: 'myapp', skipCompliance: true }),
    }, makeEnv({}, db));

    const data = await res.json() as { success: boolean; steps: { name: string; status: string }[]; pagesUrl: string };
    expect(data.success).toBe(true);
    expect(data.pagesUrl).toBe('https://proappstore-myapp.pages.dev');

    const stepNames = data.steps.map((s: any) => s.name);
    expect(stepNames).toContain('CF Pages project');
    expect(stepNames).toContain('DNS');
    expect(stepNames).toContain('custom domain');
    expect(stepNames).toContain('create_d1');
    expect(stepNames).toContain('record_app');
  });

  it('handles CF Pages already exists (idempotent)', async () => {
    const db = mockD1();
    globalThis.fetch = multiFetch({
      'pages/projects': { status: 200, body: { success: false, errors: [{ message: 'A project with this name already exists' }] } },
    });
    const res = await app.request('/v1/provision', {
      method: 'POST',
      headers: { Authorization: 'Bearer tok', 'Content-Type': 'application/json' },
      body: JSON.stringify({ appId: 'existing-app', skipCompliance: true }),
    }, makeEnv({}, db));

    const data = await res.json() as { steps: { name: string; status: string }[] };
    const pagesStep = data.steps.find((s: any) => s.name === 'CF Pages project');
    expect(pagesStep?.status).toBe('skip');
  });

  it('handles DNS CNAME already exists (idempotent)', async () => {
    const db = mockD1();
    globalThis.fetch = multiFetch({
      'pages/projects': { status: 200, body: { success: true, result: {} } },
      'dns_records': { status: 200, body: { success: false, errors: [{ message: 'already exists', code: 81057 }] } },
    });
    const res = await app.request('/v1/provision', {
      method: 'POST',
      headers: { Authorization: 'Bearer tok', 'Content-Type': 'application/json' },
      body: JSON.stringify({ appId: 'existing-dns', skipCompliance: true }),
    }, makeEnv({}, db));

    const data = await res.json() as { steps: { name: string; status: string }[] };
    const dnsStep = data.steps.find((s: any) => s.name === 'DNS');
    expect(dnsStep?.status).toBe('skip');
  });

  it('handles D1 already exists (idempotent)', async () => {
    const db = mockD1();
    let d1CallCount = 0;
    globalThis.fetch = vi.fn().mockImplementation(async (url: string | URL | Request, init?: RequestInit) => {
      const urlStr = typeof url === 'string' ? url : url instanceof URL ? url.toString() : url.url;
      const method = init?.method || 'GET';
      if (urlStr.includes('freeappstore.online')) {
        return new Response(JSON.stringify({ id: 'gh:1', login: 'tester', avatarUrl: null }), { status: 200 });
      }
      if (urlStr.includes('d1/database') && method === 'POST') {
        return new Response(JSON.stringify({ success: false, errors: [{ message: 'already exists' }] }), { status: 200 });
      }
      if (urlStr.includes('d1/database') && urlStr.includes('name=')) {
        return new Response(JSON.stringify({ result: [{ uuid: 'existing-db-id', name: 'pas-data-myapp' }] }), { status: 200 });
      }
      return new Response(JSON.stringify({ success: true, result: { uuid: 'test' } }), { status: 200 });
    });
    const res = await app.request('/v1/provision', {
      method: 'POST',
      headers: { Authorization: 'Bearer tok', 'Content-Type': 'application/json' },
      body: JSON.stringify({ appId: 'myapp', skipCompliance: true, skipPublish: true }),
    }, makeEnv({}, db));

    const data = await res.json() as { steps: { name: string; status: string; detail: string }[] };
    const d1Step = data.steps.find((s: any) => s.name === 'create_d1');
    expect(d1Step?.status).toBe('skip');
    expect(d1Step?.detail).toContain('existing-db-id');
  });

  it('returns 207 when some steps fail', async () => {
    const db = mockD1();
    globalThis.fetch = multiFetch({
      'pages/projects': { status: 200, body: { success: false, errors: [{ message: 'quota exceeded' }] } },
    });
    const res = await app.request('/v1/provision', {
      method: 'POST',
      headers: { Authorization: 'Bearer tok', 'Content-Type': 'application/json' },
      body: JSON.stringify({ appId: 'fail-app', skipCompliance: true }),
    }, makeEnv({}, db));

    expect(res.status).toBe(207);
    const data = await res.json() as { success: boolean };
    expect(data.success).toBe(false);
  });

  it('rejects app IDs with uppercase', async () => {
    globalThis.fetch = multiFetch();
    const res = await app.request('/v1/provision', {
      method: 'POST',
      headers: { Authorization: 'Bearer tok', 'Content-Type': 'application/json' },
      body: JSON.stringify({ appId: 'MyApp', skipCompliance: true }),
    }, makeEnv());
    expect(res.status).toBe(400);
  });

  it('rejects app IDs over 58 chars', async () => {
    globalThis.fetch = multiFetch();
    const res = await app.request('/v1/provision', {
      method: 'POST',
      headers: { Authorization: 'Bearer tok', 'Content-Type': 'application/json' },
      body: JSON.stringify({ appId: 'a'.repeat(59), skipCompliance: true }),
    }, makeEnv());
    expect(res.status).toBe(400);
  });
});
