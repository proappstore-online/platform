import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import app from './index.js';
import { planRebuild, rebuildDefinitionError } from './table-rebuild.js';

// Vite cannot resolve the node:sqlite builtin; require it (as agent-teams' project tests do).
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');

// #701: the declared table rebuild against a real SQLite (node:sqlite) behind a D1-shaped adapter: batch is one
// transaction. The same behaviour on workerd's D1 is in runtime-tests/test/data-worker/table-rebuild.test.ts.

function sqliteD1() {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  const exec = (sql: string, params: unknown[]) => db.prepare(sql).all(...(params as never[]));
  const stmt = (sql: string, params: unknown[] = []) => ({
    sql,
    params,
    bind: (...p: unknown[]) => stmt(sql, p),
    all: async () => ({ results: exec(sql, params), meta: { changes: 0 } }),
    run: async () => { exec(sql, params); return { meta: { changes: 1, last_row_id: 0 } }; },
  });
  return {
    sqlite: db,
    prepare: (sql: string) => stmt(sql),
    batch: async (statements: ReturnType<typeof stmt>[]) => {
      db.exec('BEGIN');
      try {
        const out = statements.map((s) => ({ results: exec(s.sql, s.params), meta: { changes: 0 } }));
        db.exec('COMMIT');
        return out;
      } catch (e) {
        db.exec('ROLLBACK');
        throw e;
      }
    },
  };
}

const SETUP = `
  CREATE TABLE docs (user_id TEXT NOT NULL, kind TEXT NOT NULL CHECK (kind IN ('a', 'b')), file_key TEXT NOT NULL, PRIMARY KEY (user_id, kind));
  CREATE INDEX idx_docs_kind ON docs (kind);
  CREATE TABLE audit (doc TEXT);
  CREATE TRIGGER docs_audit AFTER INSERT ON docs BEGIN INSERT INTO audit VALUES (NEW.kind); END;
  CREATE TABLE other (x TEXT);
  CREATE TRIGGER other_copy AFTER INSERT ON other BEGIN INSERT INTO docs (user_id, kind, file_key) VALUES (NEW.x, 'a', 'k'); END;
  CREATE VIEW a_docs AS SELECT user_id FROM docs WHERE kind = 'a';
  CREATE VIEW a_count AS SELECT COUNT(*) AS n FROM a_docs;
  INSERT INTO docs VALUES ('u1', 'a', 'k1'), ('u1', 'b', 'k2'), ('u2', 'a', 'k3');`;
const WIDER = "CREATE TABLE docs (user_id TEXT NOT NULL, kind TEXT NOT NULL CHECK (kind IN ('a', 'b', 'c')), file_key TEXT NOT NULL, note TEXT, PRIMARY KEY (user_id, kind))";

const fresh = () => { const d = sqliteD1(); d.sqlite.exec(SETUP); return d; };
const rows = (d: ReturnType<typeof sqliteD1>) => d.sqlite.prepare('SELECT rowid AS r, user_id, kind, file_key FROM docs ORDER BY rowid').all();
const schema = (d: ReturnType<typeof sqliteD1>) => d.sqlite.prepare('SELECT type, name, sql FROM sqlite_master ORDER BY name').all();
const run = async (d: ReturnType<typeof sqliteD1>, plan: Awaited<ReturnType<typeof planRebuild>>) => {
  if ('error' in plan) throw new Error(plan.error);
  await d.batch(plan.statements.map((s) => d.prepare(s)));
};

describe('rebuildDefinitionError', () => {
  it('accepts one plain CREATE TABLE of the named table and refuses the rest', () => {
    expect(rebuildDefinitionError('docs', WIDER)).toBeNull();
    expect(rebuildDefinitionError('docs', "CREATE TABLE docs (a TEXT DEFAULT 'unterminated)")).toMatch(/does not parse/);
    expect(rebuildDefinitionError('docs', 'CREATE TABLE IF NOT EXISTS docs (a)')).toMatch(/without IF NOT EXISTS/);
    expect(rebuildDefinitionError('docs', 'CREATE TABLE main.docs (a)')).toMatch(/schema-qualified/);
    expect(rebuildDefinitionError('docs', 'CREATE TABLE docs AS SELECT 1')).toMatch(/not AS SELECT/);
  });
});

describe('planRebuild (#701)', () => {
  it('widens the CHECK keeping every row and rowid, the index, both triggers and the views over views', async () => {
    const d = fresh();
    const before = rows(d);
    const objects = schema(d).filter((o) => o.name !== 'docs');
    await run(d, await planRebuild(d, 'docs', WIDER));
    expect(rows(d)).toEqual(before);
    expect(schema(d).filter((o) => o.name !== 'docs')).toEqual(objects);
    d.sqlite.exec("INSERT INTO docs (user_id, kind, file_key) VALUES ('u3', 'c', 'k4'); INSERT INTO other VALUES ('u4')");
    expect(d.sqlite.prepare('SELECT COUNT(*) AS n FROM audit').get()).toEqual({ n: 5 }); // 3 seed rows + 2 new, the trigger survived;
    expect(d.sqlite.prepare('SELECT n FROM a_count').get()).toEqual({ n: 3 });
  });

  it('copies a WITHOUT ROWID table without a rowid', async () => {
    const d = sqliteD1();
    d.sqlite.exec("CREATE TABLE k (id TEXT PRIMARY KEY, v TEXT CHECK (v IN ('a'))) WITHOUT ROWID; INSERT INTO k VALUES ('1', 'a')");
    const plan = await planRebuild(d, 'k', "CREATE TABLE k (id TEXT PRIMARY KEY, v TEXT CHECK (v IN ('a', 'b'))) WITHOUT ROWID");
    await run(d, plan);
    expect(d.sqlite.prepare('SELECT * FROM k').all()).toEqual([{ id: '1', v: 'a' }]);
  });

  it.each([
    ['a missing table', 'gone', 'CREATE TABLE gone (a)', /does not exist/],
    ['a dropped column', 'docs', 'CREATE TABLE docs (user_id TEXT NOT NULL, kind TEXT NOT NULL)', /drops column file_key/],
    ['a changed type', 'docs', 'CREATE TABLE docs (user_id TEXT, kind TEXT, file_key INTEGER)', /file_key changes from TEXT to INTEGER/],
    ['a column made generated', 'docs', "CREATE TABLE docs (user_id TEXT, kind TEXT, file_key TEXT GENERATED ALWAYS AS ('x'))", /to a generated column/],
    ['a WITHOUT ROWID change', 'docs', 'CREATE TABLE docs (user_id TEXT, kind TEXT, file_key TEXT, PRIMARY KEY (user_id, kind)) WITHOUT ROWID', /WITHOUT ROWID/],
    ['a definition that does not compile', 'docs', 'CREATE TABLE docs (user_id TEXT, kind TEXT, file_key TEXT, PRIMARY KEY (nope))', /does not compile/],
    ['a self reference in the new definition', 'docs', 'CREATE TABLE docs (user_id TEXT, kind TEXT, file_key TEXT, parent TEXT REFERENCES docs (user_id))', /referenced by a foreign key from docs \(new definition\)/],
    ['a conflict clause', 'docs', 'CREATE TABLE docs (user_id TEXT UNIQUE ON CONFLICT IGNORE, kind TEXT, file_key TEXT)', /conflict clause/],
  ])('refuses %s', async (_, table, sql, error) => {
    const d = fresh();
    const plan = await planRebuild(d, table, sql);
    expect(plan).toEqual({ error: expect.stringMatching(error) });
  });

  it('refuses a table another table references, and a leftover scratch table', async () => {
    const d = fresh();
    d.sqlite.exec('CREATE TABLE child (id TEXT, k TEXT REFERENCES docs (file_key))');
    expect(await planRebuild(d, 'docs', WIDER)).toEqual({ error: expect.stringMatching(/foreign key from child/) });
    const e = fresh();
    e.sqlite.exec('CREATE TABLE docs__rebuild (a)');
    expect(await planRebuild(e, 'docs', WIDER)).toEqual({ error: expect.stringMatching(/docs__rebuild already exists/) });
  });

  it('aborts the whole batch when the copy loses a row, leaving the table as it was', async () => {
    const d = fresh();
    const before = schema(d);
    const plan = await planRebuild(d, 'docs', WIDER);
    if ('error' in plan) throw new Error(plan.error);
    const lossy = plan.statements.map((s) => (s.startsWith('INSERT INTO') ? `${s} WHERE rowid > 1` : s));
    await expect(d.batch(lossy.map((s) => d.prepare(s)))).rejects.toThrow(/rebuild of docs lost rows/);
    expect(schema(d)).toEqual(before);
  });
});

describe('POST /migrate with a rebuild (#701)', () => {
  const migrate = (d: ReturnType<typeof sqliteD1>, migrations: unknown[]) => app.request('/migrate', {
    method: 'POST',
    headers: { 'X-Internal-Token': 'internal-secret', 'Content-Type': 'application/json' },
    body: JSON.stringify({ migrations }),
  }, { DB: d as unknown as D1Database, APP_ID: 'test-app', SESSION_SIGNING_KEY: 'k', API_BASE: 'https://api.test', INTERNAL_TOKEN: 'internal-secret' });

  it('applies it once, with its _migrations row', async () => {
    const d = fresh();
    const first = await migrate(d, [{ name: '0002', rebuild: 'docs', sql: WIDER }]);
    expect(await first.json()).toEqual({ applied: ['0002'], already: [] });
    const again = await migrate(d, [{ name: '0002', rebuild: 'docs', sql: WIDER }]);
    expect(await again.json()).toEqual({ applied: [], already: ['0002'] });
    expect(d.sqlite.prepare("SELECT sql FROM sqlite_master WHERE name = 'docs'").get()).toEqual({ sql: expect.stringContaining("'c'") });
  });

  it('422s a refused plan and a failing batch, recording nothing', async () => {
    const d = fresh();
    const refused = await migrate(d, [{ name: '0002', rebuild: 'docs', sql: 'CREATE TABLE docs (user_id TEXT)' }]);
    expect(refused.status).toBe(422);
    expect(await refused.json()).toMatchObject({ error: 'migration rebuild failed', migration: '0002', detail: expect.stringMatching(/drops column/) });
    const failing = await migrate(d, [{ name: '0003', rebuild: 'docs', sql: "CREATE TABLE docs (user_id TEXT, kind TEXT CHECK (kind = 'b'), file_key TEXT)" }]);
    expect(failing.status).toBe(422);
    expect(await failing.json()).toMatchObject({ detail: expect.stringMatching(/CHECK constraint failed/) });
    expect(d.sqlite.prepare('SELECT COUNT(*) AS n FROM _migrations').get()).toEqual({ n: 0 });
    expect(rows(d)).toHaveLength(3);
  });
});
