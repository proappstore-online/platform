import { readFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';

/**
 * A D1-shaped database over SQLite in memory, for unit tests that need real SQL (ON CONFLICT, json_each, MIN/MAX in upserts) without
 * workerd. The platform's own migrations are applied in order, so a test runs against the real schema. Only the D1 surface the backend
 * uses is implemented: prepare().bind().run/all/first, batch(). `node:sqlite` is reached through require because Vite's resolver does
 * not know the module.
 */

type Param = string | number | bigint | null | Uint8Array;
interface SqliteStatement { run(...p: Param[]): { changes: number | bigint }; all(...p: Param[]): Record<string, unknown>[]; get(...p: Param[]): Record<string, unknown> | undefined }
interface SqliteDb { exec(sql: string): void; prepare(sql: string): SqliteStatement }

const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as { DatabaseSync: new (path: string) => SqliteDb };
const MIGRATIONS = join(import.meta.dirname, '../../../migrations');

const param = (v: unknown): Param => (v === undefined ? null : typeof v === 'boolean' ? (v ? 1 : 0) : (v as Param));

class Statement {
  constructor(private readonly db: SqliteDb, readonly sql: string, private readonly params: Param[] = []) {}
  bind(...values: unknown[]): Statement { return new Statement(this.db, this.sql, values.map(param)); }
  async run() { return { success: true, meta: { changes: Number(this.db.prepare(this.sql).run(...this.params).changes) }, results: [] }; }
  async all<T>() { return { success: true, results: this.db.prepare(this.sql).all(...this.params) as T[], meta: {} }; }
  async first<T>(column?: string): Promise<T | null> {
    const row = this.db.prepare(this.sql).get(...this.params);
    if (!row) return null;
    return (column ? row[column] : row) as T;
  }
}

/** A fresh database with every platform migration applied. */
export function sqliteD1(): D1Database & { sql: SqliteDb } {
  const sql = new DatabaseSync(':memory:');
  for (const file of readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql')).sort()) sql.exec(readFileSync(join(MIGRATIONS, file), 'utf8'));
  const db = {
    sql,
    prepare: (query: string) => new Statement(sql, query),
    async batch(statements: Statement[]) {
      sql.exec('BEGIN');
      try {
        const out = [];
        for (const s of statements) out.push(await s.run());
        sql.exec('COMMIT');
        return out;
      } catch (e) {
        sql.exec('ROLLBACK');
        throw e;
      }
    },
  };
  return db as unknown as D1Database & { sql: SqliteDb };
}
