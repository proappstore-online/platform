import { describe, expect, it } from 'vitest';
import { mainStatementVerb, validateSql } from './sql.js';

describe('mainStatementVerb (#120)', () => {
  it('returns the first token when there is no CTE', () => {
    expect(mainStatementVerb('SELECT 1')).toBe('SELECT');
    expect(mainStatementVerb('  insert into t values (1)')).toBe('INSERT');
    expect(mainStatementVerb('')).toBeNull();
  });

  it('skips a single CTE and a recursive one', () => {
    expect(mainStatementVerb('WITH a AS (SELECT 1) SELECT * FROM a')).toBe('SELECT');
    expect(mainStatementVerb(
      'WITH RECURSIVE tok(i, head, rest) AS (SELECT 0, NULL, :line UNION ALL SELECT i+1, substr(rest,1,4), substr(rest,6) FROM tok WHERE rest <> \'\') INSERT INTO puzzle_attempt_moves (attempt_id, ply, san) SELECT :attempt_id, i, head FROM tok WHERE i = :ply',
    )).toBe('INSERT');
  });

  it('skips several CTEs, nested parens, column lists and MATERIALIZED hints', () => {
    expect(mainStatementVerb(
      'WITH a(x) AS NOT MATERIALIZED (SELECT count(*) FROM (SELECT 1)), b AS MATERIALIZED (SELECT x FROM a WHERE x IN (1,2)) UPDATE t SET n = (SELECT x FROM b) WHERE id = :id',
    )).toBe('UPDATE');
  });

  it('is not fooled by parentheses or keywords inside string literals or comments', () => {
    expect(mainStatementVerb("WITH a AS (SELECT ')' AS s, 'it''s (' AS t) DELETE FROM t WHERE s = 'AS (' AND id = :id")).toBe('DELETE');
    expect(mainStatementVerb('WITH a AS (SELECT 1 -- ) SELECT\n) /* ) DROP */ INSERT INTO t SELECT * FROM a')).toBe('INSERT');
  });

  it('returns null for an unterminated CTE', () => {
    expect(mainStatementVerb('WITH a AS (SELECT 1 SELECT * FROM a')).toBeNull();
    expect(mainStatementVerb('WITH a AS SELECT 1')).toBeNull();
  });
});

describe('validateSql', () => {
  it('accepts a scoped query and rejects the wrong verb for the operation', () => {
    expect(validateSql('SELECT 1', 'query')).toBeNull();
    expect(validateSql('SELECT 1', 'execute')).toBe('operation "execute" must not use SELECT (use "query" instead)');
    expect(validateSql('DELETE FROM t WHERE id = 1', 'query')).toBe('operation "query" must use SELECT');
  });

  it('refuses multi-statement SQL, DDL keywords and an unguarded UPDATE/DELETE', () => {
    expect(validateSql('SELECT 1; SELECT 2', 'query')).toBe('SQL must not contain semicolons (no multi-statement)');
    expect(validateSql('SELECT * FROM t WHERE x = (SELECT DROP)', 'query')).toBe('SQL must not contain DROP');
    expect(validateSql('UPDATE t SET a = 1', 'execute')).toBe('UPDATE/DELETE SQL must have a WHERE clause');
    expect(validateSql('PRAGMA user_version', 'query')).toMatch(/^SQL must start with/);
  });
});
