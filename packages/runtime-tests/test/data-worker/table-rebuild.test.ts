// #701: a declared table rebuild on workerd's real D1 — the only way to widen a CHECK constraint. A good rebuild keeps
// every row (rowid included), its indexes, its triggers and the views over it; a bad one is refused and leaves the
// table exactly as it was.
import { SELF, env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { planRebuild } from '../../../data-worker/src/table-rebuild';

const internal = (body: unknown) => ({ method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Internal-Token': env.INTERNAL_TOKEN }, body: JSON.stringify(body) });
const migrate = (migrations: unknown[]) => SELF.fetch('https://data/migrate', internal({ migrations }));

const BASE = [
  { name: '0001_docs', sql: "CREATE TABLE IF NOT EXISTS docs (user_id TEXT NOT NULL, kind TEXT NOT NULL CHECK (kind IN ('licence', 'insurance')), file_key TEXT NOT NULL, uploaded_at INTEGER NOT NULL, PRIMARY KEY (user_id, kind)); CREATE INDEX IF NOT EXISTS idx_docs_kind ON docs (kind, uploaded_at)" },
  { name: '0002_audit', sql: "CREATE TABLE IF NOT EXISTS audit (doc TEXT NOT NULL); CREATE TRIGGER IF NOT EXISTS docs_audit AFTER INSERT ON docs BEGIN INSERT INTO audit (doc) VALUES (NEW.user_id || ':' || NEW.kind); END; CREATE VIEW IF NOT EXISTS licences AS SELECT user_id FROM docs WHERE kind = 'licence'; CREATE VIEW IF NOT EXISTS licence_count AS SELECT COUNT(*) AS n FROM licences" },
  { name: '0003_seed', sql: "INSERT INTO docs (user_id, kind, file_key, uploaded_at) VALUES ('u1', 'licence', 'k1', 1), ('u1', 'insurance', 'k2', 2), ('u2', 'licence', 'k3', 3)" },
];
const WIDER = "CREATE TABLE docs (user_id TEXT NOT NULL, kind TEXT NOT NULL CHECK (kind IN ('licence', 'insurance', 'police_check')), file_key TEXT NOT NULL, uploaded_at INTEGER NOT NULL, note TEXT, PRIMARY KEY (user_id, kind))";

const docs = async () => (await env.DB.prepare('SELECT rowid AS r, user_id, kind, file_key, uploaded_at FROM docs ORDER BY rowid').all()).results;
const schemaOf = async (table: string) => (await env.DB.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").bind(table).first<{ sql: string }>())?.sql;
const applied = async (name: string) => (await env.DB.prepare('SELECT COUNT(*) AS n FROM _migrations WHERE name = ?').bind(name).first<{ n: number }>())?.n;

describe('declared table rebuild (#701)', () => {
  it('widens a CHECK: every row, its rowid, index, trigger and views survive, and it runs once', async () => {
    expect((await migrate(BASE)).status).toBe(200);
    const before = await docs();
    expect(before).toHaveLength(3);
    // Without the rebuild the new kind is refused.
    await expect(env.DB.prepare("INSERT INTO docs VALUES ('u3', 'police_check', 'k4', 4)").run()).rejects.toThrow(/CHECK constraint failed/);

    const res = await migrate([...BASE, { name: '0004_docs_kinds', rebuild: 'docs', sql: WIDER }]);
    expect(res.status, await res.clone().text()).toBe(200);
    expect(await res.json()).toMatchObject({ applied: ['0004_docs_kinds'] });

    expect(await docs()).toEqual(before);
    expect(await schemaOf('docs')).toContain("'police_check'");
    expect(await schemaOf('docs__rebuild')).toBeUndefined();
    const objects = (await env.DB.prepare("SELECT type, name FROM sqlite_master WHERE name IN ('idx_docs_kind', 'docs_audit', 'licences', 'licence_count') ORDER BY name").all()).results;
    expect(objects).toEqual([
      { type: 'trigger', name: 'docs_audit' },
      { type: 'index', name: 'idx_docs_kind' },
      { type: 'view', name: 'licence_count' },
      { type: 'view', name: 'licences' },
    ]);

    await env.DB.prepare("INSERT INTO docs (user_id, kind, file_key, uploaded_at, note) VALUES ('u3', 'police_check', 'k4', 4, 'new')").run();
    expect((await env.DB.prepare("SELECT doc FROM audit WHERE doc = 'u3:police_check'").first())).toEqual({ doc: 'u3:police_check' });
    expect(await env.DB.prepare('SELECT n FROM licence_count').first()).toEqual({ n: 2 });
    const plan = await env.DB.prepare("EXPLAIN QUERY PLAN SELECT * FROM docs WHERE kind = 'licence' ORDER BY uploaded_at").all<{ detail: string }>();
    expect(plan.results.map((r) => r.detail).join(' ')).toContain('idx_docs_kind');

    // Recorded in _migrations with the rebuild itself: a re-run is a no-op.
    const again = await migrate([...BASE, { name: '0004_docs_kinds', rebuild: 'docs', sql: WIDER }]);
    expect(await again.json()).toMatchObject({ applied: [] });
    expect((await docs())).toHaveLength(4);
  });

  it.each([
    ['a dropped column', 'CREATE TABLE docs (user_id TEXT NOT NULL, kind TEXT NOT NULL, uploaded_at INTEGER NOT NULL, PRIMARY KEY (user_id, kind))', /drops column file_key/],
    ['a changed column type', 'CREATE TABLE docs (user_id TEXT NOT NULL, kind TEXT NOT NULL, file_key BLOB NOT NULL, uploaded_at INTEGER NOT NULL, PRIMARY KEY (user_id, kind))', /file_key changes from TEXT to BLOB/],
    ['a conflict clause that would drop rows', 'CREATE TABLE docs (user_id TEXT NOT NULL UNIQUE ON CONFLICT IGNORE, kind TEXT NOT NULL, file_key TEXT NOT NULL, uploaded_at INTEGER NOT NULL)', /conflict clause/],
    ['old rows the new CHECK rejects', "CREATE TABLE docs (user_id TEXT NOT NULL, kind TEXT NOT NULL CHECK (kind = 'insurance'), file_key TEXT NOT NULL, uploaded_at INTEGER NOT NULL, PRIMARY KEY (user_id, kind))", /CHECK constraint failed/],
    ['a key the old rows duplicate', 'CREATE TABLE docs (user_id TEXT PRIMARY KEY, kind TEXT NOT NULL, file_key TEXT NOT NULL, uploaded_at INTEGER NOT NULL)', /UNIQUE constraint failed/],
    ['another table', 'CREATE TABLE audit (doc TEXT)', /creates audit, not docs/],
    ['IF NOT EXISTS', WIDER.replace('CREATE TABLE', 'CREATE TABLE IF NOT EXISTS'), /without IF NOT EXISTS/],
  ])('refuses %s and leaves the table untouched', async (_, sql, detail) => {
    expect((await migrate(BASE)).status).toBe(200);
    const before = await docs();
    const schema = await schemaOf('docs');
    const res = await migrate([...BASE, { name: '0004_bad', rebuild: 'docs', sql }]);
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({ error: 'migration rebuild failed', migration: '0004_bad', detail: expect.stringMatching(detail) });
    expect(await docs()).toEqual(before);
    expect(await schemaOf('docs')).toBe(schema);
    expect(await schemaOf('docs__rebuild')).toBeUndefined();
    expect(await applied('0004_bad')).toBe(0);
  });

  it('refuses a table a foreign key references: its DROP would cascade into the child', async () => {
    expect((await migrate([
      { name: '0001', sql: "CREATE TABLE parents (id TEXT PRIMARY KEY, kind TEXT CHECK (kind IN ('a'))); CREATE TABLE children (id TEXT PRIMARY KEY, parent_id TEXT REFERENCES parents (id) ON DELETE CASCADE); INSERT INTO parents VALUES ('p', 'a'); INSERT INTO children VALUES ('c', 'p')" },
    ])).status).toBe(200);
    const res = await migrate([{ name: '0002', rebuild: 'parents', sql: "CREATE TABLE parents (id TEXT PRIMARY KEY, kind TEXT CHECK (kind IN ('a', 'b')))" }]);
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({ detail: expect.stringMatching(/referenced by a foreign key from children/) });
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM children').first()).toEqual({ n: 1 });
  });

  it('the row-count guard aborts the whole batch if the copy ever loses a row', async () => {
    expect((await migrate(BASE)).status).toBe(200);
    const before = await docs();
    const plan = await planRebuild(env.DB, 'docs', WIDER);
    if ('error' in plan) throw new Error(plan.error);
    // Sabotage the copy the way a lossy rebuild would: one row fewer.
    const lossy = plan.statements.map((s) => (s.startsWith('INSERT INTO') ? `${s} WHERE rowid > 1` : s));
    await expect(env.DB.batch(lossy.map((s) => env.DB.prepare(s)))).rejects.toThrow(/rebuild of docs lost rows/);
    expect(await docs()).toEqual(before);
    expect(await schemaOf('docs')).not.toContain('police_check');
  });

  it('an executor that predates rebuilds fails instead of skipping it: the plain CREATE TABLE collides', async () => {
    expect((await migrate(BASE)).status).toBe(200);
    await expect(env.DB.prepare(WIDER).run()).rejects.toThrow(/already exists/);
  });
});
