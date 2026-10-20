import { describe, expect, it } from 'vitest';
import { parseStatements, splitSqlStatements, tokenize } from './sql-statements.js';

// #455: the tokenizer and splitter shared by the executor and the backend lint.
describe('tokenize', () => {
  it('reads words, quoted identifiers, strings, numbers and punctuation; drops comments', () => {
    const t = tokenize("SELECT \"a b\", 'it''s', [c d], `e`, 1.5e3, 0x1F -- note\n FROM /* x */ t;");
    expect(t.map((x) => [x.kind, x.text])).toEqual([
      ['word', 'SELECT'], ['ident', '"a b"'], ['punct', ','], ['string', "'it''s'"], ['punct', ','],
      ['ident', '[c d]'], ['punct', ','], ['ident', '`e`'], ['punct', ','], ['number', '1.5e3'], ['punct', ','],
      ['number', '0x1F'], ['word', 'FROM'], ['word', 't'], ['punct', ';'],
    ]);
  });

  it('only a bare word has an upper-cased keyword form; a quoted identifier never does', () => {
    const [a, b] = tokenize('drop "drop"');
    expect(a).toMatchObject({ kind: 'word', upper: 'DROP' });
    expect(b).toMatchObject({ kind: 'ident', upper: '' });
  });

  it('flags unterminated strings, identifiers and block comments instead of throwing', () => {
    expect(tokenize("'abc")[0]).toMatchObject({ kind: 'string', error: 'unterminated string literal' });
    expect(tokenize('"abc')[0]).toMatchObject({ kind: 'ident', error: 'unterminated quoted identifier' });
    expect(tokenize('[abc')[0]).toMatchObject({ kind: 'ident', error: 'unterminated [identifier]' });
    expect(tokenize('a /* b')[1]).toMatchObject({ error: 'unterminated block comment' });
  });
});

describe('splitSqlStatements: a trigger ends at "END;" after a ";", like sqlite3_complete', () => {
  it('a CASE … END expression does not close the trigger body', () => {
    const trigger = "CREATE TRIGGER t AFTER INSERT ON m BEGIN INSERT INTO a VALUES (CASE WHEN NEW.x THEN 1 ELSE 0 END, 'b;c'); UPDATE n SET v = CASE WHEN 1 THEN 2 END; END";
    expect(splitSqlStatements(`${trigger}; SELECT 1; SELECT 2`)).toEqual([trigger, 'SELECT 1', 'SELECT 2']);
  });

  it('keeps a statement\'s own comments and trims, as before', () => {
    expect(splitSqlStatements('SELECT 1; -- a; b\nSELECT 2; /* c; d */ SELECT 3;')).toEqual(['SELECT 1', '-- a; b\nSELECT 2', '/* c; d */ SELECT 3']);
  });

  it('BEGIN TRANSACTION is a statement of its own, not a nesting level that swallows the rest', () => {
    expect(splitSqlStatements('BEGIN TRANSACTION; DROP TABLE t; COMMIT')).toEqual(['BEGIN TRANSACTION', 'DROP TABLE t', 'COMMIT']);
  });

  it('an unterminated string or comment runs to the end of the input', () => {
    expect(splitSqlStatements("SELECT 1; SELECT 'a; SELECT 2")).toEqual(['SELECT 1', "SELECT 'a; SELECT 2"]);
    expect(splitSqlStatements('SELECT 1; /* a; SELECT 2')).toEqual(['SELECT 1', '/* a; SELECT 2']);
  });

  it('empty and semicolon-only input has no statements', () => {
    expect(splitSqlStatements('')).toEqual([]);
    expect(splitSqlStatements(' ;; ; ')).toEqual([]);
  });
});

describe('parseStatements', () => {
  it('gives each statement its tokens and offset; comment-only fragments have none', () => {
    const [a, b, c] = parseStatements('CREATE TABLE a (id);  -- hi\n DROP TABLE b; -- tail');
    expect(a!.text).toBe('CREATE TABLE a (id)');
    expect(a!.start).toBe(0);
    expect(b!.tokens.map((t) => t.upper)).toEqual(['DROP', 'TABLE', 'B']);
    expect(c!.text).toBe('-- tail');
    expect(c!.tokens).toEqual([]);
  });
});
