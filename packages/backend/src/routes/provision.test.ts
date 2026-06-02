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
      return new Response(JSON.stringify({ id: 'gh:1', login: 'tester', avatarUrl: null, roles: ['admin'] }), { status: 200 });
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
        return new Response(JSON.stringify({ id: 'gh:1', login: 'tester', avatarUrl: null, roles: ['admin'] }), { status: 200 });
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

  it('calls correct CF API URLs with correct methods', async () => {
    const db = mockD1();
    const fetchSpy = multiFetch({
      'pages/projects': { status: 200, body: { success: true, result: {} } },
      'dns_records': { status: 200, body: { success: true, result: {} } },
      'domains': { status: 200, body: { success: true, result: {} } },
      'd1/database': { status: 200, body: { success: true, result: { uuid: 'db-1' } } },
    });
    globalThis.fetch = fetchSpy;

    await app.request('/v1/provision', {
      method: 'POST',
      headers: { Authorization: 'Bearer tok', 'Content-Type': 'application/json' },
      body: JSON.stringify({ appId: 'url-test', skipCompliance: true }),
    }, makeEnv({}, db));

    const calls = fetchSpy.mock.calls.map((c: any[]) => {
      const url = typeof c[0] === 'string' ? c[0] : c[0].url;
      return { url, method: c[1]?.method || 'GET' };
    });

    // Verify CF Pages project created with POST
    const pagesCall = calls.find((c: any) => c.url.includes('pages/projects') && !c.url.includes('domains'));
    expect(pagesCall).toBeDefined();
    expect(pagesCall!.method).toBe('POST');

    // Verify DNS CNAME created with POST to correct zone
    const dnsCall = calls.find((c: any) => c.url.includes('dns_records'));
    expect(dnsCall).toBeDefined();
    expect(dnsCall!.method).toBe('POST');
    expect(dnsCall!.url).toContain('14928daaff60902cc89003a2ebeb99fe');

    // Verify D1 created with POST
    const d1Call = calls.find((c: any) => c.url.includes('d1/database') && c.method === 'POST');
    expect(d1Call).toBeDefined();
  });

  it('inserts app record with correct creator ID', async () => {
    const appStmt = mockStmt();
    const db = mockD1(appStmt);
    globalThis.fetch = multiFetch();

    await app.request('/v1/provision', {
      method: 'POST',
      headers: { Authorization: 'Bearer tok', 'Content-Type': 'application/json' },
      body: JSON.stringify({ appId: 'record-test', skipCompliance: true, skipPublish: true }),
    }, makeEnv({}, db));

    // Verify DB.prepare was called for INSERT INTO apps
    const prepareCalls = db.prepare.mock.calls.map((c: any[]) => c[0]);
    const insertCall = prepareCalls.find((sql: string) => sql.includes('INSERT') && sql.includes('apps'));
    expect(insertCall).toBeDefined();

    // Verify bind was called with correct app ID and user ID
    expect(appStmt.bind).toHaveBeenCalled();
    const bindArgs = appStmt.bind.mock.calls[0];
    expect(bindArgs[0]).toBe('record-test');
    expect(bindArgs[1]).toBe('gh:1');
  });

  it('full flow verifies every step status is ok', async () => {
    const db = mockD1();
    globalThis.fetch = multiFetch({
      'pages/projects': { status: 200, body: { success: true, result: {} } },
      'dns_records': { status: 200, body: { success: true, result: {} } },
      'domains': { status: 200, body: { success: true, result: {} } },
      'd1/database': { status: 200, body: { success: true, result: { uuid: 'db-1' } } },
    });

    const res = await app.request('/v1/provision', {
      method: 'POST',
      headers: { Authorization: 'Bearer tok', 'Content-Type': 'application/json' },
      body: JSON.stringify({ appId: 'full-check', skipCompliance: true }),
    }, makeEnv({}, db));

    const data = await res.json() as { steps: { name: string; status: string }[] };
    const failed = data.steps.filter((s: any) => s.status === 'fail');
    expect(failed).toEqual([]);

    // Every expected step is present
    const names = data.steps.map((s: any) => s.name);
    expect(names).toEqual(expect.arrayContaining([
      'compliance', 'CF Pages project', 'DNS', 'custom domain',
      'create_d1', 'deploy_worker', 'record_app',
    ]));
  });
});

// Internal data-plane endpoint the Agent Teams deploy stage calls (service-to-
// service) so agent-built apps get the same D1 + data worker + app record a
// CLI-published app gets. Auth is INTERNAL_TOKEN, not a user session.
describe('POST /v1/provision-data (internal)', () => {
  it('403 without the internal token', async () => {
    globalThis.fetch = multiFetch();
    const res = await app.request('/v1/provision-data', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ appId: 'myapp', creatorId: 'gh:7' }),
    }, makeEnv({ INTERNAL_TOKEN: 'sekret' }));
    expect(res.status).toBe(403);
  });

  it('400 for invalid app ID', async () => {
    globalThis.fetch = multiFetch();
    const res = await app.request('/v1/provision-data', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Internal-Token': 'sekret' },
      body: JSON.stringify({ appId: 'Bad_ID', creatorId: 'gh:7' }),
    }, makeEnv({ INTERNAL_TOKEN: 'sekret' }));
    expect(res.status).toBe(400);
  });

  it('400 when creatorId missing', async () => {
    globalThis.fetch = multiFetch();
    const res = await app.request('/v1/provision-data', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Internal-Token': 'sekret' },
      body: JSON.stringify({ appId: 'myapp' }),
    }, makeEnv({ INTERNAL_TOKEN: 'sekret' }));
    expect(res.status).toBe(400);
  });

  it('provisions D1 + worker + app record (no Pages/DNS) and records the given creator', async () => {
    const appStmt = mockStmt();
    const db = mockD1(appStmt);
    globalThis.fetch = multiFetch({
      'd1/database': { status: 200, body: { success: true, result: { uuid: 'db-9' } } },
    });
    const res = await app.request('/v1/provision-data', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Internal-Token': 'sekret' },
      body: JSON.stringify({ appId: 'cleanup', creatorId: 'gh:42' }),
    }, makeEnv({ INTERNAL_TOKEN: 'sekret' }, db));

    expect(res.status).toBe(200);
    const data = await res.json() as { success: boolean; steps: { name: string }[] };
    expect(data.success).toBe(true);
    const names = data.steps.map((s) => s.name);
    expect(names).toEqual(expect.arrayContaining(['create_d1', 'deploy_worker', 'record_app']));
    // data-plane only — no hosting steps
    expect(names).not.toContain('CF Pages project');
    expect(names).not.toContain('DNS');
    // app record uses the creatorId we passed (not a session user)
    expect(appStmt.bind).toHaveBeenCalled();
    const bindArgs = appStmt.bind.mock.calls[0];
    expect(bindArgs[0]).toBe('cleanup');
    expect(bindArgs[1]).toBe('gh:42');
  });
});
