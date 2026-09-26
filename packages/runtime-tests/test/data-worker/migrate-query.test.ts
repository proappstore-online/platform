import { SELF, env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

const internal = (body: unknown) => ({ method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Internal-Token': env.INTERNAL_TOKEN }, body: JSON.stringify(body) });
const MIGRATIONS = [
  { name: '0001_items', sql: 'CREATE TABLE IF NOT EXISTS items (id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, title TEXT NOT NULL, created_at INTEGER NOT NULL)' },
  { name: '0002_index', sql: 'CREATE INDEX IF NOT EXISTS idx_items_owner ON items (owner_id)' },
];

describe('data worker with a real D1', () => {
  it('migrates idempotently, executes, queries, and keeps a batch atomic', async () => {
    const first = await SELF.fetch('https://data/migrate', internal({ migrations: MIGRATIONS }));
    expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject({ applied: ['0001_items', '0002_index'] });
    const again = await SELF.fetch('https://data/migrate', internal({ migrations: MIGRATIONS }));
    expect(await again.json()).toMatchObject({ applied: [], already: expect.arrayContaining(['0001_items', '0002_index']) });

    const ins = await SELF.fetch('https://data/execute', internal({ sql: 'INSERT INTO items (id, owner_id, title, created_at) VALUES (?, ?, ?, ?)', params: ['i1', 'gh:owner', 'first', 1] }));
    expect(ins.status).toBe(200);
    expect(await ins.json()).toMatchObject({ meta: { changes: 1 } });

    const sel = await SELF.fetch('https://data/query', internal({ sql: 'SELECT id, title FROM items WHERE owner_id = ?', params: ['gh:owner'] }));
    expect(await sel.json()).toMatchObject({ rows: [{ id: 'i1', title: 'first' }] });

    // One D1 transaction: the duplicate primary key in statement 2 undoes statement 1.
    const batch = await SELF.fetch('https://data/batch', internal({ statements: [
      { sql: 'INSERT INTO items (id, owner_id, title, created_at) VALUES (?, ?, ?, ?)', params: ['i2', 'gh:owner', 'second', 2] },
      { sql: 'INSERT INTO items (id, owner_id, title, created_at) VALUES (?, ?, ?, ?)', params: ['i1', 'gh:owner', 'dup', 3] },
    ] }));
    expect(batch.status).toBeGreaterThanOrEqual(400);
    const count = await env.DB.prepare('SELECT COUNT(*) AS n FROM items').first<{ n: number }>();
    expect(count?.n).toBe(1);
  });

  it('schema coherence: /validate compiles statements against the live schema and names a missing column', async () => {
    await SELF.fetch('https://data/migrate', internal({ migrations: MIGRATIONS }));
    const res = await SELF.fetch('https://data/validate', internal({ statements: [
      { id: 'ok#0', sql: 'SELECT id FROM items WHERE owner_id = ?', paramCount: 1 },
      { id: 'bad#0', sql: 'SELECT due_at FROM items WHERE owner_id = ?', paramCount: 1 },
    ] }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { results: { id: string; ok: boolean; error?: string }[] };
    expect(body.results).toEqual([
      { id: 'ok#0', ok: true },
      expect.objectContaining({ id: 'bad#0', ok: false, error: expect.stringContaining('no such column') }),
    ]);
  });

  it('FTS5 (#206): the documented migration applies, batch-synced rows index, and MATCH search finds them', async () => {
    const migrate = await SELF.fetch('https://data/migrate', internal({ migrations: [
      { name: '0001_products', sql: "CREATE TABLE IF NOT EXISTS products (id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, title TEXT NOT NULL, body TEXT, created_at INTEGER NOT NULL, updated_at INTEGER); INSERT INTO products (id, owner_id, title, body, created_at) VALUES ('seed', 'gh:seed', 'Vacuum Pumps; Drop Shipping', 'seed text', 0)" },
      { name: '0007_products_fts', sql: 'CREATE VIRTUAL TABLE IF NOT EXISTS products_fts USING fts5(product_id UNINDEXED, title, body)' },
    ] }));
    expect(migrate.status, await migrate.clone().text()).toBe(200);
    // The seed's `;` stayed inside its literal: one row, not a split statement.
    expect((await env.DB.prepare('SELECT title FROM products').first<{ title: string }>())?.title).toBe('Vacuum Pumps; Drop Shipping');

    // create_product, as the executor binds it: one atomic batch, row + index entry.
    const create = await SELF.fetch('https://data/batch', internal({ statements: [
      { sql: 'INSERT INTO products (id, owner_id, title, body, created_at) VALUES (?, ?, ?, ?, ?)', params: ['p1', 'gh:owner', 'Rotary vane pump', 'oil sealed, two stage', 1] },
      { sql: 'INSERT INTO products_fts (product_id, title, body) SELECT id, title, body FROM products WHERE id = ? AND owner_id = ?', params: ['p1', 'gh:owner'] },
    ] }));
    expect(create.status, await create.clone().text()).toBe(200);

    const search = await SELF.fetch('https://data/query', internal({
      sql: 'SELECT p.id, p.title FROM products_fts JOIN products p ON p.id = products_fts.product_id WHERE products_fts MATCH ? ORDER BY rank LIMIT 20',
      params: ['vane'],
    }));
    expect(search.status, await search.clone().text()).toBe(200);
    expect(await search.json()).toMatchObject({ rows: [{ id: 'p1', title: 'Rotary vane pump' }] });
  });

  it('the additive-only rule is the backend\'s, not the worker\'s: a raw internal migrate can DROP — which is why deploys go through the backend lint', async () => {
    await SELF.fetch('https://data/migrate', internal({ migrations: MIGRATIONS }));
    const res = await SELF.fetch('https://data/migrate', internal({ migrations: [{ name: '0003_drop', sql: 'DROP INDEX IF EXISTS idx_items_owner' }] }));
    expect(res.status).toBe(200);
  });
});
