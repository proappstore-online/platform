import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { splitSqlStatements } from '../../../data-worker/src/sql-statements.js';
import { lintMigration } from './migration-lint.js';
import { forbiddenMigrationStatement, splitMigrationStatements } from '../routes/deploy.js';

// #455: the additive-only lint classifies statements from the SQLite token stream,
// never from substrings, and judges them where the data worker's executor cuts them.

const ok = (sql: string) => {
  const r = lintMigration(sql);
  expect(r.error, sql).toBeNull();
  return r;
};
const refused = (sql: string, rule: string, statement?: string) => {
  const r = lintMigration(sql);
  expect(r.error, sql).not.toBeNull();
  expect(r.error!.rule, sql).toBe(rule);
  expect(r.error!.reason).toMatch(new RegExp(`^${rule}: `));
  if (statement) expect(r.error!.statement).toBe(statement);
  return r.error!;
};

describe('accepts valid SQL the string matcher refused (#455)', () => {
  it('CASE … END inside a trigger body (the END is not the end of the trigger)', () => {
    const trigger = "CREATE TRIGGER t AFTER INSERT ON x BEGIN INSERT INTO y(v) VALUES (CASE WHEN NEW.a > 1 THEN 'big' ELSE 'small' END); END";
    ok(`${trigger}; CREATE TABLE after_it (id)`);
    expect(splitSqlStatements(`${trigger}; CREATE TABLE after_it (id)`)).toEqual([trigger, 'CREATE TABLE after_it (id)']);
  });

  it('ON DELETE / ON UPDATE clauses in foreign keys', () => {
    ok('CREATE TABLE a (id INTEGER PRIMARY KEY, b INTEGER REFERENCES x(id) ON DELETE CASCADE ON UPDATE SET NULL)');
    ok('CREATE TABLE a (id, b, FOREIGN KEY (b) REFERENCES x(id) ON DELETE SET DEFAULT)');
  });

  it('trigger events BEFORE UPDATE OF col, AFTER DELETE ON, INSTEAD OF', () => {
    ok("CREATE TRIGGER t BEFORE UPDATE OF col ON x BEGIN SELECT RAISE(ABORT, 'immutable'); END");
    ok('CREATE TRIGGER t AFTER DELETE ON x BEGIN SELECT 1; END');
    ok('CREATE TRIGGER IF NOT EXISTS t INSTEAD OF INSERT ON v BEGIN SELECT 1; END');
  });

  it('INSERT OR IGNORE, INSERT … SELECT, WITH … INSERT, ON CONFLICT DO NOTHING', () => {
    ok("INSERT OR IGNORE INTO a (x) VALUES (1)");
    ok('INSERT INTO a (x) SELECT y FROM b');
    ok('INSERT OR ABORT INTO a (x) VALUES (1)');
    ok('WITH c AS (SELECT 1 AS n) INSERT INTO a SELECT n FROM c');
    ok('INSERT INTO a (id) VALUES (1) ON CONFLICT (id) DO NOTHING');
  });

  it('WITH RECURSIVE and RAISE inside a trigger', () => {
    ok('CREATE TRIGGER t AFTER INSERT ON x BEGIN INSERT OR IGNORE INTO y WITH RECURSIVE c(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM c WHERE n < 3) SELECT n FROM c; END');
    ok("CREATE TRIGGER t BEFORE INSERT ON x WHEN NEW.p IS NOT NULL AND NOT EXISTS (SELECT 1 FROM x r WHERE r.id = NEW.p) BEGIN SELECT RAISE(ABORT, 'invalid_root'); END");
  });

  it('an fts5 virtual table', () => {
    ok("CREATE VIRTUAL TABLE IF NOT EXISTS p_fts USING fts5(title, body, content='p', tokenize = 'porter unicode61')");
    ok('create virtual table "search idx" using FTS5 (name)');
  });

  it("string literals containing drop, ;, END or --, and comments containing keywords", () => {
    ok("INSERT INTO t (note) VALUES ('first; then DROP TABLE t; END; -- not a comment')");
    ok("INSERT INTO t (a) VALUES ('drop'), ('DELETE FROM t'), ('it''s; END')");
    ok('-- DROP TABLE t;\nCREATE TABLE a (id); /* DELETE FROM a; PRAGMA x; */ CREATE INDEX i ON a(id)');
    ok('CREATE TABLE a (id) -- UPDATE a SET id = 1;\n');
    ok('CREATE TABLE "drop" (id); CREATE TABLE `delete` (id); CREATE TABLE [update] (id)');
  });

  it('a comment-only fragment runs nothing', () => {
    ok('-- just a note');
    ok('CREATE TABLE a (id);\n-- trailing note');
  });
});

describe('warns on DML inside a trigger body, naming the trigger', () => {
  it('UPDATE / INSERT / DELETE in the body are allowed with a warning; SELECT-only bodies are not', () => {
    const w = ok("CREATE TRIGGER member_handle AFTER INSERT ON m BEGIN UPDATE m SET h = 'x'; INSERT INTO log VALUES (1); END").warnings;
    expect(w).toHaveLength(1);
    expect(w[0]).toMatch(/trigger member_handle runs UPDATE, INSERT on future writes/);
    expect(ok("CREATE TRIGGER g BEFORE INSERT ON x BEGIN SELECT RAISE(ABORT, 'no'); END").warnings).toEqual([]);
  });

  it('refuses a body statement that is not DML (DROP, PRAGMA cannot hide there)', () => {
    refused('CREATE TRIGGER t AFTER INSERT ON x BEGIN DROP TABLE y; END', 'trigger-body');
    refused('CREATE TRIGGER t AFTER INSERT ON x BEGIN SELECT 1; PRAGMA foreign_keys = OFF; END', 'trigger-body');
  });
});

describe('rejects, naming the rule and quoting the whole statement (#455)', () => {
  it.each<[string, string]>([
    ['DROP TABLE x', 'no-drop'],
    ['DROP INDEX i', 'no-drop'],
    ['DELETE FROM x', 'no-delete'],
    ["UPDATE x SET a = 1", 'no-update'],
    ['ALTER TABLE x RENAME TO y', 'no-rename'],
    ['ALTER TABLE x RENAME COLUMN a TO b', 'no-rename'],
    ['ALTER TABLE x DROP COLUMN c', 'no-drop-column'],
    ['PRAGMA foreign_keys=off', 'no-pragma'],
    ["ATTACH 'f' AS d", 'no-attach'],
    ['DETACH d', 'no-attach'],
    ['VACUUM', 'no-vacuum'],
    ['REINDEX', 'no-reindex'],
    ['REPLACE INTO t VALUES (1)', 'no-replace'],
    ['INSERT OR REPLACE INTO t VALUES (1)', 'no-replace'],
    ['INSERT INTO t (id, n) VALUES (1, 2) ON CONFLICT (id) DO UPDATE SET n = excluded.n', 'no-upsert-update'],
    ['WITH c AS (SELECT 1) DELETE FROM t', 'with-requires-insert'],
    ['WITH c AS (SELECT 1) UPDATE t SET a = 1', 'with-requires-insert'],
    ['CREATE VIRTUAL TABLE v USING rtree(id, a, b)', 'virtual-table-module'],
    ['CREATE VIRTUAL TABLE v USING fts5vocab(p_fts, row)', 'virtual-table-module'],
    ['CREATE VIRTUAL TABLE x USING fts4(a)', 'virtual-table-module'],
    ['CREATE TEMP TABLE t (id)', 'no-temp-objects'],
    ['SELECT 1', 'not-additive'],
    ['BEGIN TRANSACTION', 'not-additive'],
    ['CREATE DATABASE x', 'not-additive'],
  ])('%s → %s', (sql, rule) => {
    refused(sql, rule, sql);
  });

  it('ADD COLUMN … NOT NULL needs a non-null DEFAULT', () => {
    refused('ALTER TABLE t ADD COLUMN c TEXT NOT NULL', 'not-null-needs-default');
    refused('ALTER TABLE t ADD c TEXT NOT NULL DEFAULT NULL', 'not-null-needs-default');
    refused('ALTER TABLE t ADD COLUMN c TEXT NOT NULL DEFAULT (NULL)', 'not-null-needs-default');
    ok("ALTER TABLE t ADD COLUMN c TEXT NOT NULL DEFAULT 'active'");
    ok("ALTER TABLE t ADD COLUMN c INTEGER NOT NULL DEFAULT 0 CHECK(c IN (0,1))");
    ok("ALTER TABLE t ADD COLUMN note TEXT DEFAULT 'NOT NULL is fine here'");
    ok('ALTER TABLE t ADD COLUMN c TEXT CHECK (c IS NOT NULL)'); // NOT NULL inside a CHECK is not a constraint on the column
    ok('ALTER TABLE main.t ADD COLUMN "not" TEXT');
  });

  it('quotes the full statement, not the first 80 characters', () => {
    const long = `DROP TABLE ${'very_long_table_name_'.repeat(8)}x`;
    expect(refused(long, 'no-drop').statement).toBe(long);
    expect(forbiddenMigrationStatement(long)!.statement).toBe(long);
  });

  it('a quoted identifier named "drop" at statement start is not the DROP keyword, and not a statement either', () => {
    // A quoted token is an identifier, never a keyword, so `"drop" …` is not DROP: it is simply not an allowed statement.
    refused('"drop" TABLE t', 'not-additive', '"drop" TABLE t');
    refused('[delete] FROM t', 'not-additive');
  });

  it('smuggling: a statement after a CASE … END trigger is still judged', () => {
    const trigger = 'CREATE TRIGGER t AFTER INSERT ON x BEGIN INSERT INTO y VALUES (CASE WHEN 1 THEN 1 ELSE 0 END); END';
    refused(`${trigger}; CREATE TABLE a(x); DROP TABLE b`, 'no-drop', 'DROP TABLE b');
    refused(`${trigger}; DROP TABLE b`, 'no-drop', 'DROP TABLE b');
    refused("CREATE TABLE a(x); INSERT INTO t VALUES ('--'); DROP TABLE t", 'no-drop', 'DROP TABLE t');
  });

  it('unparseable SQL is refused, naming the position', () => {
    expect(refused("INSERT INTO t VALUES ('abc", 'syntax').reason).toMatch(/unterminated string literal at line 1, column 23/);
    expect(refused('CREATE TABLE a (id', 'syntax').reason).toMatch(/unclosed "\(" at line 1, column 16/);
    expect(refused('CREATE TABLE a (id))', 'syntax').reason).toMatch(/unmatched "\)"/);
    expect(refused('CREATE TABLE a (id) /* open', 'syntax').reason).toMatch(/unterminated block comment/);
    expect(refused('CREATE TABLE "x (id)', 'syntax').reason).toMatch(/unterminated quoted identifier/);
    expect(refused('CREATE TRIGGER t AFTER INSERT ON x BEGIN SELECT 1', 'syntax').reason).toMatch(/must end with "; END"/);
    expect(refused('CREATE TRIGGER t AFTER INSERT ON x SELECT 1', 'syntax').reason).toMatch(/no BEGIN/);
    expect(refused('CREATE TRIGGER t SOMETIMES INSERT ON x BEGIN SELECT 1; END', 'syntax').reason).toMatch(/expected BEFORE, AFTER or INSTEAD OF/);
    expect(refused('INSERT t VALUES (1)', 'syntax').reason).toMatch(/expected INTO after INSERT/);
    expect(refused('WITH c AS (SELECT 1)', 'syntax').reason).toMatch(/WITH has no statement/);
    expect(refused('CREATE VIRTUAL TABLE v fts5(a)', 'syntax').reason).toMatch(/expected USING/);
  });
});

describe('real migrations: Slackie (#455)', () => {
  type Mig = { migrations: { name: string; sql: string }[] };
  const load = (f: string) => JSON.parse(readFileSync(new URL(`../__fixtures__/${f}`, import.meta.url), 'utf8')) as Mig;

  it('accepts the current Slackie migrations.json (0870305), CASE … END triggers included', () => {
    const { migrations } = load('slackie-migrations-0870305.json');
    expect(migrations.map((m) => m.name)).toHaveLength(7);
    for (const m of migrations) expect(lintMigration(m.sql).error, m.name).toBeNull();
  });

  it('the originals (31e54f0): 0001–0004 pass, and 0005–0007 now fail ONLY on their top-level UPDATE backfills', () => {
    // Those three carried `UPDATE … SET` backfills, which the additive-only deploy path still refuses
    // (rule table, #455): the lint stops at them, naming the rule, instead of at a trigger's END.
    const { migrations } = load('slackie-migrations-31e54f0.json');
    for (const m of migrations.slice(0, 4)) expect(lintMigration(m.sql).error, m.name).toBeNull();
    for (const m of migrations.slice(4)) {
      const e = lintMigration(m.sql).error!;
      expect(e.rule, m.name).toBe('no-update');
      expect(e.statement).toMatch(/^UPDATE /);
      // With the backfills removed, the rest of each migration (its triggers, INSERT OR IGNORE, FKs) passes.
      const rest = splitSqlStatements(m.sql).filter((s) => !/^UPDATE /i.test(s)).join(';\n');
      expect(lintMigration(rest).error, `${m.name} without its UPDATE backfills`).toBeNull();
    }
  });
});

describe('lint and executor split identically (#455)', () => {
  const corpus = [
    'CREATE TABLE a (id); CREATE TABLE b (id);',
    "INSERT INTO t VALUES ('a;b'); INSERT INTO t VALUES ('c')",
    "INSERT INTO t VALUES ('--'); DROP TABLE t",
    'CREATE TRIGGER a AFTER INSERT ON x BEGIN INSERT INTO y VALUES (1); INSERT INTO z VALUES (2); END; CREATE TABLE q (id)',
    'CREATE TRIGGER c AFTER INSERT ON x BEGIN INSERT INTO y VALUES (CASE WHEN 1 THEN 1 ELSE 0 END); END; CREATE TABLE q (id); DROP TABLE b',
    'CREATE TRIGGER c AFTER INSERT ON x BEGIN SELECT CASE WHEN 1 THEN 1 END; SELECT 2; END; SELECT 3',
    'CREATE TEMP TRIGGER c AFTER INSERT ON x BEGIN SELECT 1; END; SELECT 2',
    'CREATE TABLE "a;b" (id); CREATE TABLE `c;d` (id); CREATE TABLE [e;f] (id)',
    "-- note; still a comment\nCREATE TABLE r (id); /* x; y */ CREATE TABLE s (id)",
    "INSERT INTO t VALUES ('it''s; fine'); BEGIN TRANSACTION; DROP TABLE t",
    "INSERT INTO t VALUES ('unterminated; DROP TABLE t",
    'CREATE TABLE a (id) /* unterminated; DROP TABLE a',
    '',
    ';;; ;',
    'SELECT CASE WHEN a THEN 1 ELSE 2 END AS x; SELECT 9;',
    readFileSync(new URL('../__fixtures__/slackie-migrations-0870305.json', import.meta.url), 'utf8'),
  ];
  it.each(corpus.map((sql, i) => [i, sql] as const))('case %i', (_i, sql) => {
    expect(splitMigrationStatements(sql)).toEqual(splitSqlStatements(sql));
  });

  it('every Slackie migration (both revisions) splits the same for the lint and the executor', () => {
    for (const f of ['slackie-migrations-31e54f0.json', 'slackie-migrations-0870305.json']) {
      const { migrations } = JSON.parse(readFileSync(new URL(`../__fixtures__/${f}`, import.meta.url), 'utf8')) as { migrations: { sql: string }[] };
      for (const m of migrations) expect(splitMigrationStatements(m.sql)).toEqual(splitSqlStatements(m.sql));
    }
  });
});
