import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { app } from '../index.js';
import { testToken, TEST_SK, makeEnv as sharedMakeEnv } from '../test-helpers.js';

const TOK = await testToken('gh:1', { roles: ['user', 'admin'] });
/** #82: the ownership guard lets platform admins through, so the cross-tenant
 *  cases need a caller who is NOT one. */
const NON_ADMIN_TOK = await testToken('gh:2', { roles: ['user'] });

function mockStmt(opts: { first?: unknown; all?: unknown; run?: unknown } = {}) {
  return {
    bind: vi.fn().mockReturnThis(),
    first: vi.fn().mockResolvedValue(opts.first ?? null),
    all: vi.fn().mockResolvedValue(opts.all ?? { results: [] }),
    run: vi.fn().mockResolvedValue(opts.run ?? { meta: { changes: 1 } }),
  };
}

function mockD1(...stmts: ReturnType<typeof mockStmt>[]) {
  return mockD1Claimed(null, ...stmts);
}

/**
 * @param claimedBy creator_id already holding the appId, or null for unclaimed.
 *
 * The ownership guard (#82) and the creator-existence guard (#81) are answered
 * by SQL shape rather than by consuming a positional slot: they run before the
 * statements these tests actually describe, and threading them through every
 * sequence would bury what each case is about.
 */
function mockD1Claimed(claimedBy: string | null, ...stmts: ReturnType<typeof mockStmt>[]) {
  const prepare = vi.fn();
  const queue = [...stmts];
  prepare.mockImplementation((sql: string) => {
    if (/SELECT creator_id FROM apps\b/i.test(sql)) {
      return mockStmt({ first: claimedBy ? { creator_id: claimedBy } : null });
    }
    if (/FROM users\b/i.test(sql)) return mockStmt({ first: { 1: 1 } });
    // #83 provisioning rate limit — answered out-of-band as "no attempts yet",
    // for the same reason as the guards above: it runs before the statements
    // these tests describe, and threading it through each sequence would bury
    // what they are about. Rate-limit behaviour is covered in build-core.
    if (/provision_attempts/i.test(sql)) return mockStmt({ first: null });
    return queue.length ? queue.shift()! : mockStmt();
  });
  return { prepare };
}

function makeEnv(overrides: Record<string, unknown> = {}, db?: ReturnType<typeof mockD1>) {
  return sharedMakeEnv(overrides, db ?? mockD1());
}

// Mock fetch for CF API calls (auth is local — no fetch needed)
function multiFetch(cfResponses: Record<string, { status: number; body: unknown }> = {}) {
  return vi.fn().mockImplementation(async (url: string | URL | Request) => {
    const urlStr = typeof url === 'string' ? url : url instanceof URL ? url.toString() : url.url;
    for (const [pattern, resp] of Object.entries(cfResponses)) {
      if (urlStr.includes(pattern)) {
        return new Response(JSON.stringify(resp.body), { status: resp.status });
      }
    }
    if (urlStr.includes('/zones?name=proappstore.online')) {
      return new Response(JSON.stringify({ success: true, result: [{ id: 'zone-1' }] }), { status: 200 });
    }
    if (urlStr.includes('/workers/domains')) {
      return new Response(JSON.stringify({ success: true, result: {} }), { status: 200 });
    }
    return new Response(JSON.stringify({ success: true, result: { uuid: 'test-uuid' } }), { status: 200 });
  });
}

describe('POST /v1/provision', () => {
  it('returns 401 without auth', async () => {
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
      headers: { Authorization: `Bearer ${TOK}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ appId: 'INVALID', skipCompliance: true, skipPublish: true }),
    }, makeEnv());
    expect(res.status).toBe(400);
  });

  it('returns 400 for empty app ID', async () => {
    globalThis.fetch = multiFetch();
    const res = await app.request('/v1/provision', {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOK}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ appId: '', skipCompliance: true }),
    }, makeEnv());
    expect(res.status).toBe(400);
  });

  it('returns 503 when CF credentials missing', async () => {
    globalThis.fetch = multiFetch();
    const res = await app.request('/v1/provision', {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOK}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ appId: 'test-app', skipCompliance: true }),
    }, makeEnv({ CF_API_TOKEN: '', CF_ACCOUNT_ID: '' }));
    expect(res.status).toBe(503);
  });

  it('provisions with skipPublish + skipCompliance (D1 + worker + app record only)', async () => {
    const db = mockD1();
    globalThis.fetch = multiFetch();
    const res = await app.request('/v1/provision', {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOK}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ appId: 'test-app', skipCompliance: true, skipPublish: true }),
    }, makeEnv({}, db));

    expect(res.status).toBe(200);
    const data = await res.json() as { success: boolean; steps: { name: string; status: string }[] };
    expect(data.success).toBe(true);

    const stepNames = data.steps.map((s: any) => s.name);
    expect(stepNames).toContain('compliance');
    expect(stepNames).toContain('create_d1');
    expect(stepNames).toContain('record_app');
    // No route step when skipPublish
    expect(stepNames).not.toContain('route');
  });

  it('provisions full flow (R2 route + D1 + worker + record)', async () => {
    const db = mockD1();
    globalThis.fetch = multiFetch({
      'd1/database': { status: 200, body: { success: true, result: { uuid: 'db-uuid-123' } } },
    });
    const res = await app.request('/v1/provision', {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOK}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ appId: 'myapp', skipCompliance: true }),
    }, makeEnv({}, db));

    const data = await res.json() as { success: boolean; steps: { name: string; status: string }[]; appUrl: string };
    expect(data.success).toBe(true);
    expect(data.appUrl).toBe('https://myapp.proappstore.online');

    const stepNames = data.steps.map((s: any) => s.name);
    expect(stepNames).toContain('route');
    expect(stepNames).toContain('create_d1');
    expect(stepNames).toContain('record_app');
    // No Pages/DNS steps
    expect(stepNames).not.toContain('CF Pages project');
    expect(stepNames).not.toContain('DNS');
  });

  it('handles D1 already exists (idempotent)', async () => {
    const db = mockD1();
    let d1CallCount = 0;
    globalThis.fetch = vi.fn().mockImplementation(async (url: string | URL | Request, init?: RequestInit) => {
      const urlStr = typeof url === 'string' ? url : url instanceof URL ? url.toString() : url.url;
      const method = init?.method || 'GET';
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
      headers: { Authorization: `Bearer ${TOK}`, 'Content-Type': 'application/json' },
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
      'd1/database': { status: 200, body: { success: false, errors: [{ message: 'quota exceeded' }] } },
    });
    const res = await app.request('/v1/provision', {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOK}`, 'Content-Type': 'application/json' },
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
      headers: { Authorization: `Bearer ${TOK}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ appId: 'MyApp', skipCompliance: true }),
    }, makeEnv());
    expect(res.status).toBe(400);
  });

  it('rejects app IDs over 58 chars', async () => {
    globalThis.fetch = multiFetch();
    const res = await app.request('/v1/provision', {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOK}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ appId: 'a'.repeat(59), skipCompliance: true }),
    }, makeEnv());
    expect(res.status).toBe(400);
  });

  it('calls D1 API for data plane provisioning', async () => {
    const db = mockD1();
    const fetchSpy = multiFetch({
      'd1/database': { status: 200, body: { success: true, result: { uuid: 'db-1' } } },
    });
    globalThis.fetch = fetchSpy;

    await app.request('/v1/provision', {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOK}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ appId: 'url-test', skipCompliance: true }),
    }, makeEnv({}, db));

    const calls = fetchSpy.mock.calls.map((c: any[]) => {
      const url = typeof c[0] === 'string' ? c[0] : c[0].url;
      return { url, method: c[1]?.method || 'GET' };
    });

    // Verify D1 created with POST
    const d1Call = calls.find((c: any) => c.url.includes('d1/database') && c.method === 'POST');
    expect(d1Call).toBeDefined();

    // Route inserted via D1 binding (not CF API)
    const routeInsert = db.prepare.mock.calls.some((c: any[]) => /INSERT.*routes/i.test(c[0]));
    expect(routeInsert).toBe(true);
  });

  it('inserts app record with correct creator ID', async () => {
    const appStmt = mockStmt();
    // The #81 creator-existence guard and the #82 ownership guard are answered
    // by SQL shape now, so appStmt is the first statement the sequence hands out.
    const db = mockD1(appStmt);
    globalThis.fetch = multiFetch();

    await app.request('/v1/provision', {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOK}`, 'Content-Type': 'application/json' },
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
      headers: { Authorization: `Bearer ${TOK}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ appId: 'full-check', skipCompliance: true }),
    }, makeEnv({}, db));

    const data = await res.json() as { steps: { name: string; status: string }[] };
    const failed = data.steps.filter((s: any) => s.status === 'fail');
    expect(failed).toEqual([]);

    // Every expected step is present
    const names = data.steps.map((s: any) => s.name);
    expect(names).toEqual(expect.arrayContaining([
      'compliance', 'route', 'create_d1', 'deploy_worker', 'record_app',
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

  it('503 when SESSION_SIGNING_KEY is missing', async () => {
    globalThis.fetch = multiFetch();
    const res = await app.request('/v1/provision-data', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Internal-Token': 'sekret' },
      body: JSON.stringify({ appId: 'myapp', creatorId: 'gh:7' }),
    }, makeEnv({ INTERNAL_TOKEN: 'sekret', SESSION_SIGNING_KEY: '' }));
    expect(res.status).toBe(503);
    expect(await res.text()).toContain('SESSION_SIGNING_KEY');
  });

  it('provisions D1 + worker + app record (no Pages/DNS) and records the given creator', async () => {
    const appStmt = mockStmt();
    // The #81 creator-existence guard and the #82 ownership guard are answered
    // by SQL shape now, so appStmt is the first statement the sequence hands out.
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
    expect(names).not.toContain('route');
    // app record uses the creatorId we passed (not a session user)
    expect(appStmt.bind).toHaveBeenCalled();
    const bindArgs = appStmt.bind.mock.calls[0];
    expect(bindArgs[0]).toBe('cleanup');
    expect(bindArgs[1]).toBe('gh:42');
  });

  it('does NOT write an app row when D1 fails (would freeze an empty d1_database_id)', async () => {
    const db = mockD1();
    globalThis.fetch = multiFetch({
      'd1/database': { status: 200, body: { success: false, errors: [{ message: 'quota exceeded' }] } },
    });
    const res = await app.request('/v1/provision-data', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Internal-Token': 'sekret' },
      body: JSON.stringify({ appId: 'broken', creatorId: 'gh:42' }),
    }, makeEnv({ INTERNAL_TOKEN: 'sekret' }, db));

    expect(res.status).toBe(207);
    const data = await res.json() as { success: boolean; steps: { name: string; status: string }[] };
    expect(data.success).toBe(false);
    const byName = Object.fromEntries(data.steps.map((s) => [s.name, s.status]));
    expect(byName['create_d1']).toBe('fail');
    expect(byName['record_app']).toBe('skip'); // deferred to retry, no frozen row
    // critically: the apps table was never written with an empty d1_database_id
    const wroteApps = db.prepare.mock.calls.some((c: any[]) => /INTO apps/i.test(c[0]));
    expect(wroteApps).toBe(false);
  });
});

// #82: appId arrives in the request body. Before this guard, any signed-in user
// could name a live app and drive its whole data-plane provision — and the
// compliance gate did not help, because for a non-admin it pins the repo to
// <ORG>/<appId>, i.e. the victim's own (published, compliant) repo.
describe('POST /v1/provision — appId ownership (#82)', () => {
  it('403s when the appId is already claimed by someone else', async () => {
    const db = mockD1Claimed('gh:99');
    globalThis.fetch = multiFetch();
    const res = await app.request('/v1/provision', {
      method: 'POST',
      headers: { Authorization: `Bearer ${NON_ADMIN_TOK}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ appId: 'victimapp', skipCompliance: true, skipPublish: true }),
    }, makeEnv({}, db));

    expect(res.status).toBe(403);
    expect(await res.text()).toMatch(/already claimed/i);
  });

  it('touches no Cloudflare API when the appId is claimed', async () => {
    // The guard has to run before provisioning, not alongside it — a 403 that
    // still redeployed the victim's worker would be no fix at all.
    const db = mockD1Claimed('gh:99');
    const fetchSpy = multiFetch();
    globalThis.fetch = fetchSpy;
    await app.request('/v1/provision', {
      method: 'POST',
      headers: { Authorization: `Bearer ${NON_ADMIN_TOK}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ appId: 'victimapp', skipCompliance: true, skipPublish: true }),
    }, makeEnv({}, db));

    const cfCalls = fetchSpy.mock.calls.filter(([u]: [unknown]) => String(u).includes('api.cloudflare.com'));
    expect(cfCalls).toHaveLength(0);
  });

  it('allows the owner to re-provision their own app', async () => {
    const db = mockD1Claimed('gh:2'); // same id as NON_ADMIN_TOK
    globalThis.fetch = multiFetch();
    const res = await app.request('/v1/provision', {
      method: 'POST',
      headers: { Authorization: `Bearer ${NON_ADMIN_TOK}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ appId: 'myapp', skipCompliance: true, skipPublish: true }),
    }, makeEnv({}, db));

    // Past the ownership guard. `skipCompliance` is admin-only, so a non-admin
    // still runs compliance and lands on 412 here — what matters is that it is
    // not the 403 a claimed appId would produce.
    expect(res.status).not.toBe(403);
  });

  it('allows a brand-new (unclaimed) appId', async () => {
    const db = mockD1Claimed(null);
    globalThis.fetch = multiFetch();
    const res = await app.request('/v1/provision', {
      method: 'POST',
      headers: { Authorization: `Bearer ${NON_ADMIN_TOK}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ appId: 'brand-new', skipCompliance: true, skipPublish: true }),
    }, makeEnv({}, db));

    // Past the ownership guard. `skipCompliance` is admin-only, so a non-admin
    // still runs compliance and lands on 412 here — what matters is that it is
    // not the 403 a claimed appId would produce.
    expect(res.status).not.toBe(403);
  });

  it('lets a platform admin re-provision someone else app (support path)', async () => {
    const db = mockD1Claimed('gh:99');
    globalThis.fetch = multiFetch();
    const res = await app.request('/v1/provision', {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOK}`, 'Content-Type': 'application/json' }, // TOK has admin
      body: JSON.stringify({ appId: 'victimapp', skipCompliance: true, skipPublish: true }),
    }, makeEnv({}, db));

    expect(res.status).toBe(200);
  });
});

// #83: publishing is self-service, so a session is not a scarcity signal. One
// caller must not be able to drive a loop that creates org repos, D1 databases,
// Workers and DNS.
describe('POST /v1/provision — rate limit (#83)', () => {
  const NOW = 1_800_000_000_000;

  /** Like mockD1, but with an exhausted hourly bucket for gh:1. */
  function rateLimitedDb() {
    const prepare = vi.fn((sql: string) => {
      if (/SELECT creator_id FROM apps\b/i.test(sql)) return mockStmt({ first: null });
      if (/FROM users\b/i.test(sql)) return mockStmt({ first: { 1: 1 } });
      if (/provision_attempts/i.test(sql)) {
        return mockStmt({ first: { window_start: Date.now(), count: 10 } });
      }
      return mockStmt();
    });
    return { prepare };
  }

  it('429s once the caller has spent their provisioning budget', async () => {
    globalThis.fetch = multiFetch();
    const res = await app.request('/v1/provision', {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOK}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ appId: 'flood-1', skipCompliance: true, skipPublish: true }),
    }, makeEnv({}, rateLimitedDb() as never));

    expect(res.status).toBe(429);
    expect(await res.text()).toMatch(/rate limit/i);
    expect(res.headers.get('Retry-After')).toBeTruthy();
  });

  it('creates no Cloudflare resources when rate limited', async () => {
    // A 429 that still provisioned would defeat the point.
    const fetchSpy = multiFetch();
    globalThis.fetch = fetchSpy;
    await app.request('/v1/provision', {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOK}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ appId: 'flood-2', skipCompliance: true, skipPublish: true }),
    }, makeEnv({}, rateLimitedDb() as never));

    const cfCalls = fetchSpy.mock.calls.filter(([u]: [unknown]) => String(u).includes('api.cloudflare.com'));
    expect(cfCalls).toHaveLength(0);
  });

  it('lets an ordinary provision through', async () => {
    globalThis.fetch = multiFetch();
    const res = await app.request('/v1/provision', {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOK}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ appId: 'normal', skipCompliance: true, skipPublish: true }),
    }, makeEnv({}, mockD1()));

    expect(res.status).toBe(200);
  });

  it('rejects a claimed appId before spending rate budget (#82 before #83)', async () => {
    const d = mockD1Claimed('gh:99');
    globalThis.fetch = multiFetch();
    const res = await app.request('/v1/provision', {
      method: 'POST',
      headers: { Authorization: `Bearer ${NON_ADMIN_TOK}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ appId: 'victimapp', skipCompliance: true, skipPublish: true }),
    }, makeEnv({}, d));

    expect(res.status).toBe(403);
    expect(d.prepare.mock.calls.some((c: unknown[]) => /provision_attempts/i.test(String(c[0])))).toBe(false);
  });
});
