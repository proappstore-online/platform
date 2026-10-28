/**
 * The additive-only lint for D1 migrations (#455).
 *
 * The automated deploy path may only add: a compromised repo must not DROP or
 * RENAME its way through history in CI (destructive changes stay on the in-browser
 * owner path). The lint classifies each statement from the token stream of the
 * SQLite tokenizer the data worker's executor also uses
 * (packages/data-worker/src/sql-statements.ts), never from substrings: a keyword
 * inside a string, a comment, a quoted identifier or a clause (`ON DELETE CASCADE`,
 * `BEFORE UPDATE OF`) is not a statement, and a statement is judged where the
 * executor will cut it.
 *
 * Rules (top-level statements):
 *   allow   CREATE TABLE / [UNIQUE] INDEX / VIEW / TRIGGER, CREATE VIRTUAL TABLE …
 *           USING fts5 (#206), ALTER TABLE … ADD [COLUMN] (NOT NULL needs a
 *           non-null DEFAULT), INSERT [OR IGNORE|ABORT|FAIL|ROLLBACK] INTO …,
 *           WITH … INSERT.
 *   reject  DROP, DELETE, UPDATE, REPLACE, INSERT OR REPLACE, an upsert's DO UPDATE,
 *           ALTER … RENAME / DROP COLUMN, PRAGMA, ATTACH, DETACH, VACUUM, REINDEX,
 *           other virtual-table modules, TEMP objects, anything else, and anything
 *           that does not tokenize or balance.
 *   trigger a body of INSERT / UPDATE / DELETE / REPLACE / SELECT / WITH is allowed
 *           (it runs only on future writes) with a warning.
 */
import { parseStatements, type SqlStatement, type SqlToken } from '../../../data-worker/src/sql-statements.js';
import { writesReservedTable } from '../../../data-worker/src/reserved-tables.js';

interface MigrationLintError {
  /** The whole offending statement. */
  statement: string;
  /** The rule that refused it, e.g. `no-drop`. */
  rule: string;
  /** Names the rule and what to do. */
  reason: string;
}

export interface MigrationLint {
  error: MigrationLintError | null;
  /** Allowed, but worth saying: DML inside a trigger body. */
  warnings: string[];
}

const w = (t: SqlToken | undefined): string => (t && t.kind === 'word' ? t.upper : '');

function refuse(stmt: SqlStatement, rule: string, reason: string): MigrationLintError {
  return { statement: stmt.text, rule, reason: `${rule}: ${reason}` };
}

/** A parse error naming the position in the statement. */
function syntax(stmt: SqlStatement, offset: number, what: string): MigrationLintError {
  const before = stmt.text.slice(0, Math.max(0, offset));
  const line = before.split('\n').length;
  const col = offset - before.lastIndexOf('\n');
  return refuse(stmt, 'syntax', `${what} at line ${line}, column ${col} of the statement`);
}

/** The first token error or unbalanced parenthesis, as a syntax refusal. */
function structure(stmt: SqlStatement): MigrationLintError | null {
  let depth = 0;
  let open: SqlToken | undefined;
  for (const t of stmt.tokens) {
    const at = t.start - stmt.start;
    if (t.error) return syntax(stmt, at, `unparseable SQL: ${t.error}`);
    if (t.kind !== 'punct') continue;
    if (t.text === '(') { depth++; open = t; }
    else if (t.text === ')' && --depth < 0) return syntax(stmt, at, 'unparseable SQL: unmatched ")"');
  }
  if (depth > 0 && open) return syntax(stmt, open.start - stmt.start, 'unparseable SQL: unclosed "("');
  return null;
}

/** The verbs of statement keywords that destroy, by their rule. */
const DESTRUCTIVE: Record<string, [rule: string, why: string]> = {
  DROP: ['no-drop', 'DROP removes schema or data; the deploy path is additive. Use expand/contract and drop later by hand.'],
  DELETE: ['no-delete', 'DELETE removes rows; the deploy path is additive.'],
  UPDATE: ['no-update', 'UPDATE rewrites rows; the deploy path is additive.'],
  REPLACE: ['no-replace', 'REPLACE overwrites existing rows; use INSERT (or INSERT OR IGNORE).'],
  PRAGMA: ['no-pragma', 'PRAGMA changes connection or database settings.'],
  ATTACH: ['no-attach', 'ATTACH opens another database.'],
  DETACH: ['no-attach', 'DETACH closes a database.'],
  VACUUM: ['no-vacuum', 'VACUUM rebuilds the database file.'],
  REINDEX: ['no-reindex', 'REINDEX rebuilds indexes.'],
};

/** Index of the first depth-0 token satisfying `pred`, from `from`. */
function atDepth0(tokens: SqlToken[], from: number, pred: (t: SqlToken) => boolean): number {
  let depth = 0;
  for (let i = from; i < tokens.length; i++) {
    const t = tokens[i]!;
    if (t.kind === 'punct' && t.text === '(') depth++;
    else if (t.kind === 'punct' && t.text === ')') depth--;
    else if (depth === 0 && pred(t)) return i;
  }
  return -1;
}

/** INSERT [OR …] INTO …, with `at` the index of INSERT. */
function checkInsert(stmt: SqlStatement, at: number): MigrationLintError | null {
  const t = stmt.tokens;
  let j = at + 1;
  if (w(t[j]) === 'OR') {
    const action = w(t[j + 1]);
    if (action === 'REPLACE') return refuse(stmt, 'no-replace', 'INSERT OR REPLACE overwrites existing rows; use INSERT OR IGNORE.');
    if (!['IGNORE', 'ABORT', 'FAIL', 'ROLLBACK'].includes(action)) return syntax(stmt, t[j]!.start - stmt.start, 'expected IGNORE, ABORT, FAIL or ROLLBACK after INSERT OR');
    j += 2;
  }
  if (w(t[j]) !== 'INTO') return syntax(stmt, (t[j] ?? t[t.length - 1]!).start - stmt.start, 'expected INTO after INSERT');
  // An upsert's DO UPDATE rewrites the row it conflicts with.
  for (let i = j; i + 1 < t.length; i++) {
    if (w(t[i]) === 'DO' && w(t[i + 1]) === 'UPDATE') return refuse(stmt, 'no-upsert-update', 'ON CONFLICT … DO UPDATE rewrites existing rows; use ON CONFLICT DO NOTHING or INSERT OR IGNORE.');
  }
  return null;
}

/** ALTER TABLE name ADD [COLUMN] def: a NOT NULL column needs a non-null DEFAULT. */
function checkAlter(stmt: SqlStatement): MigrationLintError | null {
  const t = stmt.tokens;
  if (w(t[1]) !== 'TABLE') return refuse(stmt, 'not-additive', 'only ALTER TABLE … ADD [COLUMN] is allowed.');
  let j = 2;
  if (t[j] && (t[j]!.kind === 'word' || t[j]!.kind === 'ident')) j++;
  else return syntax(stmt, (t[j] ?? t[t.length - 1]!).start - stmt.start, 'expected a table name after ALTER TABLE');
  if (t[j]?.text === '.') j += 2; // schema.table
  const action = w(t[j]);
  if (action === 'RENAME') return refuse(stmt, 'no-rename', 'RENAME breaks the deployed code; use expand/contract.');
  if (action === 'DROP') return refuse(stmt, 'no-drop-column', 'DROP COLUMN removes data; the deploy path is additive.');
  if (action !== 'ADD') return refuse(stmt, 'not-additive', 'only ALTER TABLE … ADD [COLUMN] is allowed.');
  j++;
  if (w(t[j]) === 'COLUMN') j++;
  let depth = 0;
  let notNull = false;
  let hasDefault = false;
  let nullDefault = false;
  for (let i = j + 1; i < t.length; i++) {
    const tok = t[i]!;
    if (tok.kind === 'punct' && tok.text === '(') depth++;
    else if (tok.kind === 'punct' && tok.text === ')') depth--;
    else if (depth === 0 && w(tok) === 'NOT' && w(t[i + 1]) === 'NULL') notNull = true;
    else if (depth === 0 && w(tok) === 'DEFAULT') {
      hasDefault = true;
      const v = t[i + 1];
      if (w(v) === 'NULL' || (v?.text === '(' && w(t[i + 2]) === 'NULL' && t[i + 3]?.text === ')')) nullDefault = true;
    }
  }
  if (notNull && (!hasDefault || nullDefault)) {
    return refuse(stmt, 'not-null-needs-default', 'ALTER TABLE … ADD COLUMN … NOT NULL must include a non-null DEFAULT so existing rows stay valid.');
  }
  return null;
}

/** CREATE VIRTUAL TABLE [IF NOT EXISTS] name USING fts5(…) only (#206). */
function checkVirtualTable(stmt: SqlStatement): MigrationLintError | null {
  const t = stmt.tokens;
  let j = 3; // after CREATE VIRTUAL TABLE
  if (w(t[j]) === 'IF' && w(t[j + 1]) === 'NOT' && w(t[j + 2]) === 'EXISTS') j += 3;
  if (!t[j] || (t[j]!.kind !== 'word' && t[j]!.kind !== 'ident')) return syntax(stmt, (t[j] ?? t[t.length - 1]!).start - stmt.start, 'expected a table name');
  j++;
  if (t[j]?.text === '.') j += 2;
  if (w(t[j]) !== 'USING') return syntax(stmt, (t[j] ?? t[t.length - 1]!).start - stmt.start, 'expected USING <module>');
  const module = t[j + 1];
  if (!module || module.kind !== 'word') return syntax(stmt, (module ?? t[t.length - 1]!).start - stmt.start, 'expected a module name after USING');
  if (module.upper !== 'FTS5') {
    return refuse(stmt, 'virtual-table-module', `CREATE VIRTUAL TABLE … USING ${module.text} is not allowed; only fts5 (#206).`);
  }
  if (t[j + 2]?.text !== '(') return syntax(stmt, (t[j + 2] ?? module).start - stmt.start, 'expected "(" after fts5');
  return null;
}

/**
 * CREATE TRIGGER [IF NOT EXISTS] name {BEFORE|AFTER|INSTEAD OF} {DELETE|INSERT|UPDATE [OF cols]}
 * ON table [FOR EACH ROW] [WHEN expr] BEGIN stmt; … END. The header's UPDATE and DELETE are
 * events, not statements; the body's DML is allowed with a warning.
 */
function checkTrigger(stmt: SqlStatement, warnings: string[]): MigrationLintError | null {
  const t = stmt.tokens;
  let j = 2; // after CREATE TRIGGER
  if (w(t[j]) === 'IF' && w(t[j + 1]) === 'NOT' && w(t[j + 2]) === 'EXISTS') j += 3;
  const name = t[j];
  if (!name || (name.kind !== 'word' && name.kind !== 'ident')) return syntax(stmt, (name ?? t[t.length - 1]!).start - stmt.start, 'expected a trigger name');
  j++;
  if (t[j]?.text === '.') { j += 2; }
  if (w(t[j]) === 'INSTEAD' && w(t[j + 1]) === 'OF') j += 2;
  else if (w(t[j]) === 'BEFORE' || w(t[j]) === 'AFTER') j++;
  else return syntax(stmt, (t[j] ?? name).start - stmt.start, 'expected BEFORE, AFTER or INSTEAD OF');
  const event = w(t[j]);
  if (event !== 'DELETE' && event !== 'INSERT' && event !== 'UPDATE') return syntax(stmt, (t[j] ?? name).start - stmt.start, 'expected DELETE, INSERT or UPDATE');
  const begin = atDepth0(t, j + 1, (x) => x.kind === 'word' && x.upper === 'BEGIN');
  if (begin < 0) return syntax(stmt, t[t.length - 1]!.start - stmt.start, 'CREATE TRIGGER has no BEGIN');
  const last = t.length - 1;
  if (w(t[last]) !== 'END' || t[last - 1]?.text !== ';' || last - 1 <= begin) {
    return syntax(stmt, t[last]!.start - stmt.start, 'CREATE TRIGGER body must end with "; END"');
  }
  // Body statements, split on depth-0 semicolons (a `;` cannot occur inside CASE or parentheses).
  const body = t.slice(begin + 1, last);
  const parts: SqlToken[][] = [];
  let cur: SqlToken[] = [];
  let depth = 0;
  for (const tok of body) {
    if (tok.kind === 'punct' && tok.text === '(') depth++;
    else if (tok.kind === 'punct' && tok.text === ')') depth--;
    if (depth === 0 && tok.kind === 'punct' && tok.text === ';') { if (cur.length) parts.push(cur); cur = []; continue; }
    cur.push(tok);
  }
  if (cur.length) parts.push(cur);
  const verbs = new Set<string>();
  for (const part of parts) {
    let head = w(part[0]);
    if (head === 'WITH') {
      const i = atDepth0(part, 1, (x) => x.kind === 'word' && ['INSERT', 'UPDATE', 'DELETE', 'REPLACE', 'SELECT'].includes(x.upper));
      head = i < 0 ? '' : part[i]!.upper;
    }
    if (!['INSERT', 'UPDATE', 'DELETE', 'REPLACE', 'SELECT'].includes(head)) {
      return refuse(stmt, 'trigger-body', `a trigger body may only contain INSERT, UPDATE, DELETE, REPLACE, SELECT or WITH statements (found ${part[0]!.text}).`);
    }
    if (head !== 'SELECT') verbs.add(head);
  }
  if (verbs.size) {
    warnings.push(`trigger ${name.text} runs ${[...verbs].join(', ')} on future writes. Allowed, but the platform discourages triggers: prefer the app's own batch actions (docs/standard/data.md).`);
  }
  return null;
}

/** Classify one statement. */
function lintStatement(stmt: SqlStatement, warnings: string[]): MigrationLintError | null {
  const t = stmt.tokens;
  if (!t.length) return null; // a comment-only fragment runs nothing
  const bad = structure(stmt);
  if (bad) return bad;
  // #508: `_pas_*` tables belong to the platform; a migration may not create, alter, write or drop one.
  const reserved = writesReservedTable(stmt.text);
  if (reserved) return refuse(stmt, 'reserved-table', `${reserved} is a platform table (_pas_*): apps may read it, never write it.`);
  const head = w(t[0]);
  switch (head) {
    case 'CREATE': {
      let j = 1;
      if (w(t[j]) === 'TEMP' || w(t[j]) === 'TEMPORARY') return refuse(stmt, 'no-temp-objects', 'TEMP objects vanish with the connection and are not allowed.');
      if (w(t[j]) === 'UNIQUE') j++;
      const kind = w(t[j]);
      if (kind === 'TABLE' || kind === 'INDEX' || kind === 'VIEW') return null;
      if (kind === 'TRIGGER' && j === 1) return checkTrigger(stmt, warnings);
      if (kind === 'VIRTUAL' && j === 1 && w(t[2]) === 'TABLE') return checkVirtualTable(stmt);
      return refuse(stmt, 'not-additive', `CREATE ${t[j]?.text ?? ''} is not allowed; the deploy path adds TABLE, INDEX, VIEW, TRIGGER and fts5 virtual tables.`);
    }
    case 'ALTER':
      return checkAlter(stmt);
    case 'INSERT':
      return checkInsert(stmt, 0);
    case 'WITH': {
      const i = atDepth0(t, 1, (x) => x.kind === 'word' && ['INSERT', 'UPDATE', 'DELETE', 'REPLACE', 'SELECT'].includes(x.upper));
      if (i < 0) return syntax(stmt, t[t.length - 1]!.start - stmt.start, 'WITH has no statement after its common table expressions');
      if (t[i]!.upper === 'INSERT') return checkInsert(stmt, i);
      return refuse(stmt, 'with-requires-insert', `WITH … ${t[i]!.text} is not allowed; only WITH … INSERT.`);
    }
    default: {
      const rule = DESTRUCTIVE[head];
      if (rule) return refuse(stmt, rule[0], rule[1]);
      return refuse(stmt, 'not-additive', `${t[0]!.text} is not allowed; the deploy path allows CREATE, ALTER … ADD, INSERT and CREATE VIRTUAL TABLE … USING fts5 only.`);
    }
  }
}

/** The first refused statement (full text, named rule) and the warnings for what is allowed. */
export function lintMigration(sql: string): MigrationLint {
  const warnings: string[] = [];
  for (const stmt of parseStatements(sql)) {
    const error = lintStatement(stmt, warnings);
    if (error) return { error, warnings };
  }
  return { error: null, warnings };
}
