import { describe, expect, it } from 'vitest';
import { chunkStatements, importStatements, MAX_IMPORT_ROWS_PER_TABLE, validateImportTable } from './data-import.js';
import type { ColumnInfo } from './endpoint-sql.js';

const TASKS: ColumnInfo[] = [
  { name: 'id', type: 'TEXT', notnull: 1, dflt_value: null, pk: 1 },
  { name: 'owner_id', type: 'TEXT', notnull: 1, dflt_value: null, pk: 0 },
  { name: 'title', type: 'TEXT', notnull: 1, dflt_value: null, pk: 0 },
];

describe('validateImportTable (#515)', () => {
  it('passes a table with a primary key and rows that only name live columns', () => {
    const v = validateImportTable('tasks', [{ id: '1', owner_id: 'gh:1', title: 'a' }], TASKS);
    expect(v.mismatches).toEqual([]);
    expect(v.pk).toEqual(['id']);
  });

  it('refuses a table that does not exist', () => {
    const v = validateImportTable('ghost', [{ id: '1' }], []);
    expect(v.mismatches).toContain('table "ghost" does not exist');
  });

  it('refuses a table with no primary key', () => {
    const noPk = TASKS.map((c) => ({ ...c, pk: 0 }));
    const v = validateImportTable('tasks', [{ id: '1' }], noPk);
    expect(v.mismatches).toContain('table "tasks" has no primary key; cannot import idempotently');
  });

  it('refuses a row that names a column the live table does not have', () => {
    const v = validateImportTable('tasks', [{ id: '1', owner_id: 'gh:1', title: 'a', bogus: 1 }], TASKS);
    expect(v.mismatches).toContain('"tasks"."bogus" does not exist on the live schema');
  });

  it('refuses a row that omits the primary key', () => {
    const v = validateImportTable('tasks', [{ owner_id: 'gh:1', title: 'a' }], TASKS);
    expect(v.mismatches).toContain('"tasks": every row must set the primary key column "id"');
  });

  it('refuses more rows than the per-table import limit', () => {
    const rows = Array.from({ length: MAX_IMPORT_ROWS_PER_TABLE + 1 }, (_, i) => ({ id: String(i), owner_id: 'gh:1', title: 'a' }));
    const v = validateImportTable('tasks', rows, TASKS);
    expect(v.mismatches.some((m) => m.includes('exceeds the'))).toBe(true);
  });

  it('refuses an invalid table name', () => {
    const v = validateImportTable('tasks; drop table users', [], TASKS);
    expect(v.mismatches.some((m) => m.includes('not a valid table name'))).toBe(true);
  });
});

describe('importStatements: idempotent re-run (#515)', () => {
  it('builds one INSERT ... ON CONFLICT(pk) DO NOTHING per row, params in column order', () => {
    const rows = [{ id: '1', owner_id: 'gh:1', title: 'a' }];
    const stmts = importStatements({ table: 'tasks', rows, pk: ['id'] });
    expect(stmts).toHaveLength(1);
    expect(stmts[0]!.sql).toBe('INSERT INTO "tasks" ("id", "owner_id", "title") VALUES (?, ?, ?) ON CONFLICT ("id") DO NOTHING');
    expect(stmts[0]!.params).toEqual(['1', 'gh:1', 'a']);
  });

  it('is byte-identical whether built once or twice — a re-run sends the exact same statements', () => {
    const rows = [{ id: '1', owner_id: 'gh:1', title: 'a' }];
    const first = importStatements({ table: 'tasks', rows, pk: ['id'] });
    const second = importStatements({ table: 'tasks', rows, pk: ['id'] });
    expect(second).toEqual(first);
  });

  it('quotes a composite primary key as one conflict target', () => {
    const stmts = importStatements({ table: 'memberships', rows: [{ org_id: 'o1', user_id: 'u1' }], pk: ['org_id', 'user_id'] });
    expect(stmts[0]!.sql).toContain('ON CONFLICT ("org_id", "user_id") DO NOTHING');
  });
});

describe('chunkStatements', () => {
  it('splits into chunks of at most `size`, preserving order', () => {
    const statements = Array.from({ length: 5 }, (_, i) => i);
    expect(chunkStatements(statements, 2)).toEqual([[0, 1], [2, 3], [4]]);
  });

  it('a single chunk when under the size', () => {
    expect(chunkStatements([1, 2], 500)).toEqual([[1, 2]]);
  });
});
