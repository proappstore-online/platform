import { describe, expect, it } from 'vitest';
import { actionD1LimitError, boundParamCount, d1LimitError, maxCompoundTerms } from './d1-limits.js';

/** `n` SELECT terms joined by `op`. */
const union = (n: number, op = 'UNION ALL') => Array.from({ length: n }, (_, i) => `SELECT ${i} AS x`).join(` ${op} `);
/** A statement binding `n` distinct parameters. */
const params = (n: number) => `SELECT ${Array.from({ length: n }, (_, i) => `:p${i}`).join(', ')}`;

describe('boundParamCount (#571)', () => {
  it('counts every :name occurrence, as the executor binds them', () => {
    expect(boundParamCount('SELECT :a, :a, :__user_id, :__now FROM t WHERE x = :a')).toBe(5);
    expect(boundParamCount("SELECT '12:30', ?1, $x FROM t")).toBe(0);
  });

  it('counts an occurrence inside a string literal or comment, because the executor binds it there too', () => {
    expect(boundParamCount("SELECT ':a' -- :b\n/* :c */")).toBe(3);
  });
});

describe('maxCompoundTerms (#571)', () => {
  it('counts terms of UNION, UNION ALL, INTERSECT and EXCEPT alike', () => {
    expect(maxCompoundTerms('SELECT 1')).toBe(1);
    expect(maxCompoundTerms(union(5))).toBe(5);
    expect(maxCompoundTerms(union(6, 'UNION'))).toBe(6);
    expect(maxCompoundTerms('SELECT 1 UNION SELECT 2 INTERSECT SELECT 3 EXCEPT SELECT 4 union all select 5 Union Select 6')).toBe(6);
  });

  it('ignores the keywords inside string literals, quoted identifiers and comments', () => {
    const sql = `SELECT 'a UNION b', 'it''s UNION', "UNION", \`EXCEPT\`, [INTERSECT] FROM t -- UNION UNION
      /* UNION ALL UNION ALL UNION */ UNION ALL SELECT 1, 2, 3, 4, 5 FROM u`;
    expect(maxCompoundTerms(sql)).toBe(2);
  });

  it('counts each parenthesised chain on its own', () => {
    // 5 groups of 5 at the top level: 25 terms, never more than 5 in one chain (runs on D1).
    const nested = Array.from({ length: 5 }, () => `SELECT * FROM (${union(5)})`).join(' UNION ALL ');
    expect(maxCompoundTerms(nested)).toBe(5);
    expect(maxCompoundTerms(`SELECT * FROM (${union(6)})`)).toBe(6);
    expect(maxCompoundTerms(`SELECT 1 WHERE 1 IN (${union(6)})`)).toBe(6);
    // Sibling CTE bodies are separate chains, not one level's total.
    expect(maxCompoundTerms(`WITH a AS (${union(4)}), b AS (${union(4)}) SELECT * FROM a UNION ALL SELECT * FROM b`)).toBe(4);
  });

  it('counts a WITH RECURSIVE body as its own chain, as D1 does', () => {
    const recursive = 'WITH RECURSIVE r(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM r WHERE n < 3)';
    expect(maxCompoundTerms(`${recursive} SELECT n FROM r UNION ALL ${union(4)}`)).toBe(5);
    expect(maxCompoundTerms(`${recursive} SELECT n FROM r UNION ALL ${union(5)}`)).toBe(6);
    expect(maxCompoundTerms(`SELECT * FROM (${recursive} SELECT n FROM r) UNION ALL ${union(4)}`)).toBe(5);
  });

  it('does not count multi-row VALUES', () => {
    expect(maxCompoundTerms('INSERT INTO t (a) VALUES (1), (2), (3), (4), (5), (6), (7)')).toBe(1);
  });

  it('survives unbalanced or unterminated input', () => {
    expect(maxCompoundTerms(`${union(3)})) UNION ALL SELECT 9`)).toBe(4);
    expect(maxCompoundTerms(`SELECT (${union(6)}`)).toBe(6);
    expect(maxCompoundTerms("SELECT 'open UNION")).toBe(1);
    expect(maxCompoundTerms('SELECT 1 /* open UNION')).toBe(1);
  });
});

describe('d1LimitError (#571)', () => {
  it('allows 100 parameters and refuses 101, naming the limit and the fix', () => {
    expect(d1LimitError(params(100))).toBeNull();
    expect(d1LimitError(params(101))).toMatch(/^binds 101 parameters; D1 allows at most 100 per statement \("too many SQL variables"\).*derived table/);
  });

  it('allows 5 compound terms and refuses 6, naming the limit and the fix', () => {
    expect(d1LimitError(union(5))).toBeNull();
    expect(d1LimitError(union(6))).toMatch(/^has a compound SELECT of 6 terms at one level; D1 allows at most 5 \("too many terms in compound SELECT"\)\. Nest the union in groups of at most 5/);
  });
});

describe('actionD1LimitError (#571)', () => {
  it('names the action and the statement', () => {
    expect(actionD1LimitError({ name: 'ok', sql: union(5) })).toBeNull();
    expect(actionD1LimitError({ name: 'report', sql: union(6) })).toMatch(/^action "report" sql has a compound SELECT of 6 terms/);
    expect(actionD1LimitError({ name: 'save', statements: [params(10), params(100), params(101)] }))
      .toMatch(/^action "save" statements\[2\] binds 101 parameters/);
  });

  it('checks a verify action\'s input sql and its writes', () => {
    expect(actionD1LimitError({ name: 'v', sql: 'SELECT 1', statements: [union(6)] })).toMatch(/statements\[0\] has a compound SELECT of 6/);
  });

  it('skips what is not a string; registration reports the shape', () => {
    expect(actionD1LimitError({ name: 'x', sql: 42, statements: 'nope' })).toBeNull();
    expect(actionD1LimitError({ name: 'x', statements: [null, 7] })).toBeNull();
  });
});
