import { describe, expect, it } from 'vitest';
import {
  CONSOLE_ENDPOINT_CAP,
  ENDPOINT_NAME_RE,
  generateEndpointManifest,
  paramTypeFor,
  validateEndpointConfig,
  type ColumnInfo,
  type EndpointConfig,
} from './endpoint-sql.js';

const col = (name: string, type: string, o: Partial<ColumnInfo> = {}): ColumnInfo =>
  ({ name, type, notnull: 0, dflt_value: null, pk: 0, ...o });

const TASKS: ColumnInfo[] = [
  col('id', 'TEXT', { notnull: 1, pk: 1 }),
  col('owner_id', 'TEXT', { notnull: 1 }),
  col('title', 'TEXT', { notnull: 1 }),
  col('status', 'TEXT', { notnull: 1, dflt_value: "'open'" }),
  col('priority', 'INTEGER'),
  col('due_at', 'INTEGER'),
  col('created_at', 'INTEGER', { notnull: 1 }),
];

const read: EndpointConfig = {
  name: 'api_my_tasks', description: 'My tasks', kind: 'read', table: 'tasks', scope: 'own',
  owner_column: 'owner_id', columns: ['id', 'title'], page_size: 50,
};

describe('validateEndpointConfig', () => {
  it('accepts the acceptance-criteria read config', () => {
    expect(validateEndpointConfig(read)).toEqual([]);
  });
  it('requires the api_ prefix and rejects code / oracle names', () => {
    expect(validateEndpointConfig({ ...read, name: 'list_tasks' })[0]).toMatch(/api_ prefix is required/);
    expect(validateEndpointConfig({ ...read, name: 'can_provision_student_credentials' })[0]).toMatch(/api_/);
    expect(ENDPOINT_NAME_RE.test('api_' + 'a'.repeat(56))).toBe(true);
    expect(ENDPOINT_NAME_RE.test('api_' + 'a'.repeat(57))).toBe(false);
  });
  it('rejects unknown keys anywhere', () => {
    expect(validateEndpointConfig({ ...read, sql: 'SELECT 1' })).toContain('unknown key "sql"');
    expect(validateEndpointConfig({ ...read, filters: [{ column: 'status', op: 'eq', raw: 1 }] })).toContain('filters[0]: unknown key "raw"');
  });
  it('scope all needs roles; public is read-only and capped at 500; own/all capped at 100', () => {
    expect(validateEndpointConfig({ ...read, scope: 'all', owner_column: undefined })).toContain('app_roles is required and must be non-empty for scope "all"');
    expect(validateEndpointConfig({ ...read, scope: 'public', owner_column: undefined, page_size: 501 })).toContain('page_size must be an integer from 1 to 500');
    expect(validateEndpointConfig({ ...read, scope: 'public', owner_column: undefined, page_size: 500 })).toEqual([]);
    expect(validateEndpointConfig({ ...read, page_size: 101 })).toContain('page_size must be an integer from 1 to 100');
    expect(validateEndpointConfig({ ...read, kind: 'insert', scope: 'public', owner_column: undefined, page_size: undefined })).toContain('public endpoints are read-only');
    expect(validateEndpointConfig({ ...read, kind: 'insert', scope: 'all', owner_column: undefined, page_size: undefined, app_roles: ['admin'] })).toContain('insert endpoints support scope "own" only');
  });
});

describe('generateEndpointManifest: read', () => {
  it('emits exactly the acceptance-criteria SQL for an own-rows read', () => {
    const r = generateEndpointManifest(read, TASKS);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.manifest.sql).toBe('SELECT "id","title" FROM "tasks" WHERE "owner_id" = :__user_id LIMIT 50');
    expect(r.manifest).toMatchObject({ name: 'api_my_tasks', operation: 'query', requires_auth: true, params: {} });
    expect(r.manifest.auth).toBeUndefined();
  });
  it('filters, sort and pagination: typed params from column affinity, optional filters as IS NULL guards', () => {
    const r = generateEndpointManifest({
      ...read,
      filters: [{ column: 'status', op: 'eq' }, { column: 'priority', op: 'gte', optional: true, max: 5 }, { column: 'due_at', op: 'lt', optional: true }],
      sort: { column: 'due_at', dir: 'desc' },
      paginate: true,
    }, TASKS);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.manifest.sql).toBe(
      'SELECT "id","title" FROM "tasks" WHERE "owner_id" = :__user_id AND "status" = :status AND (:priority_gte IS NULL OR "priority" >= :priority_gte) AND (:due_at_lt IS NULL OR "due_at" < :due_at_lt) ORDER BY "due_at" DESC LIMIT 50 OFFSET :offset',
    );
    expect(r.manifest.params).toEqual({
      status: { type: 'string', description: 'eq filter on status' },
      priority_gte: { type: 'integer', description: 'gte filter on priority', optional: true, max: 5 },
      due_at_lt: { type: 'integer', description: 'lt filter on due_at', optional: true },
      offset: { type: 'integer', description: 'rows to skip', optional: true, default: 0 },
    });
  });
  it('scope all: role gate plus a declared caller_unscoped reason; public: no auth, no :__user_id', () => {
    const all = generateEndpointManifest({ ...read, scope: 'all', owner_column: undefined, app_roles: ['admin'] }, TASKS);
    expect(all.ok && all.manifest.sql).toBe('SELECT "id","title" FROM "tasks" LIMIT 50');
    expect(all.ok && all.manifest.auth).toEqual({ app_roles: ['admin'], caller_unscoped: { reason: expect.stringContaining('admin') } });
    const pub = generateEndpointManifest({ ...read, scope: 'public', owner_column: undefined, page_size: 500 }, TASKS);
    expect(pub.ok && pub.manifest).toMatchObject({ requires_auth: false, sql: 'SELECT "id","title" FROM "tasks" LIMIT 500' });
    expect(pub.ok && pub.manifest.auth).toBeUndefined();
  });
  it('rejects columns that do not exist before anything reaches D1, and an unknown table', () => {
    const r = generateEndpointManifest({ ...read, columns: ['id', 'nope'] }, TASKS);
    expect(r).toEqual({ ok: false, error: 'invalid endpoint config', details: ['columns: column "nope" does not exist on "tasks"'] });
    expect(generateEndpointManifest(read, [])).toMatchObject({ ok: false, error: 'table "tasks" does not exist' });
    expect(generateEndpointManifest({ ...read, sort: { column: 'ghost', dir: 'asc' } }, TASKS)).toMatchObject({ ok: false, details: ['sort: column "ghost" does not exist on "tasks"'] });
  });
});

describe('generateEndpointManifest: insert', () => {
  const insert: EndpointConfig = {
    name: 'api_add_task', description: 'Add a task', kind: 'insert', table: 'tasks', scope: 'own',
    owner_column: 'owner_id', columns: ['title', 'priority'], generated: { id: '__uuid', created_at: '__now' },
  };
  it('names the NOT NULL primary key when it is neither generated nor writable', () => {
    const r = generateEndpointManifest({ ...insert, generated: { created_at: '__now' } }, TASKS);
    expect(r).toMatchObject({ ok: false, details: ['column "id" is NOT NULL with no default: add it to columns or generated'] });
  });
  it('binds the owner from the caller and the generated columns from the server; passes the write lint shape', () => {
    const r = generateEndpointManifest(insert, TASKS);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.manifest.sql).toBe('INSERT INTO "tasks" ("owner_id", "id", "created_at", "title", "priority") VALUES (:__user_id, :__uuid, :__now, :title, :priority)');
    expect(r.manifest).toMatchObject({ operation: 'execute', requires_auth: true });
    expect(r.manifest.auth).toBeUndefined();
    expect(r.manifest.params).toEqual({
      title: { type: 'string', description: 'value for title' },
      priority: { type: 'integer', description: 'value for priority', optional: true },
    });
  });
  it('a column with a schema DEFAULT is required unless defaults[col] is set, which becomes the param default', () => {
    const without = generateEndpointManifest({ ...insert, columns: ['title', 'status'] }, TASKS);
    expect(without.ok && without.manifest.params.status).toEqual({ type: 'string', description: 'value for status' });
    const withDefault = generateEndpointManifest({ ...insert, columns: ['title', 'status'], defaults: { status: 'open' } }, TASKS);
    expect(withDefault.ok && withDefault.manifest.params.status).toEqual({ type: 'string', description: 'value for status', default: 'open' });
  });
  it('the owner column can be neither writable nor generated', () => {
    expect(generateEndpointManifest({ ...insert, columns: ['title', 'owner_id'] }, TASKS)).toMatchObject({ ok: false, details: expect.arrayContaining([expect.stringContaining('owner column "owner_id" is filled by the server')]) });
    expect(generateEndpointManifest({ ...insert, generated: { id: '__uuid', created_at: '__now', owner_id: '__uuid' } }, TASKS)).toMatchObject({ ok: false });
  });
  it('affinity mapping and the cap constant', () => {
    expect(['INTEGER', 'BIGINT', 'REAL', 'DOUBLE PRECISION', 'DECIMAL(10,2)', 'BOOLEAN', 'TEXT', ''].map(paramTypeFor)).toEqual(['integer', 'integer', 'number', 'number', 'number', 'boolean', 'string', 'string']);
    expect(CONSOLE_ENDPOINT_CAP).toBe(30);
  });
});
