/**
 * The map-centred template (#180) is staged at templates/template-map until it is
 * published as proappstore-online/template-map. Same bar as the other staged
 * templates — manifest through the real backend route, migrations through the
 * additive-only lint, negative tests per scoped action — plus the two properties
 * the issue names explicitly: unauthorized writes fail closed, other users'
 * hidden records never leak, and the map and the list read the same rows. The
 * catalogue metadata the template ships is checked against the catalogue schema.
 */
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { app } from '../packages/backend/src/index.js';
import { forbiddenMigrationStatement } from '../packages/backend/src/routes/deploy.js';
import { testToken, mockStmt, makeEnv } from '../packages/backend/src/test-helpers.js';

const ROOT = new URL('../templates/template-map/', import.meta.url);
const read = (p: string) => JSON.parse(readFileSync(new URL(p, ROOT), 'utf8'));
type Param = { type: string; optional?: boolean; default?: unknown; max?: number };
type Tool = { name: string; operation: 'query' | 'execute' | 'batch'; sql?: string; statements?: string[]; params: Record<string, Param>; requires_auth: boolean; auth?: { app_roles?: string[]; caller_unscoped?: { reason: string } } };
const MANIFEST = read('mcp.json') as { tools: Tool[] };
const MIGRATIONS = read('migrations.json') as { migrations: { name: string; sql: string }[] };
const TOOLS = Object.fromEntries(MANIFEST.tools.map((t) => [t.name, t]));

type DatabaseSync = import('node:sqlite').DatabaseSync;
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');
const TOK = await testToken('gh:1');

function mockD1(...stmts: ReturnType<typeof mockStmt>[]) {
  const prepare = vi.fn();
  for (const stmt of stmts) prepare.mockReturnValueOnce(stmt);
  prepare.mockReturnValue(mockStmt());
  return { prepare, batch: vi.fn().mockResolvedValue([]) };
}
function freshDb() {
  const db = new DatabaseSync(':memory:');
  for (const m of MIGRATIONS.migrations) db.exec(m.sql);
  return db;
}
function resolve(tool: Tool, params: Record<string, unknown>) {
  const out: Record<string, unknown> = {};
  for (const [name, schema] of Object.entries(tool.params)) {
    let value = params[name];
    if (value === undefined || value === null) {
      if (schema.default !== undefined) value = schema.default;
      else if (schema.optional) value = null;
      else throw new Error(`${tool.name}: missing required parameter ${name}`);
    }
    if (value !== null && schema.type === 'integer') value = Number(value);
    out[name] = value;
  }
  for (const name of Object.keys(params)) if (!(name in tool.params)) throw new Error(`${tool.name}: unknown parameter ${name}`);
  return out;
}
function bind(sql: string, resolved: Record<string, unknown>, user: string, now: number) {
  const values: unknown[] = [];
  const bound = sql.replace(/:([a-zA-Z_][a-zA-Z0-9_]*)/g, (_, name: string) => {
    if (name === '__user_id') values.push(user);
    else if (name === '__now') values.push(now);
    else if (name === '__uuid') values.push(randomUUID());
    else if (name in resolved) values.push(resolved[name]);
    else throw new Error(`unresolved parameter: ${name}`);
    return '?';
  });
  return [bound, values] as const;
}
let clock = 1_700_000_000_000;
function makeCaller(db: DatabaseSync) {
  return (name: string, user: string, params: Record<string, unknown> = {}) => {
    const tool = TOOLS[name];
    if (!tool) throw new Error(`no such action: ${name}`);
    const resolved = resolve(tool, params);
    const now = ++clock;
    if (tool.operation === 'batch') {
      db.exec('BEGIN');
      try {
        const changes = tool.statements!.map((s) => { const [sql, v] = bind(s, resolved, user, now); return Number(db.prepare(sql).run(...(v as never[])).changes); });
        db.exec('COMMIT'); return changes;
      } catch (e) { db.exec('ROLLBACK'); throw e; }
    }
    const [sql, values] = bind(tool.sql!, resolved, user, now);
    const stmt = db.prepare(sql);
    return tool.operation === 'query' ? (stmt.all(...(values as never[])) as Record<string, unknown>[]) : Number(stmt.run(...(values as never[])).changes);
  };
}

describe('template-map: registration and metadata (#180)', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).includes('/validate')) {
        const db = freshDb();
        const body = JSON.parse(init!.body as string) as { statements: { id: string; sql: string; paramCount: number }[] };
        const results = body.statements.map((s) => { try { db.prepare(s.sql); return { id: s.id, ok: true }; } catch (e) { return { id: s.id, ok: false, error: e instanceof Error ? e.message : String(e) }; } });
        return new Response(JSON.stringify({ results }), { status: 200 });
      }
      throw new Error(`unexpected fetch: ${String(input)}`);
    }));
  });
  afterEach(() => vi.unstubAllGlobals());

  it('registers every tool through the backend route', async () => {
    const db = mockD1(mockStmt({ first: { creator_id: 'gh:1' } }));
    const res = await app.request('/v1/apps/template-map/tools', { method: 'PUT', headers: { Authorization: `Bearer ${TOK}`, 'Content-Type': 'application/json' }, body: JSON.stringify(MANIFEST) }, makeEnv({}, db));
    const body = (await res.json()) as { registered?: number; error?: string; warnings?: string[] };
    expect(body.error).toBeUndefined();
    expect(res.status).toBe(200);
    expect(body.registered).toBe(MANIFEST.tools.length);
    expect(body.warnings).toEqual([]);
  });

  it('every management tool is app-role gated; every other statement is scoped on :__user_id; no public tools', () => {
    expect(MANIFEST.tools.every((t) => t.requires_auth === true)).toBe(true);
    for (const t of MANIFEST.tools) {
      if (t.name.startsWith('admin_')) expect(t.auth?.app_roles, t.name).toEqual(['admin', 'editor']);
      else if (!t.auth?.caller_unscoped) for (const s of t.statements ?? [t.sql!]) expect(s, t.name).toContain(':__user_id');
    }
    expect(MANIFEST.tools.filter((t) => t.auth?.caller_unscoped && !t.auth.app_roles).map((t) => t.name).sort()).toEqual(['category_stats', 'list_categories']);
  });

  it('migrations are additive-only under the deploy lint', () => {
    for (const m of MIGRATIONS.migrations) expect(forbiddenMigrationStatement(m.sql), m.name).toBeNull();
  });

  it('template.json is a catalogue entry per catalogue.schema.json', () => {
    const schema = JSON.parse(readFileSync(new URL('../docs/templates/catalogue.schema.json', import.meta.url), 'utf8')) as { $defs: { template: { required: string[]; properties: Record<string, { pattern?: string; enum?: string[]; properties?: Record<string, unknown>; required?: string[] }> } } };
    const def = schema.$defs.template;
    const meta = read('template.json') as Record<string, unknown>;
    for (const key of def.required) expect(meta, key).toHaveProperty(key);
    for (const [key, rule] of Object.entries(def.properties)) {
      const value = meta[key];
      if (rule.pattern && typeof value === 'string') expect(value, key).toMatch(new RegExp(rule.pattern));
      if (rule.enum) expect(rule.enum, key).toContain(value);
      if (rule.required && value && typeof value === 'object') for (const k of rule.required) expect(value, `${key}.${k}`).toHaveProperty(k);
    }
    expect(meta).toMatchObject({ id: 'template-map', repo: 'proappstore-online/template-map', status: 'approved', default: false });
    expect((meta.security_compliance as { known_deviations: string[] }).known_deviations).toEqual([]);
    expect(meta.capabilities).toEqual(expect.arrayContaining(['map-primary', 'list-alternative', 'owner-scoping', 'app-roles']));
  });
});

describe('template-map: scoping, authorization and map/list parity', () => {
  const ALICE = 'gh:alice', BOB = 'gh:bob';
  function seeded() {
    const db = freshDb();
    const call = makeCaller(db);
    expect(call('admin_create_category', 'gh:admin', { id: 'cafe', name: 'Cafés', icon: '☕' })).toBe(1);
    expect(call('create_place', ALICE, { id: 'p1', owner_name: 'Alice', category_id: 'cafe', name: 'Corner Roasters', address: '1 High St', lat: -37.81, lng: 144.96 })).toBe(1);
    expect(call('create_place', ALICE, { id: 'p2', owner_name: 'Alice', name: 'Hidden gem', lat: -37.82, lng: 144.97 })).toBe(1);
    expect(call('set_place_status', ALICE, { id: 'p2', status: 'hidden' })).toBe(1);
    expect(call('create_place', BOB, { id: 'p3', owner_name: 'Bob', category_id: 'cafe', name: 'Bay Kiosk', address: 'The Pier', lat: -37.86, lng: 144.98 })).toBe(1);
    return { db, call };
  }
  const ids = (rows: unknown) => (rows as { id: string }[]).map((r) => r.id).sort();

  it('cross-user reads: a hidden record is visible only to its owner; get_place fails closed', () => {
    const { call } = seeded();
    expect(ids(call('list_places', BOB))).toEqual(['p1', 'p3']);
    expect(ids(call('list_places', ALICE))).toEqual(['p1', 'p2', 'p3']);
    expect(call('get_place', BOB, { id: 'p2' })).toEqual([]);
    expect(call('get_place', ALICE, { id: 'p2' })).toHaveLength(1);
    expect(ids(call('list_my_places', BOB))).toEqual(['p3']);
  });

  it('unauthorized writes: only the owner edits, hides or deletes; bad coordinates and unknown categories are refused', () => {
    const { call } = seeded();
    expect(call('update_place', BOB, { id: 'p1', name: 'Hijack', lat: -37.81, lng: 144.96 })).toBe(0);
    expect(call('set_place_status', BOB, { id: 'p1', status: 'hidden' })).toBe(0);
    expect(call('delete_place', BOB, { id: 'p1' })).toBe(0);
    expect(call('update_place', ALICE, { id: 'p1', name: 'Corner Roasters II', category_id: 'cafe', lat: -37.81, lng: 144.96 })).toBe(1);
    expect(call('update_place', ALICE, { id: 'p1', name: 'x', lat: 95, lng: 0 })).toBe(0);
    expect(call('create_place', BOB, { id: 'p4', owner_name: 'Bob', name: 'Nowhere', lat: 0, lng: 200 })).toBe(0);
    expect(call('create_place', BOB, { id: 'p5', owner_name: 'Bob', category_id: 'ghost', name: 'No such category', lat: 0, lng: 0 })).toBe(0);
    expect(call('create_place', BOB, { id: 'p3', owner_name: 'Bob', name: 'dup', lat: 0, lng: 0 })).toBe(0);
    expect(call('set_place_status', ALICE, { id: 'p1', status: 'deleted' })).toBe(0);
    expect(call('delete_place', ALICE, { id: 'p1' })).toBe(1);
  });

  it('map/list parity: the map (viewport) and the list (count + rows) read the same predicate', () => {
    const { call } = seeded();
    const filters = { category_id: 'cafe', q: null };
    const listed = ids(call('list_places', BOB, filters));
    expect((call('count_places', BOB, filters) as { count: number }[])[0]!.count).toBe(listed.length);
    // a viewport that holds only the first café
    const box = { south: -37.83, north: -37.80, west: 144.95, east: 144.97 };
    expect(ids(call('list_places', BOB, { ...filters, ...box }))).toEqual(['p1']);
    expect((call('count_places', BOB, { ...filters, ...box }) as { count: number }[])[0]!.count).toBe(1);
    // the antimeridian-crossing box (west > east) still selects by longitude wrap
    expect(ids(call('list_places', BOB, { south: -90, north: 90, west: 170, east: -170 }))).toEqual([]);
    expect(ids(call('list_places', BOB, { q: 'kiosk' }))).toEqual(['p3']);
    expect(ids(call('list_places', ALICE, { q: 'gem' }))).toEqual(['p2']);
    expect(ids(call('list_places', BOB, { q: 'gem' }))).toEqual([]);
  });

  it('management: admin tools change any record and categories; deleting a category detaches its places', () => {
    const { call } = seeded();
    expect(ids(call('admin_list_places', 'gh:editor'))).toEqual(['p1', 'p2', 'p3']);
    expect(ids(call('admin_list_places', 'gh:editor', { status: 'hidden' }))).toEqual(['p2']);
    expect(call('admin_set_place_status', 'gh:editor', { id: 'p3', status: 'hidden' })).toBe(1);
    expect(call('admin_update_place', 'gh:editor', { id: 'p1', category_id: 'cafe', name: 'Corner Roasters (verified)' })).toBe(1);
    expect(call('admin_update_place', 'gh:editor', { id: 'p1', category_id: 'ghost', name: 'x' })).toBe(0);
    expect((call('category_stats', BOB) as { id: string; active_count: number }[])).toEqual([{ id: 'cafe', name: 'Cafés', active_count: 1 }]);
    expect(call('admin_delete_category', 'gh:admin', { id: 'cafe' })).toEqual([2, 1]);
    expect((call('get_place', ALICE, { id: 'p1' })[0] as { category_id: string | null }).category_id).toBeNull();
    expect(call('list_categories', BOB)).toEqual([]);
    expect(call('admin_delete_place', 'gh:admin', { id: 'p1' })).toBe(1);
  });
});
