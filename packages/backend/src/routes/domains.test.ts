import { describe, expect, it, vi, afterEach } from 'vitest';
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
/**
 * Mock the Cloudflare API. Two attach paths:
 *   in-account zone → GET /zones (find) + PUT /workers/domains (bind)
 *   external DNS    → GET /zones (miss) + GET /zones (SaaS zone) + POST /custom_hostnames
 * Responses are returned from the queue in call order.
 */
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

const zoneFound = (id = 'zone1', name = 'example.com') => ({ status: 200, body: { success: true, result: [{ id, name }] } });
const zoneMissing = () => ({ status: 200, body: { success: true, result: [] } });
const saasZone = () => ({ status: 200, body: { success: true, result: [{ id: 'saaszone', name: 'proappstore.online' }] } });
const bindOk = (hostname: string) => ({
  status: 200,
  body: { success: true, result: { id: 'wd1', hostname, service: 'proappstore-host', zone_id: 'zone1', environment: 'production' } },
});
const bindingList = (hostname: string) => ({
  status: 200,
  body: { success: true, result: [{ id: 'wd1', hostname, service: 'proappstore-host', zone_id: 'zone1', environment: 'production' }] },
});
const customHostnamePending = (hostname: string) => ({
  status: 201,
  body: {
    success: true,
    result: {
      id: 'ch1', hostname,
      ssl: { status: 'pending_validation', method: 'txt', type: 'dv', validation_records: [{ txt_name: `_cf.${hostname}`, txt_value: 'dcv-abc' }] },
      ownership_verification: { type: 'txt', name: `_cf-ov.${hostname}`, value: 'own-xyz' },
    },
  },
});
const wildcardDnsList = (domain: string, id?: string) => ({
  status: 200,
  body: { success: true, result: id ? [{ id, type: 'AAAA', name: `*.${domain}`, content: '100::', proxied: true }] : [] },
});
const wildcardDnsCreated = (domain: string, id = 'dns1') => ({
  status: 200,
  body: { success: true, result: { id, type: 'AAAA', name: `*.${domain}`, content: '100::', proxied: true } },
});
const wildcardRouteList = (domain: string, id?: string, script = 'proappstore-host') => ({
  status: 200,
  body: { success: true, result: id ? [{ id, pattern: `*.${domain}/*`, script }] : [] },
});
const wildcardRouteCreated = (domain: string, id = 'route1') => ({
  status: 200,
  body: { success: true, result: { id, pattern: `*.${domain}/*`, script: 'proappstore-host' } },
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe('POST /v1/apps/:appId/domains — in-account zone (Worker Custom Domain)', () => {
  it('binds the host worker and persists active state', async () => {
    const db = mockD1(
      mockStmt({ first: { creator_id: 'gh:1' } }),
      mockStmt({ first: null }),
      mockStmt({ run: { meta: { changes: 1 } } }),
      mockStmt({ first: { app_id: 'meetup', domain: 'meetup.example.com', kind: 'exact', status: 'active', cf_status: 'active', cf_payload: '{"kind":"worker"}', added_at: 1000, verified_at: 1000 } }),
    );
    const mock = mockFetchWithCf([zoneFound(), bindOk('meetup.example.com')]);
    mock.install();
    const res = await app.request('/v1/apps/meetup/domains', {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOK}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ domain: 'meetup.example.com' }),
    }, makeEnv({ db }));
    expect(res.status).toBe(201);
    const body = (await res.json()) as { domain: { status: string; method: string; instructions: unknown } };
    expect(body.domain.status).toBe('active');
    expect(body.domain.method).toBe('worker');
    expect(body.domain.instructions).toBeNull();
    expect(mock.cfCalls[0]?.url).toContain('/zones?name=');
    expect(mock.cfCalls[1]?.method).toBe('PUT');
    expect(mock.cfCalls[1]?.url).toContain('/workers/domains');
  });
});

describe('POST /v1/apps/:appId/domains — external DNS (Cloudflare for SaaS)', () => {
  it('creates a custom hostname and returns CNAME + TXT instructions', async () => {
    const db = mockD1(
      mockStmt({ first: { creator_id: 'gh:1' } }),
      mockStmt({ first: null }),
      mockStmt({ run: { meta: { changes: 1 } } }),
      mockStmt({
        first: {
          app_id: 'meetup', domain: 'shop.example.org', kind: 'exact', status: 'pending', cf_status: 'pending_validation',
          cf_payload: JSON.stringify({
            kind: 'saas', hostnameId: 'ch1', apex: false,
            cname: { name: 'shop.example.org', value: 'cname.proappstore.online' },
            cnameTarget: 'cname.proappstore.online',
            txt: [{ name: '_cf.shop.example.org', value: 'dcv-abc' }, { name: '_cf-ov.shop.example.org', value: 'own-xyz' }],
          }),
          added_at: 1000, verified_at: null,
        },
      }),
    );
    // zone lookups miss (shop.example.org, example.org) → SaaS zone → create custom hostname.
    const mock = mockFetchWithCf([zoneMissing(), zoneMissing(), saasZone(), customHostnamePending('shop.example.org')]);
    mock.install();
    const res = await app.request('/v1/apps/meetup/domains', {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOK}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ domain: 'shop.example.org' }),
    }, makeEnv({ db }));
    expect(res.status).toBe(201);
    const body = (await res.json()) as { domain: { status: string; method: string; instructions: any } };
    expect(body.domain.status).toBe('pending');
    expect(body.domain.method).toBe('saas');
    expect(body.domain.instructions.cname).toEqual({ name: 'shop.example.org', value: 'cname.proappstore.online' });
    expect(body.domain.instructions.txt).toHaveLength(2);
    expect(body.domain.instructions.txt[0]).toEqual({ name: '_cf.shop.example.org', value: 'dcv-abc' });
    // last CF call is the custom-hostname create
    expect(mock.cfCalls.at(-1)?.method).toBe('POST');
    expect(mock.cfCalls.at(-1)?.url).toContain('/custom_hostnames');
  });

  it('returns a clear 503 when Cloudflare for SaaS is not enabled (auth error)', async () => {
    const db = mockD1(mockStmt({ first: { creator_id: 'gh:1' } }), mockStmt({ first: null }));
    const mock = mockFetchWithCf([
      zoneMissing(), zoneMissing(), saasZone(),
      { status: 403, body: { success: false, errors: [{ code: 10000, message: 'Authentication error' }] } },
    ]);
    mock.install();
    const res = await app.request('/v1/apps/meetup/domains', {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOK}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ domain: 'shop.example.org' }),
    }, makeEnv({ db }));
    expect(res.status).toBe(503);
    expect(await res.text()).toContain('Cloudflare for SaaS');
  });
});

describe('POST /v1/apps/:appId/domains — validation', () => {
  const cases: Array<[string, unknown]> = [
    ['rejects platform-managed domains', 'evil.proappstore.online'],
    ['rejects malformed hostnames', 'not a domain!!'],
    ['rejects non-string domain', 123],
    ['rejects IP addresses', '203.0.113.7'],
  ];
  for (const [name, domain] of cases) {
    it(name, async () => {
      const db = mockD1(mockStmt({ first: { creator_id: 'gh:1' } }));
      const mock = mockFetchWithCf([]);
      mock.install();
      const res = await app.request('/v1/apps/meetup/domains', {
        method: 'POST',
        headers: { Authorization: `Bearer ${TOK}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ domain }),
      }, makeEnv({ db }));
      expect(res.status).toBe(400);
      expect(mock.cfCalls).toHaveLength(0);
    });
  }

  it('403s when caller is not the app owner', async () => {
    const db = mockD1(mockStmt({ first: { creator_id: 'gh:somebody-else' } }));
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

  it('surfaces CF errors (e.g. hostname already bound elsewhere)', async () => {
    const db = mockD1(mockStmt({ first: { creator_id: 'gh:1' } }), mockStmt({ first: null }));
    const mock = mockFetchWithCf([
      zoneFound(),
      { status: 409, body: { success: false, errors: [{ code: 100117, message: 'workers.api.error.hostname_taken' }] } },
    ]);
    mock.install();
    const res = await app.request('/v1/apps/meetup/domains', {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOK}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ domain: 'taken.example.com' }),
    }, makeEnv({ db }));
    expect(res.status).toBe(409);
    expect(await res.text()).toContain('hostname_taken');
  });
});

describe('POST /v1/apps/:appId/domains — wildcard base domains', () => {
  it('creates wildcard DNS + Workers route and persists active wildcard state', async () => {
    const payload = JSON.stringify({
      kind: 'wildcard-route',
      zoneId: 'zone-clubs',
      routeId: 'route1',
      dnsRecordId: 'dns1',
      pattern: '*.chessclubs.online/*',
    });
    const db = mockD1(
      mockStmt({ first: { creator_id: 'gh:1' } }),
      mockStmt({ first: null }),
      mockStmt({ run: { meta: { changes: 1 } } }),
      mockStmt({ first: { app_id: 'meetup', domain: 'chessclubs.online', kind: 'wildcard', status: 'active', cf_status: 'active', cf_payload: payload, added_at: 1000, verified_at: 1000 } }),
    );
    const mock = mockFetchWithCf([
      zoneFound('zone-clubs', 'chessclubs.online'),
      wildcardDnsList('chessclubs.online'),
      wildcardDnsCreated('chessclubs.online', 'dns1'),
      wildcardRouteList('chessclubs.online'),
      wildcardRouteCreated('chessclubs.online', 'route1'),
    ]);
    mock.install();

    const res = await app.request('/v1/apps/meetup/domains', {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOK}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ domain: 'chessclubs.online', wildcard: true }),
    }, makeEnv({ db }));

    expect(res.status).toBe(201);
    const body = (await res.json()) as { domain: { domain: string; kind: string; method: string; status: string } };
    expect(body.domain).toMatchObject({ domain: 'chessclubs.online', kind: 'wildcard', method: 'wildcard-route', status: 'active' });
    expect(mock.cfCalls.map((c) => c.method)).toEqual(['GET', 'GET', 'POST', 'GET', 'POST']);
    expect(mock.cfCalls[2]?.body).toEqual({ type: 'AAAA', name: '*', content: '100::', proxied: true, ttl: 1 });
    expect(mock.cfCalls[4]?.body).toEqual({ pattern: '*.chessclubs.online/*', script: 'proappstore-host' });
  });

  it('is idempotent when wildcard DNS + route already exist', async () => {
    const db = mockD1(
      mockStmt({ first: { creator_id: 'gh:1' } }),
      mockStmt({ first: null }),
      mockStmt({ run: { meta: { changes: 1 } } }),
      mockStmt({ first: { app_id: 'meetup', domain: 'chessclubs.online', kind: 'wildcard', status: 'active', cf_status: 'active', cf_payload: '{"kind":"wildcard-route"}', added_at: 1000, verified_at: 1000 } }),
    );
    const mock = mockFetchWithCf([
      zoneFound('zone-clubs', 'chessclubs.online'),
      wildcardDnsList('chessclubs.online', 'dns1'),
      wildcardRouteList('chessclubs.online', 'route1'),
    ]);
    mock.install();

    const res = await app.request('/v1/apps/meetup/domains', {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOK}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ domain: 'chessclubs.online', wildcard: true }),
    }, makeEnv({ db }));

    expect(res.status).toBe(201);
    expect(mock.cfCalls.map((c) => c.method)).toEqual(['GET', 'GET', 'GET']);
  });

  it('rejects wildcard bases that are not exact zones in the platform account', async () => {
    const db = mockD1(mockStmt({ first: { creator_id: 'gh:1' } }), mockStmt({ first: null }));
    const mock = mockFetchWithCf([zoneMissing()]);
    mock.install();

    const res = await app.request('/v1/apps/meetup/domains', {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOK}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ domain: 'clubs.example.net', wildcard: true }),
    }, makeEnv({ db }));

    expect(res.status).toBe(422);
    expect(await res.text()).toContain('zone apex');
    expect(mock.cfCalls).toHaveLength(1);
  });

  it('rejects wildcard routes that already point at another worker script', async () => {
    const db = mockD1(mockStmt({ first: { creator_id: 'gh:1' } }), mockStmt({ first: null }));
    const mock = mockFetchWithCf([
      zoneFound('zone-clubs', 'chessclubs.online'),
      wildcardDnsList('chessclubs.online', 'dns1'),
      wildcardRouteList('chessclubs.online', 'route-other', 'foreign-worker'),
    ]);
    mock.install();

    const res = await app.request('/v1/apps/meetup/domains', {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOK}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ domain: 'chessclubs.online', wildcard: true }),
    }, makeEnv({ db }));

    expect(res.status).toBe(409);
    expect(await res.text()).toContain('already points at foreign-worker');
  });

  it('rejects cross-app wildcard base ownership before calling Cloudflare', async () => {
    const db = mockD1(mockStmt({ first: { creator_id: 'gh:1' } }), mockStmt({ first: { app_id: 'other' } }));
    const mock = mockFetchWithCf([]);
    mock.install();

    const res = await app.request('/v1/apps/meetup/domains', {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOK}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ domain: 'chessclubs.online', wildcard: true }),
    }, makeEnv({ db }));

    expect(res.status).toBe(409);
    expect(mock.cfCalls).toHaveLength(0);
  });

  it('rejects exact domains under another app wildcard base before calling Cloudflare', async () => {
    const db = mockD1(mockStmt({ first: { creator_id: 'gh:1' } }), mockStmt({ first: { app_id: 'other' } }));
    const mock = mockFetchWithCf([]);
    mock.install();

    const res = await app.request('/v1/apps/meetup/domains', {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOK}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ domain: 'club.chessclubs.online' }),
    }, makeEnv({ db }));

    expect(res.status).toBe(409);
    expect(mock.cfCalls).toHaveLength(0);
  });
});

describe('GET /v1/apps/:appId/domains', () => {
  it('returns all attached domains', async () => {
    const db = mockD1(
      mockStmt({ first: { creator_id: 'gh:1' } }),
      mockStmt({
        all: {
          results: [
            { app_id: 'meetup', domain: 'meetup.example.com', kind: 'exact', status: 'active', cf_status: 'active', cf_payload: '{"kind":"worker"}', added_at: 1000, verified_at: 2000 },
            { app_id: 'meetup', domain: 'shop.example.org', kind: 'exact', status: 'pending', cf_status: 'pending_validation', cf_payload: '{"kind":"saas","cname":{"name":"shop.example.org","value":"cname.proappstore.online"},"cnameTarget":"cname.proappstore.online","txt":[],"apex":false}', added_at: 3000, verified_at: null },
            { app_id: 'meetup', domain: 'chessclubs.online', kind: 'wildcard', status: 'active', cf_status: 'active', cf_payload: '{"kind":"wildcard-route"}', added_at: 4000, verified_at: 5000 },
          ],
        },
      }),
    );
    const mock = mockFetchWithCf([]);
    mock.install();
    const res = await app.request('/v1/apps/meetup/domains', { headers: { Authorization: `Bearer ${TOK}` } }, makeEnv({ db }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { domains: Array<{ status: string; kind: string; method: string; instructions: any }> };
    expect(body.domains).toHaveLength(3);
    expect(body.domains[0]?.method).toBe('worker');
    expect(body.domains[1]?.method).toBe('saas');
    expect(body.domains[1]?.instructions?.cname?.value).toBe('cname.proappstore.online');
    expect(body.domains[2]).toMatchObject({ kind: 'wildcard', method: 'wildcard-route' });
  });
});

describe('POST /v1/apps/:appId/domains/:domain/verify', () => {
  it('worker path: active when the binding exists', async () => {
    const db = mockD1(
      mockStmt({ first: { creator_id: 'gh:1' } }),
      mockStmt({ first: { cf_payload: '{"kind":"worker"}' } }),
      mockStmt({ run: { meta: { changes: 1 } } }),
      mockStmt({ first: { app_id: 'meetup', domain: 'meetup.example.com', status: 'active', cf_status: 'active', cf_payload: '{"kind":"worker"}', added_at: 1000, verified_at: 5000 } }),
    );
    const mock = mockFetchWithCf([bindingList('meetup.example.com')]);
    mock.install();
    const res = await app.request('/v1/apps/meetup/domains/meetup.example.com/verify', { method: 'POST', headers: { Authorization: `Bearer ${TOK}` } }, makeEnv({ db }));
    expect(res.status).toBe(200);
    expect(((await res.json()) as { domain: { status: string } }).domain.status).toBe('active');
    expect(mock.cfCalls[0]?.url).toContain('/workers/domains');
  });

  it('saas path: active once the custom hostname SSL is active', async () => {
    const db = mockD1(
      mockStmt({ first: { creator_id: 'gh:1' } }),
      mockStmt({ first: { cf_payload: '{"kind":"saas","hostnameId":"ch1"}' } }),
      mockStmt({ run: { meta: { changes: 1 } } }),
      mockStmt({ first: { app_id: 'meetup', domain: 'shop.example.org', status: 'active', cf_status: 'active', cf_payload: '{"kind":"saas","hostnameId":"ch1"}', added_at: 1000, verified_at: 5000 } }),
    );
    const mock = mockFetchWithCf([
      saasZone(),
      { status: 200, body: { success: true, result: [{ id: 'ch1', hostname: 'shop.example.org', status: 'active', ssl: { status: 'active' } }] } },
    ]);
    mock.install();
    const res = await app.request('/v1/apps/meetup/domains/shop.example.org/verify', { method: 'POST', headers: { Authorization: `Bearer ${TOK}` } }, makeEnv({ db }));
    expect(res.status).toBe(200);
    expect(((await res.json()) as { domain: { status: string } }).domain.status).toBe('active');
    expect(mock.cfCalls.at(-1)?.url).toContain('/custom_hostnames');
  });

  it('404s when the domain is not attached', async () => {
    const db = mockD1(mockStmt({ first: { creator_id: 'gh:1' } }), mockStmt({ first: null }));
    const mock = mockFetchWithCf([]);
    mock.install();
    const res = await app.request('/v1/apps/meetup/domains/meetup.example.com/verify', { method: 'POST', headers: { Authorization: `Bearer ${TOK}` } }, makeEnv({ db }));
    expect(res.status).toBe(404);
  });

  it('wildcard path: active when route and DNS record still exist', async () => {
    const payload = JSON.stringify({ kind: 'wildcard-route', zoneId: 'zone-clubs', routeId: 'route1', dnsRecordId: 'dns1', pattern: '*.chessclubs.online/*' });
    const db = mockD1(
      mockStmt({ first: { creator_id: 'gh:1' } }),
      mockStmt({ first: { cf_payload: payload } }),
      mockStmt({ run: { meta: { changes: 1 } } }),
      mockStmt({ first: { app_id: 'meetup', domain: 'chessclubs.online', kind: 'wildcard', status: 'active', cf_status: 'active', cf_payload: payload, added_at: 1000, verified_at: 5000 } }),
    );
    const mock = mockFetchWithCf([wildcardRouteList('chessclubs.online', 'route1'), wildcardDnsList('chessclubs.online', 'dns1')]);
    mock.install();

    const res = await app.request('/v1/apps/meetup/domains/chessclubs.online/verify', { method: 'POST', headers: { Authorization: `Bearer ${TOK}` } }, makeEnv({ db }));

    expect(res.status).toBe(200);
    expect(((await res.json()) as { domain: { status: string; method: string } }).domain).toMatchObject({ status: 'active', method: 'wildcard-route' });
  });
});

describe('DELETE /v1/apps/:appId/domains/:domain', () => {
  it('worker path: removes the binding by id and deletes the row', async () => {
    const db = mockD1(
      mockStmt({ first: { creator_id: 'gh:1' } }),
      mockStmt({ first: { cf_payload: '{"kind":"worker"}' } }),
      mockStmt({ run: { meta: { changes: 1 } } }),
    );
    const mock = mockFetchWithCf([bindingList('meetup.example.com'), { status: 200, body: { success: true } }]);
    mock.install();
    const res = await app.request('/v1/apps/meetup/domains/meetup.example.com', { method: 'DELETE', headers: { Authorization: `Bearer ${TOK}` } }, makeEnv({ db }));
    expect(res.status).toBe(200);
    expect(mock.cfCalls[1]?.method).toBe('DELETE');
    expect(mock.cfCalls[1]?.url).toContain('/workers/domains/wd1');
  });

  it('does NOT delete the row when CF delete returns 4xx', async () => {
    const db = mockD1(
      mockStmt({ first: { creator_id: 'gh:1' } }),
      mockStmt({ first: { cf_payload: '{"kind":"worker"}' } }),
    );
    const mock = mockFetchWithCf([
      bindingList('meetup.example.com'),
      { status: 403, body: { success: false, errors: [{ code: 0, message: 'Domain is locked' }] } },
    ]);
    mock.install();
    const res = await app.request('/v1/apps/meetup/domains/meetup.example.com', { method: 'DELETE', headers: { Authorization: `Bearer ${TOK}` } }, makeEnv({ db }));
    expect(res.status).toBe(403);
    // owner check + the cf_payload lookup ran; the row delete was never reached.
    expect(db.prepare).toHaveBeenCalledTimes(2);
  });

  it('rejects malformed :domain in the URL without calling CF', async () => {
    const db = mockD1(mockStmt({ first: { creator_id: 'gh:1' } }));
    const mock = mockFetchWithCf([]);
    mock.install();
    const res = await app.request('/v1/apps/meetup/domains/not-a-domain', { method: 'DELETE', headers: { Authorization: `Bearer ${TOK}` } }, makeEnv({ db }));
    expect(res.status).toBe(400);
    expect(mock.cfCalls).toHaveLength(0);
  });

  it('wildcard path: removes the route and DNS record, then deletes the row', async () => {
    const payload = JSON.stringify({ kind: 'wildcard-route', zoneId: 'zone-clubs', routeId: 'route1', dnsRecordId: 'dns1', pattern: '*.chessclubs.online/*' });
    const db = mockD1(
      mockStmt({ first: { creator_id: 'gh:1' } }),
      mockStmt({ first: { cf_payload: payload } }),
      mockStmt({ run: { meta: { changes: 1 } } }),
    );
    const mock = mockFetchWithCf([
      { status: 200, body: { success: true, result: null } },
      { status: 200, body: { success: true, result: null } },
    ]);
    mock.install();

    const res = await app.request('/v1/apps/meetup/domains/chessclubs.online', { method: 'DELETE', headers: { Authorization: `Bearer ${TOK}` } }, makeEnv({ db }));

    expect(res.status).toBe(200);
    expect(mock.cfCalls.map((c) => c.method)).toEqual(['DELETE', 'DELETE']);
    expect(mock.cfCalls[0]?.url).toContain('/workers/routes/route1');
    expect(mock.cfCalls[1]?.url).toContain('/dns_records/dns1');
  });

  it('wildcard path: keeps the row when route cleanup fails', async () => {
    const payload = JSON.stringify({ kind: 'wildcard-route', zoneId: 'zone-clubs', routeId: 'route1', dnsRecordId: 'dns1', pattern: '*.chessclubs.online/*' });
    const db = mockD1(
      mockStmt({ first: { creator_id: 'gh:1' } }),
      mockStmt({ first: { cf_payload: payload } }),
    );
    const mock = mockFetchWithCf([
      { status: 403, body: { success: false, errors: [{ code: 0, message: 'Route is locked' }] } },
    ]);
    mock.install();

    const res = await app.request('/v1/apps/meetup/domains/chessclubs.online', { method: 'DELETE', headers: { Authorization: `Bearer ${TOK}` } }, makeEnv({ db }));

    expect(res.status).toBe(403);
    expect(await res.text()).toContain('Route is locked');
    expect(db.prepare).toHaveBeenCalledTimes(2);
  });
});
