import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { app } from '../index.js';
import { mainStatementVerb, measureManifestCost, MANIFEST_BYTES_SOFT_LIMIT, MAX_TOOLS_PER_APP } from './tools.js';
import { testToken, TEST_SK, mockStmt, makeEnv as sharedMakeEnv } from '../test-helpers.js';

const TOK = await testToken('gh:1');

function mockD1(...stmts: ReturnType<typeof mockStmt>[]) {
  const prepare = vi.fn();
  for (const stmt of stmts) prepare.mockReturnValueOnce(stmt);
  prepare.mockReturnValue(mockStmt());
  return { prepare, batch: vi.fn().mockResolvedValue([]) };
}

function makeEnv(overrides: Record<string, unknown> = {}, db?: ReturnType<typeof mockD1>) {
  return sharedMakeEnv(overrides, db ?? mockD1());
}

const validTool = {
  name: 'list_items',
  description: 'List items',
  operation: 'query',
  sql: 'SELECT * FROM items WHERE user_id = :__user_id AND (:status IS NULL OR status = :status) LIMIT :limit',
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

  it('registers query tools that use a read CTE', async () => {
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
            sql: 'WITH current_org AS (SELECT :org_id AS org_id) SELECT * FROM items WHERE user_id = :__user_id LIMIT :limit',
            params: {
              ...validTool.params,
              org_id: { type: 'string', optional: true },
            },
          }],
        }),
      },
      makeEnv({}, db),
    );
    expect(res.status).toBe(200);
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

// SECURITY (#158): the two listings used to spread the whole stored manifest
// into the response, so every app's SQL — the app's authorization model — was
// downloadable with no credential. Public callers now get an allowlisted view;
// the full manifest goes only to the app's team via requireAppAccess('viewer').
const ADMIN_TOK = await testToken('gh:900', { roles: ['user', 'admin'] });

describe('GET tool listings — SQL only to the app team (#158)', () => {
  const PUBLIC_FIELDS = ['name', 'description', 'operation', 'params', 'requires_auth', 'updated_at'];

  const batchTool = {
    name: 'archive_board',
    description: 'Archive a board and its cards',
    operation: 'batch',
    statements: [
      'UPDATE boards SET archived = 1 WHERE id = :id AND owner_id = :__user_id',
      'UPDATE cards SET archived = 1 WHERE board_id = :id',
    ],
    params: { id: { type: 'string' } },
    requires_auth: true,
  };
  const unscopedTool = {
    name: 'reap_stale',
    description: 'Delete stale rows',
    operation: 'execute',
    sql: "DELETE FROM sessions WHERE expires_at < :now",
    params: { now: { type: 'integer' } },
    requires_auth: true,
    auth: { platform_roles: ['admin'], caller_unscoped: { reason: 'housekeeping over all users' } },
  };
  const rows = (...tools: object[]) =>
    mockStmt({ all: { results: tools.map((t, i) => ({ name: (t as { name: string }).name, manifest: JSON.stringify(t), updated_at: 1000 + i })) } });

  type Tool = Record<string, unknown> & { auth?: Record<string, unknown> };
  const list = async (headers: Record<string, string>, db: ReturnType<typeof mockD1>) => {
    const res = await app.request('/v1/apps/test-app/tools', { headers }, makeEnv({}, db));
    return { res, tools: ((await res.json()) as { tools: Tool[] }).tools };
  };

  it('anonymous: names/params only, no sql, statements, or unknown fields', async () => {
    const withExtra = { ...validTool, future_private_field: 'leak me' };
    const { res, tools } = await list({}, mockD1(rows(withExtra, batchTool, unscopedTool)));
    expect(res.status).toBe(200);
    expect(tools).toHaveLength(3);
    for (const t of tools) {
      expect(Object.keys(t).sort()).toEqual(expect.arrayContaining(PUBLIC_FIELDS));
      expect(t).not.toHaveProperty('sql');
      expect(t).not.toHaveProperty('statements');
      expect(t).not.toHaveProperty('future_private_field');
    }
    expect(tools[0]).toMatchObject({ name: 'list_items', operation: 'query', requires_auth: true, params: validTool.params });
    expect(tools[1]).toMatchObject({ name: 'archive_board', operation: 'batch' });
    expect(res.headers.get('Cache-Control')).toBeNull();
  });

  it('anonymous: auth keeps roles but drops the caller_unscoped reason', async () => {
    const { tools } = await list({}, mockD1(rows(unscopedTool)));
    expect(tools[0].auth).toEqual({ required: undefined, platform_roles: ['admin'], app_roles: undefined });
    expect(JSON.stringify(tools[0])).not.toContain('housekeeping');
  });

  it('signed-in non-member: same public view as anonymous', async () => {
    // requireAppAccess: apps.creator_id is someone else, no team_members row.
    const db = mockD1(mockStmt({ first: { creator_id: 'gh:2' } }), mockStmt({ first: null }), rows(validTool, batchTool));
    const { res, tools } = await list({ Authorization: `Bearer ${TOK}` }, db);
    expect(res.status).toBe(200);
    expect(tools).toHaveLength(2);
    expect(tools.some((t) => 'sql' in t || 'statements' in t)).toBe(false);
    expect(res.headers.get('Cache-Control')).toBeNull();
  });

  it('team viewer: full manifests, private no-store', async () => {
    const db = mockD1(mockStmt({ first: { creator_id: 'gh:2' } }), mockStmt({ first: { role: 'viewer' } }), rows(validTool, batchTool, unscopedTool));
    const { res, tools } = await list({ Authorization: `Bearer ${TOK}` }, db);
    expect(tools[0].sql).toBe(validTool.sql);
    expect(tools[1].statements).toEqual(batchTool.statements);
    expect(tools[2].auth).toEqual(unscopedTool.auth);
    expect(tools[0].updated_at).toBe(1000);
    expect(res.headers.get('Cache-Control')).toBe('private, no-store');
  });

  it('owner: full manifests, private no-store', async () => {
    const db = mockD1(mockStmt({ first: { creator_id: 'gh:1' } }), rows(validTool, batchTool));
    const { res, tools } = await list({ Authorization: `Bearer ${TOK}` }, db);
    expect(tools[0].sql).toBe(validTool.sql);
    expect(tools[1].statements).toEqual(batchTool.statements);
    expect(res.headers.get('Cache-Control')).toBe('private, no-store');
  });

  it('platform admin: full manifests without any app lookup', async () => {
    const db = mockD1(rows(validTool));
    const { res, tools } = await list({ Authorization: `Bearer ${ADMIN_TOK}` }, db);
    expect(tools[0].sql).toBe(validTool.sql);
    expect(res.headers.get('Cache-Control')).toBe('private, no-store');
  });

  it('an invalid or expired bearer degrades to the public view rather than 401', async () => {
    // The listing is public by contract (#37); a bad token must not make it
    // stricter than no token, only deny the SQL.
    const { res, tools } = await list({ Authorization: 'Bearer nope' }, mockD1(rows(validTool)));
    expect(res.status).toBe(200);
    expect(tools[0]).not.toHaveProperty('sql');
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

  it('accepts a public read-only query with a literal LIMIT', async () => {
    const ownerStmt = mockStmt({ first: { creator_id: 'gh:1' } });
    const db = mockD1(ownerStmt);
    const res = await app.request(
      '/v1/apps/test-app/tools',
      {
        method: 'PUT',
        headers: { Authorization: `Bearer ${TOK}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          tools: [{
            name: 'get_org_by_slug',
            description: 'Read public org branding',
            operation: 'query',
            sql: 'SELECT id, name, logo_url FROM orgs WHERE slug = :slug LIMIT 1',
            params: { slug: { type: 'string' } },
            requires_auth: false,
            auth: { required: false },
          }],
        }),
      },
      makeEnv({}, db),
    );
    expect(res.status).toBe(200);
  });

  it('rejects public execute and batch tools', async () => {
    const ownerStmt = mockStmt({ first: { creator_id: 'gh:1' } });
    const db = mockD1(ownerStmt);
    const executeRes = await app.request(
      '/v1/apps/test-app/tools',
      {
        method: 'PUT',
        headers: { Authorization: `Bearer ${TOK}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          tools: [{
            name: 'touch_org',
            description: 'Write public org',
            operation: 'execute',
            sql: 'UPDATE orgs SET touched_at = :__now WHERE id = :id',
            params: { id: { type: 'string' } },
            requires_auth: false,
          }],
        }),
      },
      makeEnv({}, db),
    );
    expect(executeRes.status).toBe(400);

    const batchRes = await app.request(
      '/v1/apps/test-app/tools',
      {
        method: 'PUT',
        headers: { Authorization: `Bearer ${TOK}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          tools: [{
            name: 'batch_public',
            description: 'Batch public',
            operation: 'batch',
            statements: ['INSERT INTO audit (id) VALUES (:__uuid)'],
            params: {},
            requires_auth: false,
          }],
        }),
      },
      makeEnv({}, mockD1(mockStmt({ first: { creator_id: 'gh:1' } }))),
    );
    expect(batchRes.status).toBe(400);
  });

  it('rejects public queries that reference identity or auth roles', async () => {
    const put = (tool: Record<string, unknown>) => app.request(
      '/v1/apps/test-app/tools',
      {
        method: 'PUT',
        headers: { Authorization: `Bearer ${TOK}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ tools: [tool] }),
      },
      makeEnv({}, mockD1(mockStmt({ first: { creator_id: 'gh:1' } }))),
    );
    const base = {
      name: 'public_orgs',
      description: 'Public orgs',
      operation: 'query',
      sql: 'SELECT * FROM orgs LIMIT 10',
      params: {},
      requires_auth: false,
    };

    expect((await put({ ...base, sql: 'SELECT * FROM orgs WHERE user_id = :__user_id LIMIT 10' })).status).toBe(400);
    expect((await put({ ...base, auth: { platform_roles: ['admin'] } })).status).toBe(400);
    expect((await put({ ...base, auth: { app_roles: ['manager'] } })).status).toBe(400);
  });

  it('rejects public queries without a literal LIMIT of 500 or less', async () => {
    const put = (sql: string) => app.request(
      '/v1/apps/test-app/tools',
      {
        method: 'PUT',
        headers: { Authorization: `Bearer ${TOK}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          tools: [{
            name: 'public_orgs',
            description: 'Public orgs',
            operation: 'query',
            sql,
            params: { limit: { type: 'integer' } },
            requires_auth: false,
          }],
        }),
      },
      makeEnv({}, mockD1(mockStmt({ first: { creator_id: 'gh:1' } }))),
    );

    expect((await put('SELECT * FROM orgs')).status).toBe(400);
    expect((await put('SELECT * FROM orgs LIMIT :limit')).status).toBe(400);
    expect((await put('SELECT * FROM orgs LIMIT 10000')).status).toBe(400);
    expect((await put('SELECT * FROM orgs LIMIT 10, 20')).status).toBe(400);
  });
});

describe('PUT /v1/apps/:appId/tools — unscoped statement rejection (#150)', () => {
  const put = (tool: Record<string, unknown>) => app.request(
    '/v1/apps/test-app/tools',
    {
      method: 'PUT',
      headers: { Authorization: `Bearer ${TOK}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ tools: [tool] }),
    },
    makeEnv({}, mockD1(mockStmt({ first: { creator_id: 'gh:1' } }))),
  );
  const reapStale = {
    name: 'reap_stale',
    description: 'Delete expired sessions',
    operation: 'execute',
    sql: 'DELETE FROM sessions WHERE expires_at < :__now',
    params: {},
    requires_auth: true,
  };

  it('rejects an execute write with no :__user_id and no exemption', async () => {
    const res = await put(reapStale);
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string; details: string[] };
    expect(body.error).toContain('caller_unscoped');
    expect(body.details).toEqual([
      '"reap_stale": statement has no :__user_id and no auth.caller_unscoped exemption',
    ]);
  });

  it('rejects a batch tool when any member statement is unscoped, naming the index', async () => {
    const res = await put({
      name: 'rollover',
      description: 'Archive then purge',
      operation: 'batch',
      statements: [
        'UPDATE items SET archived = 1 WHERE user_id = :__user_id',
        'DELETE FROM items WHERE archived = 1',
      ],
      params: {},
      requires_auth: true,
    });
    expect(res.status).toBe(400);
    const body = await res.json() as { details: string[] };
    expect(body.details).toEqual([
      '"rollover" statement[1]: statement has no :__user_id and no auth.caller_unscoped exemption',
    ]);
  });

  it('rejects an authenticated read with no :__user_id — reads leak across tenants too', async () => {
    const res = await put({
      name: 'get_invoice',
      description: 'Read one invoice',
      operation: 'query',
      sql: 'SELECT * FROM invoices WHERE id = :id',
      params: { id: { type: 'string' } },
      requires_auth: true,
    });
    expect(res.status).toBe(400);
    const body = await res.json() as { details: string[] };
    expect(body.details).toEqual([
      '"get_invoice": statement has no :__user_id and no auth.caller_unscoped exemption',
    ]);
  });

  it('accepts an unscoped write that declares auth.caller_unscoped with a reason', async () => {
    const res = await put({
      ...reapStale,
      auth: { caller_unscoped: { reason: 'housekeeping: rows are selected by expiry, not identity' } },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, registered: 1 });
  });

  it('rejects an exemption with an empty or whitespace reason', async () => {
    expect((await put({ ...reapStale, auth: { caller_unscoped: { reason: '' } } })).status).toBe(400);
    expect((await put({ ...reapStale, auth: { caller_unscoped: { reason: '   ' } } })).status).toBe(400);
    expect((await put({ ...reapStale, auth: { caller_unscoped: {} } })).status).toBe(400);
  });

  it('leaves the public requires_auth: false query path unaffected', async () => {
    const res = await put({
      name: 'get_org_by_slug',
      description: 'Read public org branding',
      operation: 'query',
      sql: 'SELECT id, name, logo_url FROM orgs WHERE slug = :slug LIMIT 1',
      params: { slug: { type: 'string' } },
      requires_auth: false,
    });
    expect(res.status).toBe(200);
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

// #155: console-defined endpoints share app_tools under source = 'console'. A
// deploy replaces the CODE rows only, and the api_ namespace belongs to the console.
describe('console endpoints coexist with code tools (#155)', () => {
  const put = (tools: unknown[]) => {
    const db = mockD1(mockStmt({ first: { creator_id: 'gh:1' } }));
    return app.request(
      '/v1/apps/test-app/tools',
      { method: 'PUT', headers: { Authorization: `Bearer ${TOK}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ tools }) },
      makeEnv({}, db),
    ).then(async (res) => ({ res, db }));
  };

  it('a code redeploy — even with an empty tools array — deletes only source = code rows', async () => {
    const { res, db } = await put([]);
    expect(res.status).toBe(200);
    const sqls = db.prepare.mock.calls.map((c) => String(c[0]));
    const del = sqls.find((s) => s.startsWith('DELETE FROM app_tools'))!;
    expect(del).toBe("DELETE FROM app_tools WHERE app_id = ? AND source = 'code'");
    const { db: db2 } = await put([validTool]);
    const ins = db2.prepare.mock.calls.map((c) => String(c[0])).find((s) => s.startsWith('INSERT INTO app_tools'))!;
    expect(ins).toContain("'code'");
  });

  it('rejects a code tool named api_* — the prefix is reserved for console-defined endpoints', async () => {
    const { res } = await put([{ ...validTool, name: 'api_x' }]);
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe('tool "api_x": the api_ prefix is reserved for console-defined endpoints');
  });

  it('the listing carries source for every row, in both the team and the public view', async () => {
    const rows = [
      { name: 'api_my_tasks', manifest: JSON.stringify({ ...validTool, name: 'api_my_tasks' }), updated_at: 1, source: 'console' },
      { name: 'list_items', manifest: JSON.stringify(validTool), updated_at: 1, source: 'code' },
      { name: 'legacy', manifest: JSON.stringify({ ...validTool, name: 'legacy' }), updated_at: 1, source: null },
    ];
    const team = await app.request('/v1/apps/test-app/tools', { headers: { Authorization: `Bearer ${TOK}` } }, makeEnv({}, mockD1(mockStmt({ first: { creator_id: 'gh:1' } }), mockStmt({ all: { results: rows } }))));
    const teamTools = ((await team.json()) as { tools: { name: string; source: string; sql?: string }[] }).tools;
    expect(teamTools.map((t) => [t.name, t.source])).toEqual([['api_my_tasks', 'console'], ['list_items', 'code'], ['legacy', 'code']]);
    const pub = await app.request('/v1/apps/test-app/tools', {}, makeEnv({}, mockD1(mockStmt({ all: { results: rows } }))));
    const pubTools = ((await pub.json()) as { tools: { name: string; source: string; sql?: string; config?: unknown }[] }).tools;
    expect(pubTools.map((t) => t.source)).toEqual(['console', 'code', 'code']);
    expect(pubTools.every((t) => t.sql === undefined && t.config === undefined)).toBe(true);
  });

  it('the owner delete routes touch code rows only', async () => {
    const all = mockD1(mockStmt({ first: { creator_id: 'gh:1' } }), mockStmt());
    await app.request('/v1/apps/test-app/tools', { method: 'DELETE', headers: { Authorization: `Bearer ${TOK}` } }, makeEnv({}, all));
    expect(String(all.prepare.mock.calls[1]![0])).toBe("DELETE FROM app_tools WHERE app_id = ? AND source = 'code'");
    const one = mockD1(mockStmt({ first: { creator_id: 'gh:1' } }), mockStmt());
    await app.request('/v1/apps/test-app/tools/api_my_tasks', { method: 'DELETE', headers: { Authorization: `Bearer ${TOK}` } }, makeEnv({}, one));
    expect(String(one.prepare.mock.calls[1]![0])).toContain("AND source = 'code'");
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
    expect(await res.json()).toMatchObject({ ok: true, registered: 1 });
    expect(db.batch).toHaveBeenCalledTimes(1);
  });

  it('treats empty/missing tools as a clear (200, DELETE-only batch)', async () => {
    const { res, db } = await internalPost({ tools: [] }, { 'X-Internal-Token': 'secret' });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, registered: 0 });
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

// #120: a leading WITH / WITH RECURSIVE clause is a prefix, not a verb. The
// registrar must validate the statement the CTE prefixes.
describe('mainStatementVerb (#120)', () => {
  it('returns the first token when there is no CTE', () => {
    expect(mainStatementVerb('SELECT 1')).toBe('SELECT');
    expect(mainStatementVerb('  insert into t values (1)')).toBe('INSERT');
    expect(mainStatementVerb('')).toBeNull();
  });

  it('skips a single CTE and a recursive one', () => {
    expect(mainStatementVerb('WITH a AS (SELECT 1) SELECT * FROM a')).toBe('SELECT');
    expect(mainStatementVerb(
      'WITH RECURSIVE tok(i, head, rest) AS (SELECT 0, NULL, :line UNION ALL SELECT i+1, substr(rest,1,4), substr(rest,6) FROM tok WHERE rest <> \'\') INSERT INTO puzzle_attempt_moves (attempt_id, ply, san) SELECT :attempt_id, i, head FROM tok WHERE i = :ply',
    )).toBe('INSERT');
  });

  it('skips several CTEs, nested parens, column lists and MATERIALIZED hints', () => {
    expect(mainStatementVerb(
      'WITH a(x) AS NOT MATERIALIZED (SELECT count(*) FROM (SELECT 1)), b AS MATERIALIZED (SELECT x FROM a WHERE x IN (1,2)) UPDATE t SET n = (SELECT x FROM b) WHERE id = :id',
    )).toBe('UPDATE');
  });

  it('is not fooled by parentheses or keywords inside string literals or comments', () => {
    expect(mainStatementVerb("WITH a AS (SELECT ')' AS s, 'it''s (' AS t) DELETE FROM t WHERE s = 'AS (' AND id = :id")).toBe('DELETE');
    expect(mainStatementVerb('WITH a AS (SELECT 1 -- ) SELECT\n) /* ) DROP */ INSERT INTO t SELECT * FROM a')).toBe('INSERT');
  });

  it('returns null for an unterminated CTE', () => {
    expect(mainStatementVerb('WITH a AS (SELECT 1 SELECT * FROM a')).toBeNull();
    expect(mainStatementVerb('WITH a AS SELECT 1')).toBeNull();
  });
});

describe('PUT /v1/apps/:appId/tools — CTE-prefixed statements (#120)', () => {
  const put = (tool: Record<string, unknown>) => {
    const db = mockD1(mockStmt({ first: { creator_id: 'gh:1' } }));
    return app.request(
      '/v1/apps/test-app/tools',
      { method: 'PUT', headers: { Authorization: `Bearer ${TOK}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ tools: [tool] }) },
      makeEnv({}, db),
    );
  };
  const cteInsert =
    'WITH RECURSIVE tok(i, head, rest) AS (SELECT 0, NULL, :line UNION ALL SELECT i+1, substr(rest,1,4), substr(rest,6) FROM tok WHERE rest <> \'\') '
    + 'INSERT INTO puzzle_attempt_moves (attempt_id, user_id, ply, san) SELECT :attempt_id, :__user_id, i, head FROM tok WHERE i = :ply';
  const params = { line: { type: 'string' }, attempt_id: { type: 'string' }, ply: { type: 'integer' } };

  it('accepts an execute tool whose INSERT is prefixed by WITH RECURSIVE (the chess-academy case)', async () => {
    const res = await put({ ...validTool, name: 'submit_puzzle_move', operation: 'execute', sql: cteInsert, params });
    expect(res.status).toBe(200);
  });

  it('accepts a CTE-prefixed UPDATE with a WHERE clause', async () => {
    const res = await put({
      ...validTool, name: 'bump', operation: 'execute', params: { id: { type: 'string' } },
      sql: 'WITH n AS (SELECT count(*) AS c FROM moves WHERE user_id = :__user_id) UPDATE attempts SET moves = (SELECT c FROM n) WHERE id = :id AND user_id = :__user_id',
    });
    expect(res.status).toBe(200);
  });

  it('still requires WHERE on a CTE-prefixed UPDATE', async () => {
    const res = await put({
      ...validTool, name: 'bump_all', operation: 'execute', params: {},
      sql: 'WITH n AS (SELECT 1 AS c) UPDATE attempts SET moves = (SELECT c FROM n)',
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain('WHERE');
  });

  it('still rejects a CTE-prefixed SELECT registered as execute', async () => {
    const res = await put({
      ...validTool, name: 'peek', operation: 'execute', params: {},
      sql: 'WITH a AS (SELECT 1) SELECT * FROM a WHERE user_id = :__user_id',
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain('must not use SELECT');
  });

  it('rejects a CTE that prefixes DDL or an unknown verb', async () => {
    const ddl = await put({ ...validTool, name: 'x', operation: 'execute', params: {}, sql: 'WITH a AS (SELECT 1) DROP TABLE items' });
    expect(ddl.status).toBe(400);
    const values = await put({ ...validTool, name: 'y', operation: 'execute', params: {}, sql: 'WITH a AS (SELECT 1) VALUES (1)' });
    expect(values.status).toBe(400);
    expect(((await values.json()) as { error: string }).error).toContain('SQL must start with');
  });

  it('rejects an unterminated CTE instead of guessing', async () => {
    const res = await put({ ...validTool, name: 'z', operation: 'execute', params: {}, sql: 'WITH a AS (SELECT 1 INSERT INTO t SELECT * FROM a' });
    expect(res.status).toBe(400);
  });
});

// #153: registration-time schema validation is an internal call too.
describe('PUT /v1/apps/:appId/tools — schema validation reaches the data worker directly (#153)', () => {
  it('POSTs /validate to pas-data-<app>.<DATA_WORKER_HOST>, not the public data-* proxy', async () => {
    const db = mockD1(mockStmt({ first: { creator_id: 'gh:1' } }));
    const res = await app.request(
      '/v1/apps/test-app/tools',
      { method: 'PUT', headers: { Authorization: `Bearer ${TOK}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ tools: [validTool] }) },
      makeEnv({ DATA_WORKER_HOST: 'acct.workers.dev' }, db),
    );
    expect(res.status).toBe(200);
    const urls = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.map(([u]) => String(u instanceof Request ? u.url : u));
    const validate = urls.find((u) => u.includes('/validate'));
    expect(validate).toBe('https://pas-data-test-app.acct.workers.dev/validate');
    expect(urls.some((u) => /data-[a-z0-9-]+\.proappstore\.online/.test(u))).toBe(false);
  });
});

// #117: the cap counts tools; the cost is bytes. Registration now reports the
// model-facing payload — name + description + params, never SQL — and warns
// softly above the threshold so an author sees the number in the deploy log.
describe('PUT /v1/apps/:appId/tools — manifest byte cost (#117)', () => {
  const put = (tools: unknown[]) => {
    const db = mockD1(mockStmt({ first: { creator_id: 'gh:1' } }));
    return app.request(
      '/v1/apps/test-app/tools',
      { method: 'PUT', headers: { Authorization: `Bearer ${TOK}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ tools }) },
      makeEnv({}, db),
    );
  };
  type CostBody = { ok: boolean; registered: number; bytes: number; bytesPerTool: number; estimatedTokens: number; warnings: string[] };

  it('reports bytes, bytesPerTool and estimatedTokens beside the count', async () => {
    const res = await put([validTool]);
    expect(res.status).toBe(200);
    const body = (await res.json()) as CostBody;
    const expected = measureManifestCost([validTool as never]);
    expect(body).toMatchObject({ ok: true, registered: 1, ...expected, warnings: [] });
    expect(body.bytes).toBeGreaterThan(0);
    expect(body.bytesPerTool).toBe(body.bytes);
    expect(body.estimatedTokens).toBe(Math.round(body.bytes / 4));
  });

  it('counts only the model-facing view: SQL, operation, requires_auth and auth do not move the number', async () => {
    const lean = { ...validTool, sql: 'SELECT id FROM items WHERE user_id = :__user_id LIMIT :limit' };
    const heavy = {
      ...validTool,
      sql: `SELECT id FROM items WHERE user_id = :__user_id AND (:status IS NULL OR status = :status) ${'/* padding */ '.repeat(500)} LIMIT :limit`,
      auth: { platform_roles: ['creator'], app_roles: ['manager'] },
    };
    expect(measureManifestCost([heavy as never]).bytes).toBe(measureManifestCost([lean as never]).bytes);
    // …while what the model actually sees does.
    const longer = { ...validTool, description: "List the signed-in user's items, newest first, with an optional status filter" };
    expect(measureManifestCost([longer as never]).bytes).toBeGreaterThan(measureManifestCost([validTool as never]).bytes);
    const res = await put([heavy]);
    expect(((await res.json()) as CostBody).bytes).toBe(measureManifestCost([lean as never]).bytes);
  });

  it('warns softly — still 200, still registered — above the byte threshold', async () => {
    // 60 tools with ~1 kB descriptions: well over the 50 kB soft limit, under the 500-tool cap.
    const tools = Array.from({ length: 60 }, (_, i) => ({
      ...validTool,
      name: `list_items_${i}`,
      description: `Tool ${i}: ${'x'.repeat(1_000)}`,
    }));
    const res = await put(tools);
    expect(res.status).toBe(200);
    const body = (await res.json()) as CostBody;
    expect(body.registered).toBe(60);
    expect(body.bytes).toBeGreaterThan(MANIFEST_BYTES_SOFT_LIMIT);
    expect(body.warnings).toHaveLength(1);
    expect(body.warnings[0]).toContain(`${body.bytes} bytes`);
    expect(body.warnings[0]).toContain(`~${body.estimatedTokens} tokens`);
    expect(body.warnings[0]).toMatch(/slimming descriptions|progressive disclosure/);
  });

  // #116: 120 rejected real CRM/ERP-shaped manifests. The cap is an abuse bound
  // above any legitimate surface, and the rejection names both numbers so the
  // deploy log says what was sent and what fits.
  it('accepts a manifest above the old 120 cap', async () => {
    const tools = Array.from({ length: 137 }, (_, i) => ({ ...validTool, name: `list_items_${i}` }));
    const res = await put(tools);
    expect(res.status).toBe(200);
    expect(((await res.json()) as CostBody).registered).toBe(137);
  });

  it(`accepts exactly ${MAX_TOOLS_PER_APP} tools and rejects one more, naming both counts`, async () => {
    const at = Array.from({ length: MAX_TOOLS_PER_APP }, (_, i) => ({ ...validTool, name: `list_items_${i}` }));
    expect((await put(at)).status).toBe(200);
    const over = [...at, { ...validTool, name: 'list_items_overflow' }];
    const res = await put(over);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain(`received ${MAX_TOOLS_PER_APP + 1}, max ${MAX_TOOLS_PER_APP}`);
    expect(MAX_TOOLS_PER_APP).toBe(500);
  });

  it('answers warnings: [] for a small manifest', async () => {
    const res = await put([validTool, { ...validTool, name: 'list_items_b' }]);
    const body = (await res.json()) as CostBody;
    expect(body.warnings).toEqual([]);
    expect(body.bytes).toBeLessThan(MANIFEST_BYTES_SOFT_LIMIT);
    expect(body.registered).toBe(2);
  });

  it('measureManifestCost: an empty manifest is 0 bytes and 0 per tool, never NaN', () => {
    expect(measureManifestCost([])).toEqual({ bytes: 0, bytesPerTool: 0, estimatedTokens: 0 });
  });
});

// #117: `core: true` marks a tool as resident on a large app's MCP session. It is
// validated at registration and published in the public view (it is not sensitive).
describe('PUT /v1/apps/:appId/tools — the core flag (#117)', () => {
  const put = (tools: unknown[]) => {
    const db = mockD1(mockStmt({ first: { creator_id: 'gh:1' } }));
    return app.request(
      '/v1/apps/test-app/tools',
      { method: 'PUT', headers: { Authorization: `Bearer ${TOK}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ tools }) },
      makeEnv({}, db),
    );
  };

  it('accepts core: true / false', async () => {
    expect((await put([{ ...validTool, core: true }])).status).toBe(200);
    expect((await put([{ ...validTool, core: false }])).status).toBe(200);
  });

  it('rejects a non-boolean core', async () => {
    const res = await put([{ ...validTool, core: 'yes' }]);
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain('core must be a boolean');
  });
});

describe('verify tools (#148)', () => {
  const put = (tool: Record<string, unknown>) => app.request(
    '/v1/apps/test-app/tools',
    {
      method: 'PUT',
      headers: { Authorization: `Bearer ${TOK}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ tools: [tool] }),
    },
    makeEnv({}, mockD1(mockStmt({ first: { creator_id: 'gh:1' } }))),
  );
  const error = async (res: Response) => ((await res.json()) as { error: string }).error;
  const claim = {
    name: 'claim_game_over',
    description: 'Verify a claimed result by replaying the stored moves',
    operation: 'verify',
    verifier: 'chess.replay',
    sql: 'SELECT moves FROM games WHERE id = :game_id AND (white_id = :__user_id OR black_id = :__user_id)',
    statements: [
      "UPDATE games SET status = 'finished', result = :__verify_result, end_reason = :__verify_reason WHERE id = :game_id AND (white_id = :__user_id OR black_id = :__user_id) AND :__verify_over = 1",
    ],
    params: { game_id: { type: 'string' } },
    requires_auth: true,
  };

  it('registers a verify tool: the input SELECT, the writes and the verifier id are all persisted; the verifier id is public', async () => {
    const db = mockD1(mockStmt({ first: { creator_id: 'gh:1' } }));
    const res = await app.request(
      '/v1/apps/test-app/tools',
      { method: 'PUT', headers: { Authorization: `Bearer ${TOK}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ tools: [claim] }) },
      makeEnv({}, db),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, registered: 1 });
    // The INSERT's bind carries the manifest JSON as its third argument.
    const binds = db.prepare.mock.results.flatMap((r) => (r.value as ReturnType<typeof mockStmt>).bind.mock.calls as unknown[][]);
    const inserted = JSON.parse(binds.find((c) => typeof c[2] === 'string' && (c[2] as string).startsWith('{'))![2] as string) as Record<string, unknown>;
    expect(inserted).toMatchObject({ operation: 'verify', verifier: 'chess.replay', statements: claim.statements });

    // The public listing exposes which platform verifier runs — but never the SQL.
    const list = await app.request(
      '/v1/apps/test-app/tools',
      {},
      makeEnv({}, mockD1(mockStmt({ all: { results: [{ name: 'claim_game_over', manifest: JSON.stringify(claim), updated_at: 1, source: 'code' }] } }))),
    );
    const { tools } = (await list.json()) as { tools: Record<string, unknown>[] };
    expect(tools[0]).toMatchObject({ operation: 'verify', verifier: 'chess.replay' });
    expect(tools[0]).not.toHaveProperty('sql');
    expect(tools[0]).not.toHaveProperty('statements');
  });

  it('a read-only verify tool (no statements) registers too', async () => {
    const { statements: _s, ...readOnly } = claim;
    expect((await put(readOnly)).status).toBe(200);
  });

  it('the schema-coherence check compiles the input SELECT and every write, with :__verify_* counted as binds', async () => {
    const seen: ValStmt[] = [];
    validateResults = (stmts) => { seen.push(...stmts); return stmts.map((s) => ({ id: s.id, ok: true })); };
    expect((await put(claim)).status).toBe(200);
    expect(seen.map((s) => [s.id, s.paramCount])).toEqual([['claim_game_over#0', 3], ['claim_game_over#1', 6]]);
    validateResults = (stmts) => stmts.map((s) => ({ id: s.id, ok: s.id.endsWith('#0'), error: 'no such column: end_reason' }));
    const drift = await put(claim);
    expect(drift.status).toBe(422);
    expect(((await drift.json()) as { details: string[] }).details).toEqual(['tool "claim_game_over": no such column: end_reason']);
  });

  it('rejects an unknown verifier, a missing or non-SELECT input, and a verifier on a non-verify tool', async () => {
    expect(await error(await put({ ...claim, verifier: 'app.code' }))).toBe('tool "claim_game_over": verifier must be one of: chess.replay');
    expect(await error(await put({ ...claim, verifier: undefined }))).toBe('tool "claim_game_over": verifier must be one of: chess.replay');
    expect(await error(await put({ ...claim, sql: undefined }))).toBe('tool "claim_game_over": verify tools require sql (the SELECT that feeds the verifier)');
    expect(await error(await put({ ...claim, sql: 'DELETE FROM games WHERE id = :game_id AND white_id = :__user_id' }))).toBe('tool "claim_game_over": operation "query" must use SELECT');
    expect(await error(await put({ ...claim, statements: ['SELECT 1 FROM games WHERE id = :game_id AND white_id = :__user_id'] }))).toBe('tool "claim_game_over": operation "execute" must not use SELECT (use "query" instead)');
    expect(await error(await put({ ...claim, operation: 'query', statements: undefined }))).toBe('tool "claim_game_over": only verify tools may declare a verifier');
    // Outside a verify tool the verdict placeholders are just undeclared params.
    expect(await error(await put({ ...claim, operation: 'execute', verifier: undefined, statements: undefined, sql: "UPDATE games SET result = :__verify_result WHERE id = :game_id AND white_id = :__user_id" })))
      .toBe('tool "claim_game_over": SQL references :__verify_result but it is not declared in params');
  });

  it('rejects a verdict placeholder the verifier does not produce, or one in the input SELECT, and a public verify tool', async () => {
    expect(await error(await put({ ...claim, statements: ['UPDATE games SET winner = :__verify_winner WHERE id = :game_id AND white_id = :__user_id'] })))
      .toBe('tool "claim_game_over": SQL references :__verify_winner but verifier "chess.replay" has no output "winner"');
    expect(await error(await put({ ...claim, sql: 'SELECT moves FROM games WHERE id = :game_id AND white_id = :__user_id AND :__verify_over = 1' })))
      .toBe('tool "claim_game_over": the verify input sql cannot reference :__verify_* (the verifier has not run yet)');
    expect(await error(await put({ ...claim, requires_auth: false }))).toBe('tool "claim_game_over": verify tools must require auth');
    expect(await error(await put({ ...claim, statements: Array(26).fill(claim.statements[0]) }))).toBe('tool "claim_game_over": max 25 statements per verify tool');
    expect(await error(await put({ ...claim, statements: [''] }))).toBe('tool "claim_game_over": every statement must be a non-empty string');
    expect(await error(await put({ ...claim, statements: 'nope' }))).toBe('tool "claim_game_over": statements must be an array');
  });

  it('the :__user_id scoping lint covers the input SELECT and every write, naming the index', async () => {
    const res = await put({ ...claim, statements: ["UPDATE games SET status = 'finished' WHERE id = :game_id AND :__verify_over = 1"] });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { details: string[] }).details).toEqual([
      '"claim_game_over" statement[1]: statement has no :__user_id and no auth.caller_unscoped exemption',
    ]);
  });
});
