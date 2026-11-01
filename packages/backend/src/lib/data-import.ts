import type { Env } from '../types.js';
import type { ColumnInfo } from './endpoint-sql.js';
import { forwardToDataWorker } from '../routes/actions.js';

/**
 * Owner bulk import of existing data into an app's D1 (#515) — rows a Firebase
 * (or other) port brings with it, loaded through the same trusted data-worker
 * path registered actions and the entitlement mirror use (`routes/actions.ts`
 * `forwardToDataWorker`, `lib/entitlement-mirror.ts`), never a parallel one.
 *
 * Idempotent by construction: every statement is `INSERT ... ON CONFLICT(pk)
 * DO NOTHING`, keyed off the table's own live primary key, so running the same
 * file twice (a retried import, or two overlapping exports) changes nothing
 * the second time. A table with no primary key is refused outright — without
 * one there is no way to tell "already imported" from "new".
 */

const IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** A re-run is always safe; a single call is still bounded so one bad file cannot wedge the data worker. */
export const MAX_IMPORT_ROWS_PER_TABLE = 5000;
/** Prepared statements per `/batch` call — the same cap registered batch actions use (`app-worker-calls.ts`). */
export const IMPORT_BATCH_SIZE = 500;

export type ImportRow = Record<string, unknown>;

export interface TableValidation {
  table: string;
  rows: ImportRow[];
  /** The live primary-key columns, in key order. Empty when the table was refused. */
  pk: string[];
  /** Empty when the table and every row are clean; otherwise nothing for this table is written. */
  mismatches: string[];
}

/** The live schema of one table, over the trusted internal data-worker path. Empty rows mean the table does not exist. */
export async function readLiveSchema(env: Pick<Env, 'DATA_WORKER_HOST' | 'INTERNAL_TOKEN'>, appId: string, table: string): Promise<ColumnInfo[]> {
  const res = await forwardToDataWorker(env as Env, appId, 'query', { sql: `PRAGMA table_info("${table}")` }, null);
  if (!res.ok) throw new Error(`schema read refused (${res.status})`);
  const body = (await res.json()) as { rows?: ColumnInfo[] };
  return body.rows ?? [];
}

/**
 * Validate one table's rows against its live schema: the table exists, has a
 * primary key, every row is a plain object, every row sets every primary-key
 * column, and no row names a column the live table does not have.
 */
export function validateImportTable(table: string, rows: ImportRow[], columns: ColumnInfo[]): TableValidation {
  const mismatches: string[] = [];
  if (!IDENT_RE.test(table)) mismatches.push(`"${table}" is not a valid table name`);
  if (columns.length === 0) mismatches.push(`table "${table}" does not exist`);
  const names = new Set(columns.map((c) => c.name));
  const pk = columns.filter((c) => c.pk > 0).sort((a, b) => a.pk - b.pk).map((c) => c.name);
  if (columns.length > 0 && pk.length === 0) mismatches.push(`table "${table}" has no primary key; cannot import idempotently`);
  if (rows.length > MAX_IMPORT_ROWS_PER_TABLE) mismatches.push(`"${table}": ${rows.length} rows exceeds the ${MAX_IMPORT_ROWS_PER_TABLE}-row import limit per call; split the file`);

  const unknownColumns = new Set<string>();
  for (const row of rows) {
    for (const key of Object.keys(row)) if (!names.has(key)) unknownColumns.add(key);
  }
  for (const key of [...unknownColumns].sort()) mismatches.push(`"${table}"."${key}" does not exist on the live schema`);

  for (const key of pk) {
    if (rows.some((row) => !(key in row))) mismatches.push(`"${table}": every row must set the primary key column "${key}"`);
  }

  return { table, rows, pk, mismatches };
}

/** `INSERT ... ON CONFLICT(pk) DO NOTHING` per row — idempotent: a re-run never overwrites or errors on a row already imported. */
export function importStatements(validated: Pick<TableValidation, 'table' | 'rows' | 'pk'>): { sql: string; params: unknown[] }[] {
  const { table, rows, pk } = validated;
  return rows.map((row) => {
    const columns = Object.keys(row);
    const quotedCols = columns.map((c) => `"${c}"`).join(', ');
    const placeholders = columns.map(() => '?').join(', ');
    const conflictCols = pk.map((k) => `"${k}"`).join(', ');
    return {
      sql: `INSERT INTO "${table}" (${quotedCols}) VALUES (${placeholders}) ON CONFLICT (${conflictCols}) DO NOTHING`,
      params: columns.map((c) => row[c] ?? null),
    };
  });
}

/** Split a flat statement list into chunks of at most `size`, one `/batch` call each. */
export function chunkStatements<T>(statements: T[], size: number = IMPORT_BATCH_SIZE): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < statements.length; i += size) out.push(statements.slice(i, i + size));
  return out;
}
