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

const validTool = {
  name: 'list_items',
  description: 'List items',
  operation: 'query',
  sql: 'SELECT * FROM items WHERE (:status IS NULL OR status = :status) LIMIT :limit',
  params: {
    status: { type: 'string', optional: true },
    limit: { type: 'integer', optional: true, default: 20, max: 100 },
  },
  requires_auth: true,
};

// The schema-coherence check (#33) fetches the app's data worker /validate.
// Stub it for every test: default = every statement compiles. Individual tests
// override `validateResults` to simulate drift (missing column) or make the
// stub throw to simulate an unreachable data worker (fail-open).
type ValStmt = { id: string; sql: string; paramCount: number };
let validateResults: (stmts: ValStmt[]) => { id: string; ok: boolean; error?: string }[];
beforeEach(() => {
  validateResults = (stmts) => stmts.map((s) => ({ id: s.id, ok: true }));
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input).includes('/validate')) {
      const body = JSON.parse((init!.body as string)) as { statements: ValStmt[] };
      return new Response(JSON.stringify({ results: validateResults(body.statements) }), { status: 200 });
    }
    throw new Error(`unexpected fetch: ${String(input)}`);
  }));
});
afterEach(() => vi.unstubAllGlobals());

describe('PUT /v1/apps/:appId/tools', () => {
  it('registers valid tools', async () => {
    // Mock: first call = requireAppOwner lookup, rest = batch
    const ownerStmt = mockStmt({ first: { creator_id: 'gh:1' } });
    const db = mockD1(ownerStmt);
    const res = await app.request(
      '/v1/apps/test-app/tools',
      {
        method: 'PUT',
        headers: { Authorization: `Bearer ${TOK}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ tools: [validTool] }),
      },
      makeEnv({}, db),
    );
    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean; registered: number };
    expect(body.ok).toBe(true);
    expect(body.registered).toBe(1);
    expect(db.batch).toHaveBeenCalledTimes(1);
  });

  it('rejects DDL in SQL', async () => {
    const ownerStmt = mockStmt({ first: { creator_id: 'gh:1' } });
    const db = mockD1(ownerStmt);
    const res = await app.request(
      '/v1/apps/test-app/tools',
      {
        method: 'PUT',
        headers: { Authorization: `Bearer ${TOK}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          tools: [{ ...validTool, sql: 'SELECT * FROM items; DROP TABLE items' }],
        }),
      },
      makeEnv({}, db),
    );
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toContain('semicolon');
  });

  it('rejects semicolons in SQL', async () => {
    const ownerStmt = mockStmt({ first: { creator_id: 'gh:1' } });
    const db = mockD1(ownerStmt);
    const res = await app.request(
      '/v1/apps/test-app/tools',
      {
        method: 'PUT',
        headers: { Authorization: `Bearer ${TOK}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          tools: [{ ...validTool, sql: 'SELECT 1; DROP TABLE items' }],
        }),
      },
      makeEnv({}, db),
    );
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toContain('semicolon');
  });

  it('rejects UPDATE without WHERE', async () => {
    const ownerStmt = mockStmt({ first: { creator_id: 'gh:1' } });
    const db = mockD1(ownerStmt);
    const res = await app.request(
      '/v1/apps/test-app/tools',
      {
        method: 'PUT',
        headers: { Authorization: `Bearer ${TOK}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          tools: [{
            ...validTool,
            name: 'update_all',
            operation: 'execute',
            sql: 'UPDATE items SET status = :status',
          }],
        }),
      },
      makeEnv({}, db),
    );
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toContain('WHERE');
  });

  it('rejects undeclared SQL params', async () => {
    const ownerStmt = mockStmt({ first: { creator_id: 'gh:1' } });
    const db = mockD1(ownerStmt);
    const res = await app.request(
      '/v1/apps/test-app/tools',
      {
        method: 'PUT',
        headers: { Authorization: `Bearer ${TOK}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          tools: [{
            ...validTool,
            sql: 'SELECT * FROM items WHERE x = :unknown_param',
            params: {},
          }],
        }),
      },
      makeEnv({}, db),
    );
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toContain('unknown_param');
  });

  it('allows magic params without declaration', async () => {
    const ownerStmt = mockStmt({ first: { creator_id: 'gh:1' } });
    const db = mockD1(ownerStmt);
    const res = await app.request(
      '/v1/apps/test-app/tools',
      {
        method: 'PUT',
        headers: { Authorization: `Bearer ${TOK}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          tools: [{
            name: 'save_item',
            description: 'Save an item',
            operation: 'execute',
            sql: 'INSERT INTO saved (id, user_id, item_id, saved_at) VALUES (:__uuid, :__user_id, :item_id, :__now)',
            params: { item_id: { type: 'string' } },
            requires_auth: true,
          }],
        }),
      },
      makeEnv({}, db),
    );
    expect(res.status).toBe(200);
  });

  it('accepts explicit auth role metadata', async () => {
    const ownerStmt = mockStmt({ first: { creator_id: 'gh:1' } });
    const db = mockD1(ownerStmt);
    const res = await app.request(
      '/v1/apps/test-app/tools',
      {
        method: 'PUT',
        headers: { Authorization: `Bearer ${TOK}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          tools: [{
            ...validTool,
            requires_auth: true,
            auth: { required: true, platform_roles: ['creator'], app_roles: ['manager'] },
          }],
        }),
      },
      makeEnv({}, db),
    );
    expect(res.status).toBe(200);
  });

  it('rejects malformed auth role metadata', async () => {
    const ownerStmt = mockStmt({ first: { creator_id: 'gh:1' } });
    const db = mockD1(ownerStmt);
    const res = await app.request(
      '/v1/apps/test-app/tools',
      {
        method: 'PUT',
        headers: { Authorization: `Bearer ${TOK}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          tools: [{ ...validTool, auth: { app_roles: 'manager' } }],
        }),
      },
      makeEnv({}, db),
    );
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toContain('auth.app_roles');
  });

  it('rejects without auth', async () => {
    const res = await app.request(
      '/v1/apps/test-app/tools',
      {
        method: 'PUT',
        headers: { Authorization: 'Bearer bad', 'Content-Type': 'application/json' },
        body: JSON.stringify({ tools: [validTool] }),
      },
      makeEnv(),
    );
    expect(res.status).toBe(401);
  });

  it('blocks registration when an action references a missing column (#33)', async () => {
    // Data worker reports the SELECT fails to compile — column doesn't exist.
    validateResults = (stmts) => stmts.map((s) => ({ id: s.id, ok: false, error: 'no such column: status' }));
    const ownerStmt = mockStmt({ first: { creator_id: 'gh:1' } });
    const db = mockD1(ownerStmt);
    const res = await app.request(
      '/v1/apps/test-app/tools',
      {
        method: 'PUT',
        headers: { Authorization: `Bearer ${TOK}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ tools: [validTool] }),
      },
      makeEnv({ INTERNAL_TOKEN: 'secret' }, db),
    );
    expect(res.status).toBe(422);
    const body = await res.json() as { error: string; details: string[] };
    expect(body.error).toContain('schema coherence');
    expect(body.details.join('\n')).toContain('list_items');
    expect(body.details.join('\n')).toContain('no such column: status');
    // nothing persisted — the drift never reaches the app_tools table
    expect(db.batch).not.toHaveBeenCalled();
  });

  it('fails open (registers) when the data worker is unreachable (#33)', async () => {
    // Coherence check is defense-in-depth, not a new single point of failure.
    (fetch as unknown as ReturnType<typeof vi.fn>).mockImplementation(async () => { throw new Error('ECONNREFUSED'); });
    const ownerStmt = mockStmt({ first: { creator_id: 'gh:1' } });
    const db = mockD1(ownerStmt);
    const res = await app.request(
      '/v1/apps/test-app/tools',
      {
        method: 'PUT',
        headers: { Authorization: `Bearer ${TOK}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ tools: [validTool] }),
      },
      makeEnv({ INTERNAL_TOKEN: 'secret' }, db),
    );
    expect(res.status).toBe(200);
    expect((await res.json() as { registered: number }).registered).toBe(1);
    expect(db.batch).toHaveBeenCalledTimes(1);
  });
});

describe('PUT /v1/apps/:appId/tools — batch tools', () => {
  const batchTool = {
    name: 'atomic_pair',
    description: 'two atomic writes',
    operation: 'batch',
    statements: [
      'INSERT INTO a (id, owner) VALUES (:id, :__user_id)',
      'UPDATE b SET a_id = :id WHERE owner = :__user_id',
    ],
    params: { id: { type: 'string' } },
    requires_auth: true,
  };

  const put = (tool: unknown) => {
    const ownerStmt = mockStmt({ first: { creator_id: 'gh:1' } });
    const db = mockD1(ownerStmt);
    return app.request(
      '/v1/apps/test-app/tools',
      {
        method: 'PUT',
        headers: { Authorization: `Bearer ${TOK}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ tools: [tool] }),
      },
      makeEnv({}, db),
    );
  };

  it('accepts a valid batch tool', async () => {
    const res = await put(batchTool);
    expect(res.status).toBe(200);
  });

  it('rejects batch tools that also declare sql', async () => {
    const res = await put({ ...batchTool, sql: 'SELECT 1' });
    expect(res.status).toBe(400);
  });

  it('rejects non-batch tools that declare statements', async () => {
    const res = await put({ ...batchTool, operation: 'execute', sql: undefined });
    expect(res.status).toBe(400);
  });

  it('rejects empty or oversized statements arrays', async () => {
    expect((await put({ ...batchTool, statements: [] })).status).toBe(400);
    expect((await put({ ...batchTool, statements: Array(26).fill(batchTool.statements[0]) })).status).toBe(400);
  });

  it('rejects DDL inside any batch member', async () => {
    const res = await put({ ...batchTool, statements: [batchTool.statements[0], 'DROP TABLE a'] });
    expect(res.status).toBe(400);
  });

  it('validates undeclared params across ALL statements', async () => {
    const res = await put({ ...batchTool, statements: [batchTool.statements[0], 'UPDATE b SET x = :mystery'] });
    expect(res.status).toBe(400);
  });
});

describe('GET /v1/tools', () => {
  it('returns all tools across apps', async () => {
    const manifest = JSON.stringify(validTool);
    const allStmt = mockStmt({
      all: {
        results: [
          { app_id: 'jobs', name: 'list_items', manifest },
          { app_id: 'kanban', name: 'list_boards', manifest },
        ],
      },
    });
    const db = mockD1(allStmt);
    const res = await app.request('/v1/tools', {}, makeEnv({}, db));
    expect(res.status).toBe(200);
    const body = await res.json() as { tools: Array<{ app_id: string; name: string }> };
    expect(body.tools).toHaveLength(2);
    expect(body.tools[0].app_id).toBe('jobs');
    expect(body.tools[1].app_id).toBe('kanban');
  });
});

describe('GET /v1/apps/:appId/tools', () => {
  it('returns tools for one app', async () => {
    const manifest = JSON.stringify(validTool);
    const stmt = mockStmt({
      all: { results: [{ name: 'list_items', manifest, updated_at: 1000 }] },
    });
    const db = mockD1(stmt);
    const res = await app.request('/v1/apps/test-app/tools', {}, makeEnv({}, db));
    expect(res.status).toBe(200);
    const body = await res.json() as { tools: Array<{ name: string }> };
    expect(body.tools).toHaveLength(1);
    expect(body.tools[0].name).toBe('list_items');
  });
});

describe('PUT /v1/apps/:appId/tools — requires_auth enforcement', () => {
  it('rejects app data tools without requires_auth', async () => {
    const ownerStmt = mockStmt({ first: { creator_id: 'gh:1' } });
    const db = mockD1(ownerStmt);
    const res = await app.request(
      '/v1/apps/test-app/tools',
      {
        method: 'PUT',
        headers: { Authorization: `Bearer ${TOK}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          tools: [{
            name: 'public_items',
            description: 'Public items',
            operation: 'query',
            sql: 'SELECT * FROM items',
            params: {},
          }],
        }),
      },
      makeEnv({}, db),
    );
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toContain('requires_auth');
  });

  it('rejects __user_id in SQL without requires_auth', async () => {
    const ownerStmt = mockStmt({ first: { creator_id: 'gh:1' } });
    const db = mockD1(ownerStmt);
    const res = await app.request(
      '/v1/apps/test-app/tools',
      {
        method: 'PUT',
        headers: { Authorization: `Bearer ${TOK}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          tools: [{
            name: 'my_items',
            description: 'My items',
            operation: 'query',
            sql: 'SELECT * FROM items WHERE user_id = :__user_id',
            params: {},
            // requires_auth NOT set — should fail
          }],
        }),
      },
      makeEnv({}, db),
    );
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toContain('requires_auth');
  });

  it('accepts __user_id with requires_auth: true', async () => {
    const ownerStmt = mockStmt({ first: { creator_id: 'gh:1' } });
    const db = mockD1(ownerStmt);
    const res = await app.request(
      '/v1/apps/test-app/tools',
      {
        method: 'PUT',
        headers: { Authorization: `Bearer ${TOK}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          tools: [{
            name: 'my_items',
            description: 'My items',
            operation: 'query',
            sql: 'SELECT * FROM items WHERE user_id = :__user_id',
            params: {},
            requires_auth: true,
          }],
        }),
      },
      makeEnv({}, db),
    );
    expect(res.status).toBe(200);
  });
});

describe('GET /v1/tools — JSON.parse safety', () => {
  it('skips rows with corrupted manifest JSON', async () => {
    const goodManifest = JSON.stringify(validTool);
    const stmt = mockStmt({
      all: {
        results: [
          { app_id: 'jobs', name: 'good', manifest: goodManifest },
          { app_id: 'jobs', name: 'bad', manifest: '{corrupt json!!!' },
          { app_id: 'kanban', name: 'also_good', manifest: goodManifest },
        ],
      },
    });
    const db = mockD1(stmt);
    const res = await app.request('/v1/tools', {}, makeEnv({}, db));
    expect(res.status).toBe(200);
    const body = await res.json() as { tools: Array<{ name: string }> };
    // Corrupted row skipped, other two returned
    expect(body.tools).toHaveLength(2);
  });
});

describe('GET /v1/apps/:appId/tools — JSON.parse safety', () => {
  it('skips rows with corrupted manifest JSON', async () => {
    const goodManifest = JSON.stringify(validTool);
    const stmt = mockStmt({
      all: {
        results: [
          { name: 'good', manifest: goodManifest, updated_at: 1000 },
          { name: 'bad', manifest: 'not-json', updated_at: 2000 },
        ],
      },
    });
    const db = mockD1(stmt);
    const res = await app.request('/v1/apps/test-app/tools', {}, makeEnv({}, db));
    expect(res.status).toBe(200);
    const body = await res.json() as { tools: Array<{ name: string }> };
    expect(body.tools).toHaveLength(1);
    expect(body.tools[0].name).toBe('list_items');
  });
});

describe('DELETE /v1/apps/:appId/tools', () => {
  it('deletes all tools for an app', async () => {
    const ownerStmt = mockStmt({ first: { creator_id: 'gh:1' } });
    const deleteStmt = mockStmt();
    const db = mockD1(ownerStmt, deleteStmt);
    const res = await app.request(
      '/v1/apps/test-app/tools',
      {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${TOK}` },
      },
      makeEnv({}, db),
    );
    expect(res.status).toBe(200);
  });
});

describe('POST /v1/apps/:appId/tools/internal — service-to-service (Agent Teams deploy)', () => {
  const internalPost = (body: unknown, headers: Record<string, string> = {}, db = mockD1()) =>
    app.request(
      '/v1/apps/test-app/tools/internal',
      { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) },
      makeEnv({ INTERNAL_TOKEN: 'secret' }, db),
    ).then((res) => ({ res, db }));

  it('403s without the internal token (no owner session needed either)', async () => {
    const { res } = await internalPost({ tools: [validTool] });
    expect(res.status).toBe(403);
  });

  it('403s with the wrong internal token', async () => {
    const { res } = await internalPost({ tools: [validTool] }, { 'X-Internal-Token': 'nope' });
    expect(res.status).toBe(403);
  });

  it('registers valid tools with just the internal token', async () => {
    const { res, db } = await internalPost({ tools: [validTool] }, { 'X-Internal-Token': 'secret' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, registered: 1 });
    expect(db.batch).toHaveBeenCalledTimes(1);
  });

  it('treats empty/missing tools as a clear (200, DELETE-only batch)', async () => {
    const { res, db } = await internalPost({ tools: [] }, { 'X-Internal-Token': 'secret' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, registered: 0 });
    expect(db.batch.mock.calls[0]![0]).toHaveLength(1);

    const missing = await internalPost({}, { 'X-Internal-Token': 'secret' });
    expect(missing.res.status).toBe(200);
  });

  it('applies the same manifest validation as the owner PUT', async () => {
    const { res } = await internalPost(
      { tools: [{ ...validTool, sql: 'SELECT 1; DROP TABLE items' }] },
      { 'X-Internal-Token': 'secret' },
    );
    expect(res.status).toBe(400);
    expect((await res.json() as { error: string }).error).toContain('semicolon');
  });

  it('rejects an invalid app id', async () => {
    const res = await app.request(
      '/v1/apps/Bad_Id/tools/internal',
      { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Internal-Token': 'secret' }, body: JSON.stringify({ tools: [] }) },
      makeEnv({ INTERNAL_TOKEN: 'secret' }),
    );
    expect(res.status).toBe(400);
  });
});
