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
  return { prepare, batch: vi.fn().mockResolvedValue([]) };
}

function makeEnv(overrides: Record<string, unknown> = {}, db?: ReturnType<typeof mockD1>) {
  return {
    DB: (db ?? mockD1()) as unknown as D1Database,
    STORAGE: {} as R2Bucket,
    STRIPE_SECRET_KEY: 'sk_test',
    STRIPE_WEBHOOK_SECRET: 'whsec_test',
    SESSION_SIGNING_KEY: TEST_SK,
    CF_API_TOKEN: 'cf_tok',
    CF_ACCOUNT_ID: 'cf_acct',
    VAPID_PUBLIC_KEY: 'test-vapid-public',
    VAPID_PRIVATE_KEY: 'test-vapid-private',
    ...overrides,
  };
}

/** Mock fetch for the upstream maps API (auth is local — no fetch needed). */
function authThenUpstream(upstreamBody: unknown, upstreamStatus = 200) {
  return vi.fn().mockResolvedValue(
    new Response(JSON.stringify(upstreamBody), { status: upstreamStatus }),
  );
}

// GET /v1/maps/geocode

describe('GET /v1/maps/geocode', () => {
  it('returns 401 without auth', async () => {
    const res = await app.request('/v1/maps/geocode?q=London', {
      headers: { Authorization: 'Bearer bad' },
    }, makeEnv());
    expect(res.status).toBe(401);
  });

  it('returns 400 when q parameter is missing', async () => {
    // DB: rate-limit query returns 0 usage, then usage insert — both succeed
    const db = mockD1(mockStmt({ first: { n: 0 } }), mockStmt());
    const res = await app.request('/v1/maps/geocode', {
      headers: { Authorization: `Bearer ${TOK}` },
    }, makeEnv({}, db));
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toContain('q parameter');
  });

  it('returns geocoding results from Nominatim', async () => {
    const nominatimResponse = [
      {
        lat: '51.5074',
        lon: '-0.1278',
        display_name: 'London, England',
        address: { city: 'London', country: 'United Kingdom' },
        type: 'city',
        importance: 0.9,
      },
    ];
    const db = mockD1(mockStmt({ first: { n: 0 } }), mockStmt());
    globalThis.fetch = authThenUpstream(nominatimResponse);

    const res = await app.request('/v1/maps/geocode?q=London', {
      headers: { Authorization: `Bearer ${TOK}` },
    }, makeEnv({}, db));
    expect(res.status).toBe(200);
    const body = await res.json() as { results: { lat: number; lng: number; displayName: string }[] };
    expect(body.results).toHaveLength(1);
    expect(body.results[0]!.lat).toBeCloseTo(51.5074);
    expect(body.results[0]!.lng).toBeCloseTo(-0.1278);
    expect(body.results[0]!.displayName).toBe('London, England');
  });

  it('returns 429 when rate limit is exceeded', async () => {
    // DB returns count = 100 (at the limit)
    const db = mockD1(mockStmt({ first: { n: 100 } }));
    const res = await app.request('/v1/maps/geocode?q=Paris', {
      headers: { Authorization: `Bearer ${TOK}` },
    }, makeEnv({}, db));
    expect(res.status).toBe(429);
    const body = await res.json() as { error: string };
    expect(body.error).toContain('rate limit');
  });

  it('returns 502 when Nominatim responds with an error', async () => {
    const db = mockD1(mockStmt({ first: { n: 0 } }), mockStmt());
    globalThis.fetch = authThenUpstream({}, 503);

    const res = await app.request('/v1/maps/geocode?q=broken', {
      headers: { Authorization: `Bearer ${TOK}` },
    }, makeEnv({}, db));
    expect(res.status).toBe(502);
  });
});

// GET /v1/maps/route

describe('GET /v1/maps/route', () => {
  it('returns 401 without auth', async () => {
    const res = await app.request('/v1/maps/route?from=51.5,0&to=48.8,2.3', {
      headers: { Authorization: 'Bearer bad' },
    }, makeEnv());
    expect(res.status).toBe(401);
  });

  it('returns 400 when from parameter is missing', async () => {
    const db = mockD1(mockStmt({ first: { n: 0 } }), mockStmt());
    const res = await app.request('/v1/maps/route?to=48.8,2.3', {
      headers: { Authorization: `Bearer ${TOK}` },
    }, makeEnv({}, db));
    expect(res.status).toBe(400);
  });

  it('returns 400 for invalid coordinate format', async () => {
    const db = mockD1(mockStmt({ first: { n: 0 } }), mockStmt());
    const res = await app.request('/v1/maps/route?from=not-a-coord&to=48.8,2.3', {
      headers: { Authorization: `Bearer ${TOK}` },
    }, makeEnv({}, db));
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toContain('invalid coordinates');
  });

  it('returns 400 for coordinates outside valid range', async () => {
    const db = mockD1(mockStmt({ first: { n: 0 } }), mockStmt());
    // lat > 90 is invalid
    const res = await app.request('/v1/maps/route?from=99.0,0.0&to=48.8,2.3', {
      headers: { Authorization: `Bearer ${TOK}` },
    }, makeEnv({}, db));
    expect(res.status).toBe(400);
  });

  it('returns route geometry from OSRM on success', async () => {
    const osrmResponse = {
      code: 'Ok',
      routes: [
        {
          geometry: { type: 'LineString', coordinates: [[0, 51.5], [2.3, 48.8]] },
          distance: 340000,
          duration: 12000,
        },
      ],
    };
    const db = mockD1(mockStmt({ first: { n: 0 } }), mockStmt());
    globalThis.fetch = authThenUpstream(osrmResponse);

    const res = await app.request('/v1/maps/route?from=51.5,0.0&to=48.8,2.3', {
      headers: { Authorization: `Bearer ${TOK}` },
    }, makeEnv({}, db));
    expect(res.status).toBe(200);
    const body = await res.json() as { distanceMeters: number; durationSeconds: number; geometry: unknown };
    expect(body.distanceMeters).toBe(340000);
    expect(body.durationSeconds).toBe(12000);
    expect(body.geometry).toBeDefined();
  });

  it('returns 404 when OSRM finds no route', async () => {
    const osrmResponse = { code: 'NoRoute', routes: [] };
    const db = mockD1(mockStmt({ first: { n: 0 } }), mockStmt());
    globalThis.fetch = authThenUpstream(osrmResponse);

    const res = await app.request('/v1/maps/route?from=51.5,0.0&to=48.8,2.3', {
      headers: { Authorization: `Bearer ${TOK}` },
    }, makeEnv({}, db));
    expect(res.status).toBe(404);
  });
});

// GET /v1/maps/reverse

describe('GET /v1/maps/reverse', () => {
  it('returns 401 without auth', async () => {
    const res = await app.request('/v1/maps/reverse?lat=51.5&lng=-0.1', {
      headers: { Authorization: 'Bearer bad' },
    }, makeEnv());
    expect(res.status).toBe(401);
  });

  it('returns 400 when lat or lng is missing', async () => {
    const db = mockD1(mockStmt({ first: { n: 0 } }), mockStmt());
    const res = await app.request('/v1/maps/reverse?lat=51.5', {
      headers: { Authorization: `Bearer ${TOK}` },
    }, makeEnv({}, db));
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toContain('lat and lng');
  });

  it('returns address data on success', async () => {
    const nominatimResponse = {
      lat: '51.5074',
      lon: '-0.1278',
      display_name: 'London, England',
      address: { city: 'London', country: 'United Kingdom' },
    };
    const db = mockD1(mockStmt({ first: { n: 0 } }), mockStmt());
    globalThis.fetch = authThenUpstream(nominatimResponse);

    const res = await app.request('/v1/maps/reverse?lat=51.5074&lng=-0.1278', {
      headers: { Authorization: `Bearer ${TOK}` },
    }, makeEnv({}, db));
    expect(res.status).toBe(200);
    const body = await res.json() as { lat: number; lng: number; displayName: string; address: unknown };
    expect(body.displayName).toBe('London, England');
    expect(body.address).toEqual(nominatimResponse.address);
  });
});
