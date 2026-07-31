import { describe, expect, it, vi, beforeEach } from 'vitest';
import { app } from '../index.js';
import { testToken, mockStmt, makeEnv as sharedMakeEnv } from '../test-helpers.js';
import { resetBurstState } from '../lib/log-quota.js';

const TOK = await testToken('gh:1');

function mockD1(...stmts: ReturnType<typeof mockStmt>[]) {
  const prepare = vi.fn();
  for (const stmt of stmts) prepare.mockReturnValueOnce(stmt);
  prepare.mockReturnValue(mockStmt());
  return { prepare, batch: vi.fn().mockResolvedValue([{ meta: { changes: 1 } }]) };
}

/**
 * Ingestion reads before it writes, so the mock order matters:
 *   1. app existence     SELECT id FROM apps
 *   2. daily quota read  SELECT count FROM app_log_usage
 *   3. quota bump        INSERT ... app_log_usage
 * then the batched entry INSERT, prepared last.
 */
function ingestDb(opts: { appExists?: boolean; dayCount?: number } = {}) {
  return mockD1(
    mockStmt({ first: opts.appExists === false ? null : { id: 'myapp' } }),
    mockStmt({ first: { count: opts.dayCount ?? 0 } }),
    mockStmt(),
  );
}

function makeEnv(overrides: Record<string, unknown> = {}, db?: ReturnType<typeof mockD1>) {
  return sharedMakeEnv(overrides, db ?? ingestDb());
}

/** The last prepared statement is the entry INSERT; its first bind() is row 1. */
function insertedRow(db: ReturnType<typeof mockD1>): unknown[] {
  return db.prepare.mock.results.at(-1)!.value.bind.mock.calls[0];
}

function entry(over: Record<string, unknown> = {}) {
  return { ts: Date.now(), level: 'error', category: 'app', message: 'boom', ...over };
}

function post(body: unknown, opts: { headers?: Record<string, string>; env?: unknown } = {}) {
  return app.request(
    '/v1/apps/myapp/logs',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(opts.headers ?? {}) },
      body: JSON.stringify(body),
    },
    opts.env ?? makeEnv(),
  );
}

beforeEach(() => resetBurstState());

describe('POST /v1/apps/:appId/logs — identity', () => {
  // Changed by #108/ADR-008: ingestion no longer requires a session. A white
  // screen on load and a failed credential sign-in have no session by
  // definition, and those are the reports most worth having.
  it('accepts anonymous entries with a client id', async () => {
    const res = await post({ entries: [entry()], clientId: 'install-abc12345' });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, ingested: 1 });
  });

  it('accepts anonymous entries with no client id at all', async () => {
    expect((await post({ entries: [entry()] })).status).toBe(200);
  });

  it('records the user id when a session is present, and null when not', async () => {
    const signedIn = ingestDb();
    await post({ entries: [entry()] }, {
      headers: { Authorization: `Bearer ${TOK}` },
      env: makeEnv({}, signedIn),
    });
    expect(insertedRow(signedIn)[1]).toBe('gh:1');

    const anon = ingestDb();
    await post({ entries: [entry()] }, { env: makeEnv({}, anon) });
    expect(insertedRow(anon)[1]).toBeNull();
  });

  it('ignores a malformed bearer token rather than 401-ing the report', async () => {
    const res = await post({ entries: [entry()] }, { headers: { Authorization: 'Bearer nonsense' } });
    expect(res.status).toBe(200);
  });
});

describe('POST /v1/apps/:appId/logs — app binding', () => {
  it('returns 404 for an app that does not exist', async () => {
    const res = await post({ entries: [entry()] }, { env: makeEnv({}, ingestDb({ appExists: false })) });
    expect(res.status).toBe(404);
  });

  it('returns 403 when a mediated request claims a different app', async () => {
    const res = await post({ entries: [entry()] }, { headers: { 'X-PAS-App': 'other-app' } });
    expect(res.status).toBe(403);
  });

  it('marks rows mediated when the host vouches for the app, direct otherwise', async () => {
    const mediated = ingestDb();
    await post({ entries: [entry()] }, {
      headers: { 'X-PAS-App': 'myapp' },
      env: makeEnv({}, mediated),
    });
    expect(insertedRow(mediated)[11]).toBe('mediated');

    const direct = ingestDb();
    await post({ entries: [entry()] }, { env: makeEnv({}, direct) });
    expect(insertedRow(direct)[11]).toBe('direct');
  });
});

describe('POST /v1/apps/:appId/logs — validation', () => {
  it('returns 400 when entries is missing or not an array', async () => {
    expect((await post({ notEntries: 'oops' })).status).toBe(400);
    expect((await post({ entries: 'a string' })).status).toBe(400);
  });

  it('returns 413 when the declared body exceeds the cap', async () => {
    const res = await app.request(
      '/v1/apps/myapp/logs',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'content-length': String(600 * 1024) },
        body: JSON.stringify({ entries: [entry()] }),
      },
      makeEnv(),
    );
    expect(res.status).toBe(413);
  });

  it('drops unusable entries without failing the rest of the batch', async () => {
    const res = await post(
      {
        entries: [
          entry(),
          { ts: Date.now(), level: 'catastrophe', message: 'bad level' },
          { ts: Date.now(), level: 'error', message: '   ' },
          entry({ message: 'second good one' }),
        ],
      },
      { env: makeEnv({}, ingestDb()) },
    );
    expect(await res.json()).toMatchObject({ ingested: 2 });
  });

  it('caps the batch at 100 entries', async () => {
    const entries = Array.from({ length: 250 }, (_, i) => entry({ message: `e${i}` }));
    const res = await post({ entries }, { env: makeEnv({}, ingestDb()) });
    expect(await res.json()).toMatchObject({ ingested: 100 });
  });

  it('returns 200 with ingested 0 when nothing survives validation', async () => {
    const res = await post({ entries: [{ level: 'nope', message: '' }] });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ingested: 0 });
  });

  it('scrubs credential-shaped content before persisting', async () => {
    const db = ingestDb();
    await post(
      { entries: [entry({ message: 'login failed password=hunter2', data: { token: 'abc' } })] },
      { env: makeEnv({}, db) },
    );
    const bound = insertedRow(db).join(' ');
    expect(bound).not.toContain('hunter2');
    expect(bound).toContain('[redacted]');
  });

  it('stores a fingerprint that groups the same fault across differing ids', async () => {
    const a = ingestDb();
    await post({ entries: [entry({ message: 'load failed for user 123' })] }, { env: makeEnv({}, a) });
    const b = ingestDb();
    await post({ entries: [entry({ message: 'load failed for user 987' })] }, { env: makeEnv({}, b) });
    expect(insertedRow(a)[9]).toMatch(/^[0-9a-f]{16}$/);
    expect(insertedRow(a)[9]).toBe(insertedRow(b)[9]);
  });
});

describe('POST /v1/apps/:appId/logs — quota', () => {
  it('counts but stops persisting once the daily budget is spent', async () => {
    const db = ingestDb({ dayCount: 999_999 });
    const res = await post({ entries: [entry()] }, { env: makeEnv({}, db) });
    expect(res.status).toBe(202);
    expect(await res.json()).toMatchObject({ ingested: 0, counted: 1, throttled: 'daily_quota' });
    expect(db.batch).not.toHaveBeenCalled();
  });

  it('throttles a burst from one client without a 4xx that would trigger retries', async () => {
    const full = () => Array.from({ length: 100 }, () => entry());
    // Two full batches fit inside the per-second ceiling; the third does not.
    expect((await post({ entries: full() }, { env: makeEnv({}, ingestDb()) })).status).toBe(200);
    expect((await post({ entries: full() }, { env: makeEnv({}, ingestDb()) })).status).toBe(200);
    const third = await post({ entries: full() }, { env: makeEnv({}, ingestDb()) });
    expect(third.status).toBe(202);
    expect(await third.json()).toMatchObject({ throttled: 'burst' });
  });

  it('keeps counting throttled entries as metrics so a spike stays visible', async () => {
    const points: unknown[] = [];
    const ERRORS = { writeDataPoint: (p: unknown) => points.push(p) } as unknown as AnalyticsEngineDataset;
    await post({ entries: [entry()] }, {
      env: makeEnv({ ERRORS }, ingestDb({ dayCount: 999_999 })),
    });
    expect(points).toHaveLength(1);
  });

  it('does not count info-level entries as error metrics', async () => {
    const points: unknown[] = [];
    const ERRORS = { writeDataPoint: (p: unknown) => points.push(p) } as unknown as AnalyticsEngineDataset;
    await post({ entries: [entry({ level: 'info' }), entry({ level: 'warn' })] }, {
      env: makeEnv({ ERRORS }, ingestDb()),
    });
    expect(points).toHaveLength(1);
  });
});

describe('GET /v1/apps/:appId/logs', () => {
  it('returns 401 without auth', async () => {
    const res = await app.request('/v1/apps/myapp/logs', {
      headers: { Authorization: 'Bearer bad' },
    }, makeEnv());
    expect(res.status).toBe(401);
  });

  it('returns 404 when app does not exist', async () => {
    const db = mockD1(mockStmt({ first: null }));
    const res = await app.request('/v1/apps/myapp/logs', {
      headers: { Authorization: `Bearer ${TOK}` },
    }, makeEnv({}, db));
    expect(res.status).toBe(404);
  });

  it('returns 403 when user is not the owner', async () => {
    const db = mockD1(mockStmt({ first: { creator_id: 'gh:999' } }), mockStmt({ first: null }));
    const res = await app.request('/v1/apps/myapp/logs', {
      headers: { Authorization: `Bearer ${TOK}` },
    }, makeEnv({}, db));
    expect(res.status).toBe(403);
  });

  it('returns logs with the new observability fields for the owner', async () => {
    const db = mockD1(
      mockStmt({ first: { creator_id: 'gh:1' } }),
      mockStmt({
        all: {
          results: [{
            ts: 1, level: 'error', category: 'app', message: 'boom', data: null,
            user_id: null, client_id: 'install-abc12345', build_meta: null,
            fingerprint: 'deadbeefdeadbeef', trace_id: 'a'.repeat(32), source: 'mediated',
          }],
        },
      }),
    );
    const res = await app.request('/v1/apps/myapp/logs', {
      headers: { Authorization: `Bearer ${TOK}` },
    }, makeEnv({}, db));
    expect(res.status).toBe(200);
    const body = await res.json() as { logs: Array<Record<string, unknown>> };
    expect(body.logs[0]).toMatchObject({
      fingerprint: 'deadbeefdeadbeef',
      source: 'mediated',
      clientId: 'install-abc12345',
      userId: null,
    });
  });

  it('parses data JSON field in log results', async () => {
    const db = mockD1(
      mockStmt({ first: { creator_id: 'gh:1' } }),
      mockStmt({ all: { results: [{ ts: 1, level: 'info', category: 'app', message: 'm', data: '{"a":1}' }] } }),
    );
    const res = await app.request('/v1/apps/myapp/logs', {
      headers: { Authorization: `Bearer ${TOK}` },
    }, makeEnv({}, db));
    const body = await res.json() as { logs: Array<{ data: unknown }> };
    expect(body.logs[0].data).toEqual({ a: 1 });
  });
});

describe('GET /v1/apps/:appId/logs/groups', () => {
  it('is owner-only', async () => {
    const db = mockD1(mockStmt({ first: { creator_id: 'gh:999' } }), mockStmt({ first: null }));
    const res = await app.request('/v1/apps/myapp/logs/groups', {
      headers: { Authorization: `Bearer ${TOK}` },
    }, makeEnv({}, db));
    expect(res.status).toBe(403);
  });

  it('returns occurrence-grouped rows', async () => {
    const db = mockD1(
      mockStmt({ first: { creator_id: 'gh:1' } }),
      mockStmt({
        all: {
          results: [{
            fingerprint: 'deadbeefdeadbeef', occurrences: 400, affected: 12,
            first_seen: 1, last_seen: 9, level: 'error', category: 'action',
            sample_message: 'Only creators can provision',
          }],
        },
      }),
    );
    const res = await app.request('/v1/apps/myapp/logs/groups', {
      headers: { Authorization: `Bearer ${TOK}` },
    }, makeEnv({}, db));
    expect(res.status).toBe(200);
    const body = await res.json() as { groups: Array<Record<string, unknown>> };
    expect(body.groups[0]).toMatchObject({ occurrences: 400, affected: 12 });
  });
});

describe('GET /v1/apps/:appId/logs/build', () => {
  it('returns 403 when user is not the owner', async () => {
    const db = mockD1(mockStmt({ first: { creator_id: 'gh:999' } }), mockStmt({ first: null }));
    const res = await app.request('/v1/apps/myapp/logs/build', {
      headers: { Authorization: `Bearer ${TOK}` },
    }, makeEnv({}, db));
    expect(res.status).toBe(403);
  });

  it('returns {build: null} when no build log exists', async () => {
    const db = mockD1(mockStmt({ first: { creator_id: 'gh:1' } }), mockStmt({ first: null }));
    const res = await app.request('/v1/apps/myapp/logs/build', {
      headers: { Authorization: `Bearer ${TOK}` },
    }, makeEnv({}, db));
    expect(await res.json()).toEqual({ build: null });
  });

  it('returns parsed build metadata when a build log row exists', async () => {
    const db = mockD1(
      mockStmt({ first: { creator_id: 'gh:1' } }),
      mockStmt({ first: { build_meta: '{"sha":"abc"}', ts: 42 } }),
    );
    const res = await app.request('/v1/apps/myapp/logs/build', {
      headers: { Authorization: `Bearer ${TOK}` },
    }, makeEnv({}, db));
    expect(await res.json()).toEqual({ build: { sha: 'abc' }, ts: 42 });
  });
});
