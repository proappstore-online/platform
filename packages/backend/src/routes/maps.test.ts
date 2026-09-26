import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { app } from '../index.js';
import { testToken, TEST_SK, mockStmt, makeEnv as sharedMakeEnv } from '../test-helpers.js';

const TOK = await testToken('gh:1');
const TOK2 = await testToken('gh:2');

function mockD1(...stmts: ReturnType<typeof mockStmt>[]) {
  const prepare = vi.fn();
  for (const stmt of stmts) prepare.mockReturnValueOnce(stmt);
  prepare.mockReturnValue(mockStmt());
  return { prepare, batch: vi.fn().mockResolvedValue([]) };
}

function makeEnv(overrides: Record<string, unknown> = {}, db?: ReturnType<typeof mockD1>) {
  return sharedMakeEnv(overrides, db ?? mockD1());
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

// #222: successful upstream answers are edge-cached, keyed on the upstream
// query only, so repeated lookups never reach the shared Nominatim/OSRM servers.
describe('maps edge cache (#222)', () => {
  const place = [{ lat: '51.5', lon: '-0.12', display_name: 'London', address: {}, type: 'city', importance: 0.9 }];
  const osrm = { code: 'Ok', routes: [{ geometry: { type: 'LineString', coordinates: [[0, 0], [1, 1]] }, distance: 10, duration: 5 }] };
  const reverse = { lat: '51.5', lon: '-0.12', display_name: 'London', address: {} };

  let store: Map<string, Response>;
  const stubCache = (opts: { failMatch?: boolean; failPut?: boolean } = {}) => {
    store = new Map();
    const cache = {
      match: vi.fn(async (req: Request) => {
        if (opts.failMatch) throw new Error('cache unavailable');
        return store.get(req.url)?.clone();
      }),
      put: vi.fn(async (req: Request, res: Response) => {
        if (opts.failPut) throw new Error('cache write refused');
        store.set(req.url, res);
      }),
    };
    vi.stubGlobal('caches', { default: cache });
    return cache;
  };
  const ctx = () => {
    const pending: Promise<unknown>[] = [];
    return { pending, waitUntil: (p: Promise<unknown>) => { pending.push(p); }, passThroughOnException: () => {} } as unknown as ExecutionContext & { pending: Promise<unknown>[] };
  };
  const get = async (path: string, tok = TOK, env = makeEnv()) => {
    const x = ctx();
    const res = await app.request(path, { headers: { Authorization: `Bearer ${tok}` } }, env, x);
    await Promise.all(x.pending);
    return res;
  };
  const upstream = (body: unknown, status = 200) => {
    const f = vi.fn(async () => new Response(JSON.stringify(body), { status }));
    vi.stubGlobal('fetch', f);
    return f;
  };
  let log: ReturnType<typeof vi.spyOn>;
  beforeEach(() => { log = vi.spyOn(console, 'error').mockImplementation(() => {}); });
  afterEach(() => { vi.unstubAllGlobals(); log.mockRestore(); });

  it.each([
    ['geocode', '/v1/maps/geocode?q=London', place],
    ['route', '/v1/maps/route?from=51.5,-0.12&to=51.6,-0.1', osrm],
    ['reverse', '/v1/maps/reverse?lat=51.5&lng=-0.12', reverse],
  ])('%s: a repeated identical lookup makes one upstream request and answers identically', async (kind, path, body) => {
    const f = upstream(body);
    const cache = stubCache();
    const a = await get(path);
    const b = await get(path);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(await b.json()).toEqual(await a.json());
    expect(f).toHaveBeenCalledTimes(1);
    const [key, stored] = cache.put.mock.calls[0] as [Request, Response];
    expect(key.url).toMatch(new RegExp(`/__maps-cache/${kind}/[0-9a-f]{64}$`));
    expect(stored.headers.get('Cache-Control')).toMatch(/^public, max-age=\d+$/);
  });

  it('keys on the query, not the user: another user gets the cached answer; another query does not', async () => {
    const f = upstream(place);
    stubCache();
    await get('/v1/maps/geocode?q=London');
    await get('/v1/maps/geocode?q=London', TOK2);
    expect(f).toHaveBeenCalledTimes(1);
    for (const key of store.keys()) expect(key).not.toContain('gh:');
    await get('/v1/maps/geocode?q=Paris');
    expect(f).toHaveBeenCalledTimes(2);
  });

  it('never stores an upstream error or a no-route answer', async () => {
    const cache = stubCache();
    upstream({}, 503);
    expect((await get('/v1/maps/geocode?q=London')).status).toBe(502);
    upstream({ code: 'NoRoute' });
    expect((await get('/v1/maps/route?from=1,1&to=2,2')).status).toBe(404);
    expect(cache.put).not.toHaveBeenCalled();
  });

  it('the rate limit still applies on a cache hit', async () => {
    upstream(place);
    stubCache();
    await get('/v1/maps/geocode?q=London');
    const limited = makeEnv({}, mockD1(mockStmt({ first: { n: 100 } })));
    expect((await get('/v1/maps/geocode?q=London', TOK, limited)).status).toBe(429);
  });

  it('portability: without a Cache API it proxies upstream every time', async () => {
    const f = upstream(place);
    vi.stubGlobal('caches', undefined);
    expect((await get('/v1/maps/geocode?q=London')).status).toBe(200);
    expect((await get('/v1/maps/geocode?q=London')).status).toBe(200);
    expect(f).toHaveBeenCalledTimes(2);
  });

  it('a failing cache read or write never fails the request', async () => {
    const f = upstream(place);
    stubCache({ failMatch: true });
    expect((await get('/v1/maps/geocode?q=London')).status).toBe(200);
    stubCache({ failPut: true });
    const res = await get('/v1/maps/geocode?q=London');
    expect(res.status).toBe(200);
    expect(((await res.json()) as { results: unknown[] }).results).toHaveLength(1);
    expect(f).toHaveBeenCalledTimes(2);
    expect(log.mock.calls.map((c) => String(c[0]))).toEqual(expect.arrayContaining([
      expect.stringContaining('[maps] cache read failed'), expect.stringContaining('[maps] cache write failed'),
    ]));
  });
});
