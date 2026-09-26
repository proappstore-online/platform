import { afterEach, describe, expect, it, vi } from 'vitest';
import { app } from '../index.js';
import { testToken, TEST_SK } from '../test-helpers.js';

const TOK = await testToken('gh:1', { login: 'creator', roles: ['user', 'creator'] });
// #121: no forged appRoles claim — the grant is read from `app_roles`, so the
// test seeds that table instead of a token shape no mint site produces.
const MANAGER_TOK = await testToken('gh:2', { login: 'manager', roles: ['user'] });

function stmt(opts: { first?: unknown; all?: unknown } = {}) {
  return {
    bind: vi.fn().mockReturnThis(),
    first: vi.fn().mockResolvedValue(opts.first ?? null),
    all: vi.fn().mockResolvedValue(opts.all ?? { results: [] }),
  };
}

function db(...stmts: ReturnType<typeof stmt>[]) {
  const prepare = vi.fn();
  for (const s of stmts) prepare.mockReturnValueOnce(s);
  prepare.mockReturnValue(stmt());
  return { prepare } as unknown as D1Database;
}

/** The Workers rate-limit binding's contract: `limit` per key, then refusal. */
function limiter(limit = 120) {
  const counts = new Map<string, number>();
  return {
    limit: vi.fn(async ({ key }: { key: string }) => {
      const n = (counts.get(key) ?? 0) + 1;
      counts.set(key, n);
      return { success: n <= limit };
    }),
  };
}

function env(database: D1Database, overrides: Record<string, unknown> = {}) {
  return {
    DB: database,
    PUBLIC_ACTION_RATE_LIMIT: limiter(),
    STORAGE: {} as R2Bucket,
    STRIPE_SECRET_KEY: 'sk_test',
    STRIPE_WEBHOOK_SECRET: 'whsec_test',
    SESSION_SIGNING_KEY: TEST_SK,
    CF_API_TOKEN: 'cf_tok',
    CF_ACCOUNT_ID: 'cf_acct',
    INTERNAL_TOKEN: 'internal-secret',
    DATA_WORKER_HOST: 'serge-the-dev.workers.dev',
    VAPID_PUBLIC_KEY: 'test-vapid-public',
    VAPID_PRIVATE_KEY: 'test-vapid-private',
    ...overrides,
  };
}

function manifest(overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    name: 'list_mine',
    description: 'List mine',
    operation: 'query',
    sql: 'SELECT * FROM items WHERE user_id = :__user_id LIMIT :limit',
    params: { limit: { type: 'integer', default: 20, max: 100, optional: true } },
    requires_auth: true,
    ...overrides,
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('POST /v1/apps/:appId/actions/:name', () => {
  it('executes a registered action with server-injected user id', async () => {
    const fetchMock = vi.fn().mockResolvedValue(Response.json({ rows: [{ id: 'item-1' }] }));
    vi.stubGlobal('fetch', fetchMock);

    const res = await app.request(
      '/v1/apps/interns/actions/list_mine',
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${TOK}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ params: { limit: 10, __user_id: 'attacker' } }),
      },
      env(db(stmt({ first: { manifest: manifest() } }))),
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ rows: [{ id: 'item-1' }] });
    expect(fetchMock).toHaveBeenCalledWith(
      'https://pas-data-interns.serge-the-dev.workers.dev/query',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          Authorization: `Bearer ${TOK}`,
          'X-Internal-Token': 'internal-secret',
        }),
      }),
    );
    const body = JSON.parse(fetchMock.mock.calls[0]![1].body as string) as { sql: string; params: unknown[] };
    expect(body.sql).toBe('SELECT * FROM items WHERE user_id = ? LIMIT ?');
    expect(body.params).toEqual(['gh:1', 10]);
  });

  it('omits X-Internal-Token when INTERNAL_TOKEN is not configured', async () => {
    const fetchMock = vi.fn().mockResolvedValue(Response.json({ rows: [] }));
    vi.stubGlobal('fetch', fetchMock);

    const e = env(db(stmt({ first: { manifest: manifest() } }))) as Record<string, unknown>;
    delete e.INTERNAL_TOKEN;

    const res = await app.request(
      '/v1/apps/interns/actions/list_mine',
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${TOK}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ params: { limit: 10 } }),
      },
      e,
    );

    expect(res.status).toBe(200);
    const headers = fetchMock.mock.calls[0]![1].headers as Record<string, string>;
    expect(headers['X-Internal-Token']).toBeUndefined();
  });

  it('requires a PAS session', async () => {
    const res = await app.request(
      '/v1/apps/interns/actions/list_mine',
      { method: 'POST', headers: { 'Content-Type': 'application/json' } },
      env(db(stmt({ first: { manifest: manifest() } }))),
    );

    expect(res.status).toBe(401);
  });

  it('executes a public registered action without a bearer token', async () => {
    const fetchMock = vi.fn().mockResolvedValue(Response.json({ rows: [{ id: 'org-1' }] }));
    vi.stubGlobal('fetch', fetchMock);

    const publicManifest = manifest({
      name: 'get_org_by_slug',
      sql: 'SELECT id, name, logo_url FROM orgs WHERE slug = :slug LIMIT 1',
      params: { slug: { type: 'string' } },
      requires_auth: false,
    });

    const res = await app.request(
      '/v1/apps/interns/actions/get_org_by_slug',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ params: { slug: 'chessideas' } }),
      },
      env(db(stmt({ first: { manifest: publicManifest } }))),
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ rows: [{ id: 'org-1' }] });
    expect(fetchMock).toHaveBeenCalledWith(
      'https://pas-data-interns.serge-the-dev.workers.dev/query',
      expect.objectContaining({
        method: 'POST',
        headers: {
          'X-Internal-Token': 'internal-secret',
          'Content-Type': 'application/json',
        },
      }),
    );
    const body = JSON.parse(fetchMock.mock.calls[0]![1].body as string) as { sql: string; params: unknown[] };
    expect(body.sql).toBe('SELECT id, name, logo_url FROM orgs WHERE slug = ? LIMIT 1');
    expect(body.params).toEqual(['chessideas']);
  });

  it('returns 500 for a stale public manifest that references user identity', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const res = await app.request(
      '/v1/apps/interns/actions/stale_public',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ params: {} }),
      },
      env(db(stmt({
        first: {
          manifest: manifest({
            name: 'stale_public',
            requires_auth: false,
            sql: 'SELECT * FROM items WHERE user_id = :__user_id LIMIT 1',
          }),
        },
      }))),
    );

    expect(res.status).toBe(500);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects malformed params instead of silently dropping them', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const res = await app.request(
      '/v1/apps/interns/actions/list_mine',
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${TOK}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ params: [] }),
      },
      env(db(stmt({ first: { manifest: manifest() } }))),
    );

    expect(res.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('enforces manifest app roles before reaching the data worker', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const res = await app.request(
      '/v1/apps/interns/actions/manager_only',
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${TOK}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ params: { limit: 10 } }),
      },
      env(db(
        stmt({ first: { manifest: manifest({ name: 'manager_only', auth: { app_roles: ['manager'] } }) } }),
        stmt({ all: { results: [{ role_name: 'member' }] } }),
      )),
    );

    expect(res.status).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('accepts a manifest app role granted in the app_roles table', async () => {
    const fetchMock = vi.fn().mockResolvedValue(Response.json({ rows: [] }));
    vi.stubGlobal('fetch', fetchMock);

    const res = await app.request(
      '/v1/apps/interns/actions/manager_only',
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${MANAGER_TOK}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ params: { limit: 5 } }),
      },
      env(db(
        stmt({ first: { manifest: manifest({ name: 'manager_only', auth: { app_roles: ['manager'] } }) } }),
        stmt({ all: { results: [{ role_name: 'manager' }] } }),
      )),
    );

    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledOnce();
  });
});

// #211: public actions are an unauthenticated path to two D1 databases. They
// are limited per (app, client IP) and may opt into a short edge cache.
describe('POST /v1/apps/:appId/actions/:name — public action limits and cache (#211)', () => {
  const publicManifest = (overrides: Record<string, unknown> = {}) => manifest({
    name: 'get_org_by_slug',
    sql: 'SELECT id, name FROM orgs WHERE slug = :slug LIMIT 1',
    params: { slug: { type: 'string' } },
    requires_auth: false,
    ...overrides,
  });
  // Every prepare() answers with the manifest, so each call can reach the data worker.
  const manifestDb = (m = publicManifest()) => {
    const prepare = vi.fn(() => stmt({ first: { manifest: m } }));
    return { prepare } as unknown as D1Database & { prepare: typeof prepare };
  };
  const call = (e: Record<string, unknown>, headers: Record<string, string> = {}, slug = 'chessideas', ctx?: ExecutionContext) =>
    app.request(
      '/v1/apps/interns/actions/get_org_by_slug',
      { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify({ params: { slug } }) },
      e,
      ctx,
    );
  const ip = { 'cf-connecting-ip': '203.0.113.7' };

  it('answers the 121st anonymous call from one IP in a window with 429 + Retry-After, before any D1 read', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ rows: [] })));
    const database = manifestDb();
    const e = env(database);
    for (let i = 0; i < 120; i++) expect((await call(e, ip)).status).toBe(200);
    database.prepare.mockClear();

    const res = await call(e, ip);
    expect(res.status).toBe(429);
    expect(res.headers.get('Retry-After')).toBe('60');
    expect(database.prepare).not.toHaveBeenCalled();
    expect(e.PUBLIC_ACTION_RATE_LIMIT.limit).toHaveBeenLastCalledWith({ key: 'interns:203.0.113.7' });
    // Another IP has its own budget.
    expect((await call(e, { 'cf-connecting-ip': '203.0.113.8' })).status).toBe(200);
  });

  it('never limits a signed-in call, but a bearer that does not verify gets no bypass', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ rows: [] })));
    const e = env(manifestDb(), { PUBLIC_ACTION_RATE_LIMIT: limiter(0) });

    const signedIn = await call(e, { ...ip, Authorization: `Bearer ${TOK}` });
    expect(signedIn.status).toBe(200);
    expect(e.PUBLIC_ACTION_RATE_LIMIT.limit).not.toHaveBeenCalled();

    const forged = await call(e, { ...ip, Authorization: 'Bearer not-a-session' });
    expect(forged.status).toBe(429);
  });

  it('exempts service-binding calls, which carry no cf-connecting-ip (host tenant meta)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ rows: [] })));
    const e = env(manifestDb(), { PUBLIC_ACTION_RATE_LIMIT: limiter(0) });
    expect((await call(e)).status).toBe(200);
    expect(e.PUBLIC_ACTION_RATE_LIMIT.limit).not.toHaveBeenCalled();
  });

  describe('cache_ttl', () => {
    const stubCache = () => {
      const store = new Map<string, Response>();
      const cache = {
        match: vi.fn(async (req: Request) => store.get(req.url)?.clone()),
        put: vi.fn(async (req: Request, res: Response) => { store.set(req.url, res); }),
      };
      vi.stubGlobal('caches', { default: cache });
      return cache;
    };
    const ctx = () => {
      const pending: Promise<unknown>[] = [];
      return { pending, waitUntil: (p: Promise<unknown>) => { pending.push(p); }, passThroughOnException: () => {} } as unknown as ExecutionContext & { pending: Promise<unknown>[] };
    };

    it('serves identical params from the cache: one data-worker request, public max-age', async () => {
      const fetchMock = vi.fn(async () => Response.json({ rows: [{ id: 'org-1' }] }));
      vi.stubGlobal('fetch', fetchMock);
      stubCache();
      const e = env(manifestDb(publicManifest({ cache_ttl: 60 })));

      const first = ctx();
      const a = await call(e, ip, 'chessideas', first);
      await Promise.all(first.pending);
      const b = await call(e, ip, 'chessideas', ctx());

      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(a.headers.get('Cache-Control')).toBe('public, max-age=60');
      expect(b.headers.get('Cache-Control')).toBe('public, max-age=60');
      expect(await b.json()).toEqual({ rows: [{ id: 'org-1' }] });

      await call(e, ip, 'other-org', ctx());
      expect(fetchMock).toHaveBeenCalledTimes(2); // different params, different key
    });

    it('does not store a failed upstream answer', async () => {
      const fetchMock = vi.fn(async () => Response.json({ error: 'boom' }, { status: 500 }));
      vi.stubGlobal('fetch', fetchMock);
      const cache = stubCache();
      const e = env(manifestDb(publicManifest({ cache_ttl: 60 })));

      const res = await call(e, ip, 'chessideas', ctx());
      expect(res.status).toBe(500);
      expect(res.headers.get('Cache-Control')).toBe('no-store');
      expect(cache.put).not.toHaveBeenCalled();
    });

    it('keeps no-store for a public query without cache_ttl', async () => {
      vi.stubGlobal('fetch', vi.fn(async () => Response.json({ rows: [] })));
      const cache = stubCache();
      const res = await call(env(manifestDb()), ip);
      expect(res.headers.get('Cache-Control')).toBe('no-store');
      expect(cache.match).not.toHaveBeenCalled();
    });
  });
});

// #153: registered actions are a server-to-server path. They must reach the
// worker's direct workers.dev host (from DATA_WORKER_HOST) and never traverse
// the public data-<app>.proappstore.online proxy, which is a browser-mediation
// hop that surfaced HTTP 522 on a healthy worker.
describe('POST /v1/apps/:appId/actions/:name — direct data-worker routing (#153)', () => {
  const PUBLIC_DATA_HOST = /data-[a-z0-9-]+\.proappstore\.online/;
  const call = (envOverrides: Record<string, unknown> = {}) =>
    app.request(
      '/v1/apps/interns/actions/list_mine',
      { method: 'POST', headers: { Authorization: `Bearer ${TOK}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ params: { limit: 10 } }) },
      env(db(stmt({ first: { manifest: manifest() } })), envOverrides),
    );

  it('builds the upstream URL from DATA_WORKER_HOST, never the public data-* proxy', async () => {
    const fetchMock = vi.fn().mockResolvedValue(Response.json({ rows: [] }));
    vi.stubGlobal('fetch', fetchMock);
    const res = await call({ DATA_WORKER_HOST: 'other-account.workers.dev' });
    expect(res.status).toBe(200);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://pas-data-interns.other-account.workers.dev/query');
    expect(String(url)).not.toMatch(PUBLIC_DATA_HOST);
    expect((init as RequestInit).headers).toEqual(expect.objectContaining({ 'X-Internal-Token': 'internal-secret' }));
  });

  it('tolerates a scheme or trailing slash in the configured host', async () => {
    const fetchMock = vi.fn().mockResolvedValue(Response.json({ rows: [] }));
    vi.stubGlobal('fetch', fetchMock);
    await call({ DATA_WORKER_HOST: 'https://acct.workers.dev/' });
    expect(fetchMock.mock.calls[0]![0]).toBe('https://pas-data-interns.acct.workers.dev/query');
  });

  it('fails loud with 503 when DATA_WORKER_HOST is not configured — no fallback to a hard-coded account', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const res = await call({ DATA_WORKER_HOST: undefined });
    expect(res.status).toBe(503);
    expect(await res.text()).toContain('DATA_WORKER_HOST');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('verify actions (#148): a trusted, platform-owned execution path', () => {
  const claim = (overrides: Record<string, unknown> = {}) => manifest({
    name: 'claim_game_over',
    operation: 'verify',
    verifier: 'chess.replay',
    sql: 'SELECT moves FROM games WHERE id = :game_id AND (white_id = :__user_id OR black_id = :__user_id)',
    statements: [
      "UPDATE games SET status = 'finished', result = :__verify_result, end_reason = :__verify_reason, finished_at = :__now WHERE id = :game_id AND (white_id = :__user_id OR black_id = :__user_id) AND :__verify_over = 1",
    ],
    params: { game_id: { type: 'string' } },
    ...overrides,
  });
  const call = (m: string, params: Record<string, unknown> = { game_id: 'g1' }, extra: Record<string, unknown> = {}) =>
    app.request(
      '/v1/apps/chess/actions/claim_game_over',
      { method: 'POST', headers: { Authorization: `Bearer ${TOK}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ params }) },
      env(db(stmt({ first: { manifest: m } })), extra),
    );
  const hops = (fetchMock: ReturnType<typeof vi.fn>) =>
    fetchMock.mock.calls.map(([url, init]) => [String(url).replace('https://pas-data-chess.serge-the-dev.workers.dev', ''), JSON.parse((init as RequestInit).body as string)]);

  it('reads the scoped rows, replays them with the platform chess.js, and writes with the verdict bound — one query hop, one atomic batch hop', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(Response.json({ rows: [{ moves: '["f3","e5","g4","Qh4#"]' }], meta: {} }))
      .mockResolvedValueOnce(Response.json({ results: [{ rows: [], meta: { changes: 1, last_row_id: 0 } }] }));
    vi.stubGlobal('fetch', fetchMock);

    const res = await call(claim(), { game_id: 'g1', __verify_over: 'true', __user_id: 'attacker' });
    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    const body = (await res.json()) as { ok: boolean; verifier: string; output: Record<string, unknown>; writes: unknown[] };
    expect(body.ok).toBe(true);
    expect(body.verifier).toBe('chess.replay');
    expect(body.output).toMatchObject({ legal: true, over: true, result: '0-1', reason: 'checkmate', ply: 4 });
    expect(body.writes).toEqual([{ changes: 1, last_row_id: 0 }]);

    const [[readPath, readBody], [writePath, writeBody]] = hops(fetchMock) as [[string, { sql: string; params: unknown[] }], [string, { statements: { sql: string; params: unknown[] }[] }]];
    expect(readPath).toBe('/query');
    expect(readBody).toEqual({ sql: 'SELECT moves FROM games WHERE id = ? AND (white_id = ? OR black_id = ?)', params: ['g1', 'gh:1', 'gh:1'] });
    expect(writePath).toBe('/batch');
    expect(writeBody.statements).toHaveLength(1);
    // The verdict comes from the verifier, not from the client's params.
    expect(writeBody.statements[0]!.params).toEqual(['0-1', 'checkmate', expect.any(Number), 'g1', 'gh:1', 'gh:1', true]);
    for (const [, init] of fetchMock.mock.calls) {
      expect((init as RequestInit).headers).toMatchObject({ 'X-Internal-Token': 'internal-secret' });
    }
  });

  it('an in-progress game verifies as not over — the write still runs, guarded by :__verify_over = 0', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(Response.json({ rows: [{ moves: 'e4 e5' }], meta: {} }))
      .mockResolvedValueOnce(Response.json({ results: [{ rows: [], meta: { changes: 0 } }] }));
    vi.stubGlobal('fetch', fetchMock);
    const body = (await (await call(claim())).json()) as { ok: boolean; output: Record<string, unknown>; writes: unknown[] };
    expect(body.ok).toBe(true);
    expect(body.output).toMatchObject({ over: false, result: null, reason: null, turn: 'w' });
    expect(body.writes).toEqual([{ changes: 0 }]);
    expect((hops(fetchMock)[1]![1] as { statements: { params: unknown[] }[] }).statements[0]!.params).toEqual([null, null, expect.any(Number), 'g1', 'gh:1', 'gh:1', false]);
  });

  it('no row (not the caller\'s game, or no such game) → ok:false with the reason, and NOTHING is written', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(Response.json({ rows: [], meta: {} }));
    vi.stubGlobal('fetch', fetchMock);
    const res = await call(claim());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: false, verifier: 'chess.replay', error: 'no input row',
      output: { legal: null, illegal_index: null, illegal_move: null, ply: null, over: null, result: null, reason: null, turn: null, in_check: null, fen: null },
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('a read-only verify tool (no statements) answers the verdict without a second hop', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(Response.json({ rows: [{ move: 'e4' }, { move: 'e5' }, { move: 'Ke2' }, { move: 'Ke7' }, { move: 'Qh5#' }], meta: {} }));
    vi.stubGlobal('fetch', fetchMock);
    const body = (await (await call(claim({ statements: undefined }))).json()) as { ok: boolean; output: Record<string, unknown>; writes?: unknown };
    expect(body.ok).toBe(true);
    expect(body.output).toMatchObject({ legal: false, illegal_index: 4, illegal_move: 'Qh5#', over: false });
    expect(body).not.toHaveProperty('writes');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('data-worker failures pass through with their status; malformed upstream JSON is a 502; a missing param is a 400', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(new Response('{"error":"no such table: games"}', { status: 500, headers: { 'Content-Type': 'application/json' } })));
    const failedRead = await call(claim());
    expect(failedRead.status).toBe(500);
    expect(await failedRead.json()).toEqual({ error: 'no such table: games' });

    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(Response.json({ rows: [{ moves: 'f3 e5 g4 Qh4#' }] }))
      .mockResolvedValueOnce(new Response('{"error":"constraint failed"}', { status: 409, headers: { 'Content-Type': 'application/json' } })));
    const failedWrite = await call(claim());
    expect(failedWrite.status).toBe(409);

    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(new Response('not json', { status: 200 })));
    expect((await call(claim())).status).toBe(502);

    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(Response.json({ rows: [{ moves: 'f3 e5 g4 Qh4#' }] }))
      .mockResolvedValueOnce(new Response('not json', { status: 200 })));
    expect((await call(claim())).status).toBe(502);

    const noFetch = vi.fn();
    vi.stubGlobal('fetch', noFetch);
    const missing = await call(claim(), {});
    expect(missing.status).toBe(400);
    expect(((await missing.json()) as { error: string }).error).toBe('Missing required parameter: game_id');
    expect(noFetch).not.toHaveBeenCalled();
  });

  it('a stored manifest naming a verifier that no longer exists is a 500, before any upstream call', async () => {
    const noFetch = vi.fn();
    vi.stubGlobal('fetch', noFetch);
    const res = await call(claim({ verifier: 'chess.legacy' }));
    expect(res.status).toBe(500);
    expect(noFetch).not.toHaveBeenCalled();
  });
});
