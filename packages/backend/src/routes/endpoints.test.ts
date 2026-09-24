import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { app } from '../index.js';
import { testToken, mockStmt, makeEnv as sharedMakeEnv } from '../test-helpers.js';
import type { ColumnInfo } from '../lib/endpoint-sql.js';

const TOK = await testToken('gh:1');
const OTHER = await testToken('gh:2');

function mockD1(...stmts: ReturnType<typeof mockStmt>[]) {
  const prepare = vi.fn();
  for (const stmt of stmts) prepare.mockReturnValueOnce(stmt);
  prepare.mockReturnValue(mockStmt());
  return { prepare, batch: vi.fn().mockResolvedValue([]) };
}
const makeEnv = (db: ReturnType<typeof mockD1>) => sharedMakeEnv({ INTERNAL_TOKEN: 'internal-secret' }, db);
const owner = () => mockStmt({ first: { creator_id: 'gh:1' } });

const TASKS: ColumnInfo[] = [
  { name: 'id', type: 'TEXT', notnull: 1, dflt_value: null, pk: 1 },
  { name: 'owner_id', type: 'TEXT', notnull: 1, dflt_value: null, pk: 0 },
  { name: 'title', type: 'TEXT', notnull: 1, dflt_value: null, pk: 0 },
];
const CONFIG = { name: 'api_my_tasks', description: 'My tasks', kind: 'read', table: 'tasks', scope: 'own', owner_column: 'owner_id', columns: ['id', 'title'], page_size: 50 };
const EXPECTED_SQL = 'SELECT "id","title" FROM "tasks" WHERE "owner_id" = :__user_id LIMIT 50';

// The data worker: PRAGMA table_info over /query, EXPLAIN over /validate.
let schemaRows: ColumnInfo[] | 'down';
let validate: (stmts: { id: string; sql: string }[]) => { id: string; ok: boolean; error?: string }[];
const calls: { url: string; headers: Record<string, string>; body: string }[] = [];
beforeEach(() => {
  schemaRows = TASKS;
  validate = (stmts) => stmts.map((s) => ({ id: s.id, ok: true }));
  calls.length = 0;
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, headers: (init?.headers ?? {}) as Record<string, string>, body: String(init?.body ?? '') });
    if (url.endsWith('/query')) {
      if (schemaRows === 'down') throw new Error('unreachable');
      return new Response(JSON.stringify({ rows: schemaRows, meta: {} }), { status: 200 });
    }
    if (url.endsWith('/validate')) {
      const body = JSON.parse(init!.body as string) as { statements: { id: string; sql: string }[] };
      return new Response(JSON.stringify({ results: validate(body.statements) }), { status: 200 });
    }
    throw new Error(`unexpected fetch: ${url}`);
  }));
});
afterEach(() => vi.unstubAllGlobals());

const json = (method: string, path: string, body?: unknown, token = TOK) =>
  ({ method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });

describe('POST /v1/apps/:appId/endpoints/preview', () => {
  it('reads the schema from the data worker with the internal token and answers { manifest }', async () => {
    const res = await app.request('/v1/apps/test-app/endpoints/preview', json('POST', '', { config: CONFIG }), makeEnv(mockD1(owner())));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { manifest: { sql: string } };
    expect(body.manifest.sql).toBe(EXPECTED_SQL);
    const query = calls.find((c) => c.url.endsWith('/query'))!;
    expect(query.url).toBe('https://pas-data-test-app.serge-the-dev.workers.dev/query');
    expect(query.headers['X-Internal-Token']).toBe('internal-secret');
    expect(JSON.parse(query.body)).toEqual({ sql: 'PRAGMA table_info("tasks")' });
  });
  it('400 { error, details } for a bad config, before any schema read', async () => {
    const res = await app.request('/v1/apps/test-app/endpoints/preview', json('POST', '', { config: { ...CONFIG, columns: ['id', 'ghost'] } }), makeEnv(mockD1(owner())));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'invalid endpoint config', details: ['columns: column "ghost" does not exist on "tasks"'] });
    const shape = await app.request('/v1/apps/test-app/endpoints/preview', json('POST', '', { config: { ...CONFIG, name: 'list_tasks' } }), makeEnv(mockD1(owner())));
    expect(shape.status).toBe(400);
    expect(calls.filter((c) => c.url.endsWith('/query'))).toHaveLength(1);
  });
  it('503 when the schema cannot be read', async () => {
    schemaRows = 'down';
    const res = await app.request('/v1/apps/test-app/endpoints/preview', json('POST', '', { config: CONFIG }), makeEnv(mockD1(owner())));
    expect(res.status).toBe(503);
    expect(((await res.json()) as { error: string }).error).toMatch(/could not read the app schema/);
  });
  it('422 when the generated SQL fails schema coherence', async () => {
    validate = (stmts) => stmts.map((s) => ({ id: s.id, ok: false, error: 'no such column: title' }));
    const res = await app.request('/v1/apps/test-app/endpoints/preview', json('POST', '', { config: CONFIG }), makeEnv(mockD1(owner())));
    expect(res.status).toBe(422);
  });
});

describe('PUT /v1/apps/:appId/endpoints/:name', () => {
  it('creates: stores a console row and its audit entry in one batch; answers { endpoint }', async () => {
    const db = mockD1(owner(), mockStmt({ first: null }), mockStmt({ first: { n: 0 } }));
    const res = await app.request('/v1/apps/test-app/endpoints/api_my_tasks', json('PUT', '', { config: CONFIG }), makeEnv(db));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { endpoint: { name: string; status: string; manifest: { sql: string }; updated_by: string } };
    expect(body.endpoint).toMatchObject({ name: 'api_my_tasks', status: 'ok', updated_by: 'gh:1' });
    expect(body.endpoint.manifest.sql).toBe(EXPECTED_SQL);
    expect(db.batch).toHaveBeenCalledTimes(1);
    const sqls = db.prepare.mock.calls.map((c) => String(c[0]));
    expect(sqls.some((s) => s.startsWith('INSERT INTO app_tools') && s.includes("'console'"))).toBe(true);
    expect(sqls.some((s) => s.startsWith('INSERT INTO app_endpoint_audit'))).toBe(true);
  });
  it('updates an existing console row (no cap query) and audits it', async () => {
    const db = mockD1(owner(), mockStmt({ first: { source: 'console' } }));
    const res = await app.request('/v1/apps/test-app/endpoints/api_my_tasks', json('PUT', '', { config: CONFIG }), makeEnv(db));
    expect(res.status).toBe(200);
    const sqls = db.prepare.mock.calls.map((c) => String(c[0]));
    expect(sqls.some((s) => s.startsWith('UPDATE app_tools SET manifest'))).toBe(true);
    expect(sqls.some((s) => s.includes('COUNT(*)'))).toBe(false);
  });
  it('409 when the name belongs to a code action', async () => {
    const db = mockD1(owner(), mockStmt({ first: { source: 'code' } }));
    const res = await app.request('/v1/apps/test-app/endpoints/api_my_tasks', json('PUT', '', { config: CONFIG }), makeEnv(db));
    expect(res.status).toBe(409);
    expect(db.batch).not.toHaveBeenCalled();
  });
  it('400 without the api_ prefix — a can_* oracle name can never be produced', async () => {
    for (const name of ['list_tasks', 'can_provision_student_credentials']) {
      const res = await app.request(`/v1/apps/test-app/endpoints/${name}`, json('PUT', '', { config: { ...CONFIG, name } }), makeEnv(mockD1(owner())));
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: string }).error).toMatch(/api_ prefix is required/);
    }
  });
  it('400 when config.name differs from the URL, when scope all lacks roles, and when public exceeds 500', async () => {
    expect((await app.request('/v1/apps/test-app/endpoints/api_other', json('PUT', '', { config: CONFIG }), makeEnv(mockD1(owner())))).status).toBe(400);
    const all = await app.request('/v1/apps/test-app/endpoints/api_my_tasks', json('PUT', '', { config: { ...CONFIG, scope: 'all', owner_column: undefined } }), makeEnv(mockD1(owner())));
    expect(all.status).toBe(400);
    const pub = await app.request('/v1/apps/test-app/endpoints/api_my_tasks', json('PUT', '', { config: { ...CONFIG, scope: 'public', owner_column: undefined, page_size: 501 } }), makeEnv(mockD1(owner())));
    expect(pub.status).toBe(400);
  });
  it('scope all with roles and public with 500 both store manifests the executor accepts', async () => {
    const all = await app.request('/v1/apps/test-app/endpoints/api_my_tasks', json('PUT', '', { config: { ...CONFIG, scope: 'all', owner_column: undefined, app_roles: ['admin'] } }), makeEnv(mockD1(owner(), mockStmt({ first: null }), mockStmt({ first: { n: 0 } }))));
    expect(all.status).toBe(200);
    expect(((await all.json()) as { endpoint: { manifest: { auth: unknown } } }).endpoint.manifest.auth).toMatchObject({ app_roles: ['admin'] });
    const pub = await app.request('/v1/apps/test-app/endpoints/api_my_tasks', json('PUT', '', { config: { ...CONFIG, scope: 'public', owner_column: undefined, page_size: 500 } }), makeEnv(mockD1(owner(), mockStmt({ first: null }), mockStmt({ first: { n: 0 } }))));
    expect(pub.status).toBe(200);
    expect(((await pub.json()) as { endpoint: { manifest: { requires_auth: boolean; sql: string } } }).endpoint.manifest).toMatchObject({ requires_auth: false, sql: 'SELECT "id","title" FROM "tasks" LIMIT 500' });
  });
  it('400 at the console cap', async () => {
    const db = mockD1(owner(), mockStmt({ first: null }), mockStmt({ first: { n: 30 } }));
    const res = await app.request('/v1/apps/test-app/endpoints/api_my_tasks', json('PUT', '', { config: CONFIG }), makeEnv(db));
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toMatch(/max 30 console endpoints/);
  });
  it('an insert with generated id passes the write lint without caller_unscoped', async () => {
    const config = { name: 'api_add_task', description: 'Add', kind: 'insert', table: 'tasks', scope: 'own', owner_column: 'owner_id', columns: ['title'], generated: { id: '__uuid' } };
    const res = await app.request('/v1/apps/test-app/endpoints/api_add_task', json('PUT', '', { config }), makeEnv(mockD1(owner(), mockStmt({ first: null }), mockStmt({ first: { n: 0 } }))));
    expect(res.status).toBe(200);
    const m = ((await res.json()) as { endpoint: { manifest: { sql: string; auth?: unknown } } }).endpoint.manifest;
    expect(m.sql).toBe('INSERT INTO "tasks" ("owner_id", "id", "title") VALUES (:__user_id, :__uuid, :title)');
    expect(m.auth).toBeUndefined();
  });
  it('401 without a session, 403 for a non-owner session', async () => {
    const anon = await app.request('/v1/apps/test-app/endpoints/api_my_tasks', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ config: CONFIG }) }, makeEnv(mockD1()));
    expect(anon.status).toBe(401);
    const db = mockD1(mockStmt({ first: { creator_id: 'gh:1' } }), mockStmt({ first: { role: 'viewer' } }));
    const other = await app.request('/v1/apps/test-app/endpoints/api_my_tasks', json('PUT', '', { config: CONFIG }, OTHER), makeEnv(db));
    expect(other.status).toBe(403);
    expect(calls).toHaveLength(0);
  });
});

describe('GET /v1/apps/:appId/endpoints', () => {
  it('lists console rows with status from schema coherence; a dropped column reads broken with the error', async () => {
    const manifest = JSON.stringify({ name: 'api_my_tasks', description: 'x', operation: 'query', sql: EXPECTED_SQL, params: {}, requires_auth: true });
    const gone = JSON.stringify({ name: 'api_due', description: 'x', operation: 'query', sql: 'SELECT "due_at" FROM "tasks" WHERE "owner_id" = :__user_id LIMIT 10', params: {}, requires_auth: true });
    validate = (stmts) => stmts.map((s) => (s.id.startsWith('api_due') ? { id: s.id, ok: false, error: 'no such column: due_at' } : { id: s.id, ok: true }));
    const db = mockD1(owner(), mockStmt({ all: { results: [
      { name: 'api_due', manifest: gone, config: JSON.stringify({ ...CONFIG, name: 'api_due' }), updated_at: 2, updated_by: 'gh:1', source: 'console' },
      { name: 'api_my_tasks', manifest, config: JSON.stringify(CONFIG), updated_at: 1, updated_by: 'gh:1', source: 'console' },
    ] } }));
    const res = await app.request('/v1/apps/test-app/endpoints', json('GET', ''), makeEnv(db));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { endpoints: { name: string; status: string; error?: string; config: unknown }[] };
    expect(body.endpoints).toEqual([
      expect.objectContaining({ name: 'api_due', status: 'broken', error: 'no such column: due_at' }),
      expect.objectContaining({ name: 'api_my_tasks', status: 'ok', config: CONFIG }),
    ]);
    expect(body.endpoints[1]).not.toHaveProperty('error');
    expect(String(db.prepare.mock.calls[1]![0])).toContain("source = 'console'");
  });
});

describe('DELETE /v1/apps/:appId/endpoints/:name', () => {
  it('deletes a console row with an audit entry; 404 for anything else', async () => {
    const db = mockD1(owner(), mockStmt({ first: { present: 1 } }));
    const res = await app.request('/v1/apps/test-app/endpoints/api_my_tasks', json('DELETE', ''), makeEnv(db));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    const sqls = db.prepare.mock.calls.map((c) => String(c[0]));
    expect(sqls.some((s) => s.startsWith('DELETE FROM app_tools') && s.includes("source = 'console'"))).toBe(true);
    expect(sqls.some((s) => s.startsWith('INSERT INTO app_endpoint_audit'))).toBe(true);
    const missing = await app.request('/v1/apps/test-app/endpoints/list_tasks', json('DELETE', ''), makeEnv(mockD1(owner(), mockStmt({ first: null }))));
    expect(missing.status).toBe(404);
  });
});
