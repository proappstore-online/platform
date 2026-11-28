// VENDORED from packages/data-worker/src/table-rebuild.ts (#701): the data worker's /migrate runs a declared table rebuild
// with exactly this code, so `pas migrations test` must run it the same way. Do not edit here: change the data worker's
// copy and copy it over. runtime-tests/test/config/migration-chain-parity.test.ts fails if the two differ.
import { parseStatements, type SqlToken } from './sql-statements.js';

/**
 * The one declared table rebuild a migration may run (#701). SQLite cannot alter a CHECK constraint (or any other column
 * constraint) in place; the only route is a rebuild. The deploy path stays additive otherwise, so the destructive steps are
 * written by the platform, never by the app:
 *
 *   { "name": "0031_documents_kinds", "rebuild": "documents", "sql": "CREATE TABLE documents (…the new definition…)" }
 *
 * `sql` is exactly one `CREATE TABLE <rebuild> (…)` with the table's new definition under its real name. The executor
 * checks it against the live table and runs, in ONE D1 batch (one transaction):
 *
 *   CREATE TABLE "<t>__rebuild" (…)                      the new definition under a scratch name
 *   INSERT INTO "<t>__rebuild" (cols) SELECT cols FROM t  every row; rowid kept for rowid tables
 *   SELECT … the row-count guard                         aborts the batch unless both tables hold the same count
 *   DROP VIEW / DROP TRIGGER                             views and other tables' triggers that name t (SQLite's
 *                                                        RENAME refuses while they point at a missing table)
 *   DROP TABLE t; ALTER TABLE "<t>__rebuild" RENAME TO t
 *   CREATE INDEX / TRIGGER / VIEW                        every index and trigger of t, and the views and triggers
 *                                                        dropped above, from their stored SQL
 *
 * Refused: a definition that is not one plain CREATE TABLE for that table (IF NOT EXISTS, AS SELECT, a schema prefix,
 * another table), a conflict clause (`ON CONFLICT IGNORE|REPLACE` could drop rows in the copy), a missing table, a new
 * definition that drops a column or changes a kept column's declared type, a table that a foreign key references (its
 * implicit DELETE on DROP would cascade), and a WITHOUT ROWID change in either direction. Anything that fails inside
 * the batch (a CHECK the old rows break, a NOT NULL, a lost row) rolls the whole rebuild back.
 *
 * Dependency-free: it runs inside every app's data worker, and `pas migrations test` vendors it.
 */

/** The slice of the D1 binding a rebuild needs; a D1Database satisfies it. */
export interface RebuildDb {
  prepare(sql: string): { bind(...values: unknown[]): { all(): Promise<unknown> } };
  batch(statements: unknown[]): Promise<unknown>;
}

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;
const SCRATCH = '__rebuild';

const word = (t: SqlToken | undefined): string => (t && t.kind === 'word' ? t.upper : '');
/** An identifier token's name, unquoted and lower-cased (SQLite names are case-insensitive). */
const nameOf = (t: SqlToken | undefined): string => (t?.text ?? '').replace(/^["`[]|["`\]]$/g, '').toLowerCase();
const quote = (name: string): string => `"${name.replace(/"/g, '""')}"`;
const literal = (s: string): string => `'${s.replace(/'/g, "''")}'`;

/** Does a CREATE TABLE's token stream end with WITHOUT ROWID (after its column list)? */
function withoutRowid(tokens: SqlToken[]): boolean {
  return tokens.some((t, i) => word(t) === 'WITHOUT' && word(tokens[i + 1]) === 'ROWID');
}

interface Definition { tokens: SqlToken[]; scratchSql: string }

function parseDefinition(table: unknown, sql: string): { error: string } | Definition {
  if (typeof table !== 'string' || !IDENT.test(table)) return { error: 'rebuild must name the table as a plain identifier ([A-Za-z_][A-Za-z0-9_]*)' };
  if (/^(_pas_|sqlite_)/i.test(table) || table.toLowerCase() === '_migrations' || table.toLowerCase().endsWith(SCRATCH)) {
    return { error: `${table} is a platform or SQLite table and cannot be rebuilt` };
  }
  const statements = parseStatements(sql).filter((s) => s.tokens.length);
  if (statements.length !== 1) return { error: 'a rebuild migration\'s sql must be exactly one CREATE TABLE statement: the table\'s new definition' };
  const t = statements[0]!.tokens;
  if (t.some((x) => x.error)) return { error: 'the rebuild definition does not parse' };
  if (word(t[0]) !== 'CREATE' || word(t[1]) !== 'TABLE') return { error: 'a rebuild migration\'s sql must be CREATE TABLE <table> (…)' };
  if (word(t[2]) === 'IF') return { error: 'write the rebuild definition without IF NOT EXISTS: the table exists by definition, and an executor that predates rebuilds then fails instead of skipping it' };
  if (t[3]?.text === '.') return { error: 'the rebuild definition may not be schema-qualified' };
  if (nameOf(t[2]) !== table.toLowerCase()) return { error: `the rebuild definition creates ${t[2]?.text ?? 'nothing'}, not ${table}` };
  if (t[3]?.text !== '(') return { error: 'the rebuild definition must be a column list, not AS SELECT' };
  for (let i = 0; i + 1 < t.length; i++) {
    if (word(t[i]) === 'ON' && word(t[i + 1]) === 'CONFLICT') return { error: 'a conflict clause (ON CONFLICT …) is not allowed in a rebuild definition: IGNORE or REPLACE would drop rows in the copy' };
  }
  const stmt = statements[0]!;
  const name = t[2]!;
  const at = name.start - stmt.start;
  return { tokens: t, scratchSql: stmt.text.slice(0, at) + quote(table + SCRATCH) + stmt.text.slice(at + name.text.length) };
}

/** Why `{ rebuild: table, sql }` is not a valid rebuild definition, or null. Static: the backend lint and the executor both run it. @public (the CLI's byte-identical vendored copy does not call it) */
export function rebuildDefinitionError(table: unknown, sql: string): string | null {
  const parsed = parseDefinition(table, sql);
  return 'error' in parsed ? parsed.error : null;
}

interface Column { name: string; type: string; hidden: number }
interface SchemaRow { type: string; name: string; tbl_name: string; sql: string | null }

const rowsOf = <T>(result: unknown): T[] => ((result as { results?: T[] } | undefined)?.results ?? []);
const all = async <T>(db: RebuildDb, sql: string): Promise<T[]> => rowsOf<T>(await db.prepare(sql).bind().all());

/** Does `sql` name `table` as a word or quoted identifier anywhere? */
function mentions(sql: string, table: string): boolean {
  return parseStatements(sql).some((s) => s.tokens.some((t) => (t.kind === 'word' || t.kind === 'ident') && nameOf(t) === table));
}

/**
 * Check a rebuild against the live schema and return the statements of its one batch, or why it is refused. The caller
 * runs `statements` (plus its own bookkeeping, e.g. the `_migrations` row) as a single `db.batch`.
 */
export async function planRebuild(db: RebuildDb, table: string, sql: string): Promise<{ error: string } | { statements: string[] }> {
  const def = parseDefinition(table, sql);
  if ('error' in def) return def;
  const lower = table.toLowerCase();
  const scratch = quote(table + SCRATCH);

  const schema = await all<SchemaRow>(db, 'SELECT type, name, tbl_name, sql FROM sqlite_master');
  const current = schema.find((r) => r.type === 'table' && r.name.toLowerCase() === lower);
  if (!current?.sql) return { error: `rebuild: table ${table} does not exist` };
  if (schema.some((r) => r.name.toLowerCase() === (lower + SCRATCH))) return { error: `rebuild: ${table}${SCRATCH} already exists` };
  const oldRowid = !withoutRowid(parseStatements(current.sql)[0]?.tokens ?? []);
  if (oldRowid !== !withoutRowid(def.tokens)) return { error: 'rebuild: changing WITHOUT ROWID is not supported' };

  const referencing = new Set<string>();
  // D1's own `_cf_*` tables are not readable (SQLITE_AUTH), and neither they nor sqlite_* can hold a foreign key to an app table.
  for (const r of schema.filter((x) => x.type === 'table' && !/^(_cf_|sqlite_)/i.test(x.name))) {
    const fks = await all<{ table: string }>(db, `SELECT "table" FROM pragma_foreign_key_list(${literal(r.name)})`);
    if (fks.some((f) => f.table.toLowerCase() === lower)) referencing.add(r.name);
  }

  // The new definition's real columns and foreign keys: create it under the scratch name and drop it again, in one batch.
  let probe: unknown;
  try {
    probe = await db.batch([
      db.prepare(def.scratchSql),
      db.prepare(`SELECT name, type, hidden FROM pragma_table_xinfo(${literal(table + SCRATCH)})`),
      db.prepare(`SELECT "table" FROM pragma_foreign_key_list(${literal(table + SCRATCH)})`),
      db.prepare(`DROP TABLE ${scratch}`),
    ]);
  } catch (e) {
    return { error: `rebuild: the new definition of ${table} does not compile: ${e instanceof Error ? e.message : String(e)}` };
  }
  const [, newCols, newFks] = probe as unknown[];
  if (rowsOf<{ table: string }>(newFks).some((f) => f.table.toLowerCase() === lower)) referencing.add(`${table} (new definition)`);
  if (referencing.size) return { error: `rebuild: ${table} is referenced by a foreign key from ${[...referencing].join(', ')}; dropping it would cascade, so it cannot be rebuilt` };

  const before = await all<Column>(db, `SELECT name, type, hidden FROM pragma_table_xinfo(${literal(table)})`);
  const after = new Map(rowsOf<Column>(newCols).map((c) => [c.name.toLowerCase(), c]));
  for (const col of before) {
    const next = after.get(col.name.toLowerCase());
    if (!next) return { error: `rebuild: the new definition of ${table} drops column ${col.name}; a rebuild must keep every column` };
    if (col.hidden === 0 && (next.hidden !== 0 || next.type.toUpperCase() !== col.type.toUpperCase())) {
      return { error: `rebuild: column ${col.name} changes from ${col.type || 'no type'} to ${next.hidden ? 'a generated column' : next.type || 'no type'}; a rebuild keeps every column's type` };
    }
  }
  const copy = before.filter((c) => c.hidden === 0).map((c) => quote(c.name));
  if (oldRowid) copy.unshift('rowid');
  const cols = copy.join(', ');

  const own = schema.filter((r) => (r.type === 'index' || r.type === 'trigger') && r.tbl_name.toLowerCase() === lower && r.sql);
  // Views and other tables' triggers that name t, or name a view that does (a view over a view breaks the RENAME too).
  const named = new Set([lower]);
  let dependents: SchemaRow[] = [];
  for (let grew = true; grew;) {
    const found = schema.filter((r) => (r.type === 'view' || (r.type === 'trigger' && r.tbl_name.toLowerCase() !== lower)) && r.sql && [...named].some((n) => mentions(r.sql!, n)));
    grew = found.length > dependents.length;
    dependents = found;
    for (const r of found) if (r.type === 'view') named.add(r.name.toLowerCase());
  }
  const t = quote(table);
  return {
    statements: [
      def.scratchSql,
      `INSERT INTO ${scratch} (${cols}) SELECT ${cols} FROM ${t}`,
      // Plain SQL has no RAISE outside a trigger; an invalid JSON path is an error, so a count mismatch aborts the batch.
      `SELECT json_extract('{}', CASE WHEN (SELECT COUNT(*) FROM ${scratch}) = (SELECT COUNT(*) FROM ${t}) THEN '$' ELSE ${literal(`rebuild of ${table} lost rows`)} END)`,
      ...dependents.map((r) => `DROP ${r.type.toUpperCase()} IF EXISTS ${quote(r.name)}`), // a view's own triggers go with it
      `DROP TABLE ${t}`,
      `ALTER TABLE ${scratch} RENAME TO ${t}`,
      ...own.map((r) => r.sql!),
      ...dependents.map((r) => r.sql!),
    ],
  };
}
