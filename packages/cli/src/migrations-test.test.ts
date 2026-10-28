import { describe, expect, it } from 'vitest';
import { parseStatements, tokenize, type SqlStatement, type SqlToken } from './lib/sql-statements.js';
import { bindAction, isConstraintRejection, MiniflareUnavailable, sampleParam, testMigrationChain, withFreshD1, type D1Like } from './migrations-test.js';

describe('the vendored statement splitter (#503)', () => {
  it('tokenizes without comments, and reports where each statement starts', () => {
    const sql = "-- header\nCREATE TABLE a (x TEXT DEFAULT 'a;b'); /* gap */ CREATE TABLE b (y INTEGER);";
    const tokens: SqlToken[] = tokenize(sql);
    expect(tokens.some((t) => t.text.includes('header') || t.text.includes('gap'))).toBe(false);
    expect(tokens.find((t) => t.kind === 'string')?.text).toBe("'a;b'");
    const statements: SqlStatement[] = parseStatements(sql);
    expect(statements).toHaveLength(2);
    expect(statements[0]!.text).toContain('CREATE TABLE a');
    expect(statements[1]!.text).toContain('CREATE TABLE b');
    expect(statements[1]!.start).toBe(sql.indexOf('/* gap */')); // comments stay in the statement's text, as the executor sends them
  });

  it('keeps a trigger body, CASE ... END included, as one statement', () => {
    const sql = "CREATE TRIGGER t AFTER INSERT ON a BEGIN UPDATE a SET x = CASE WHEN 1 THEN 'p' ELSE 'q' END; DELETE FROM a WHERE 0; END; CREATE INDEX i ON a (x);";
    expect(parseStatements(sql)).toHaveLength(2);
  });
});

describe('binding', () => {
  it('refuses an unresolved parameter, as the executor does', () => {
    expect(() => bindAction('SELECT :nope', {})).toThrow(/Unresolved parameter: nope/);
  });

  it('draws __uuid fresh for each occurrence', () => {
    const { params } = bindAction('INSERT INTO t VALUES (:__uuid, :__uuid)', {});
    expect(params[0]).not.toEqual(params[1]);
  });
});

describe('sample params', () => {
  it('prefers a default, then an enum value, then something of the right type within its cap', () => {
    expect(sampleParam({ type: 'string', default: 'fixed' })).toBe('fixed');
    expect(sampleParam({ type: 'string', enum: ['a', 'b'] })).toBe('a');
    expect(sampleParam({ type: 'integer' })).toBe(1);
    expect(sampleParam({ type: 'integer', max: 0 })).toBe(0);
    expect(sampleParam({ type: 'number' })).toBe(1);
    expect(sampleParam({ type: 'boolean' })).toBe(true);
    expect(sampleParam({ type: 'string' })).toBe('sample');
    expect(sampleParam({})).toBe('sample');
  });
});

describe('the report, on a scripted D1', () => {
  /** A D1 whose statements fail by what they contain. */
  function scripted(fail: Record<string, string>): { db: D1Like; ran: string[] } {
    const ran: string[] = [];
    const attempt = async (sql: string): Promise<unknown> => {
      ran.push(sql);
      for (const [needle, message] of Object.entries(fail)) if (sql.includes(needle)) throw new Error(message);
      return {};
    };
    const db: D1Like = {
      prepare: (sql) => ({ run: () => attempt(sql), bind: () => ({ run: () => attempt(sql), all: () => attempt(sql) }) }),
      batch: async (stmts) => { for (const s of stmts as { _sql?: string }[]) void s; return {}; },
    };
    return { db, ran };
  }

  it('classifies a constraint rejection as rejected and any other SQLite error as failed', async () => {
    const { db } = scripted({ reject_me: 'D1_ERROR: UNIQUE constraint failed: t.a: SQLITE_CONSTRAINT', break_me: 'D1_ERROR: no such column: x: SQLITE_ERROR' });
    const r = await testMigrationChain(db, { migrations: [{ name: '1', sql: 'CREATE TABLE t (a)' }], actions: [
      { name: 'ok', operation: 'query', sql: 'SELECT 1' },
      { name: 'rej', operation: 'execute', sql: 'INSERT reject_me' },
      { name: 'bad', operation: 'execute', sql: 'INSERT break_me' },
    ] });
    expect(r.actions.map((a) => [a.name, a.outcome])).toEqual([['ok', 'ok'], ['rej', 'rejected'], ['bad', 'failed']]);
    expect(r.ok).toBe(false);
  });

  it('stops at the first failing migration statement, names it, and runs no action', async () => {
    const { db, ran } = scripted({ boom: 'D1_ERROR: near "boom": syntax error: SQLITE_ERROR' });
    const r = await testMigrationChain(db, { migrations: [{ name: '0001', sql: 'CREATE TABLE a (x); boom; CREATE TABLE c (z)' }, { name: '0002', sql: 'CREATE TABLE later (y)' }], actions: [{ name: 'q', operation: 'query', sql: 'SELECT 1' }] });
    expect(r.migrationFailure).toMatchObject({ migration: '0001', statementIndex: 1, statement: 'boom' });
    expect(r.ok).toBe(false);
    expect(r.actions).toEqual([]);
    expect(ran).toEqual(['CREATE TABLE a (x)', 'boom']);
  });

  it('is ok when everything runs, counting migrations and statements', async () => {
    const { db } = scripted({});
    const r = await testMigrationChain(db, { migrations: [{ name: '1', sql: 'CREATE TABLE a (x); CREATE TABLE b (y)' }], actions: [] });
    expect(r).toMatchObject({ migrations: 1, statements: 2, ok: true, migrationFailure: null });
  });

  it('recognises only SQLITE_CONSTRAINT (with or without an extended code) as an expected rejection', () => {
    for (const m of ['x: SQLITE_CONSTRAINT', 'x: SQLITE_CONSTRAINT_TRIGGER', 'x: SQLITE_CONSTRAINT (extended: SQLITE_CONSTRAINT_FOREIGNKEY)']) expect(isConstraintRejection(m)).toBe(true);
    for (const m of ['x: SQLITE_ERROR', 'no such column: a', 'D1_ERROR: Network connection lost.']) expect(isConstraintRejection(m)).toBe(false);
  });

  it('says how to get miniflare when it cannot be loaded', async () => {
    await expect(withFreshD1(async () => 1, async () => { throw new MiniflareUnavailable('miniflare is not installed.'); })).rejects.toBeInstanceOf(MiniflareUnavailable);
  });
});
