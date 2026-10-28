import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { prepareActionBatch, prepareActionQuery, type ToolManifest } from '../../../backend/src/lib/action-sql';
import { splitSqlStatements as dataWorkerSplit } from '../../../data-worker/src/sql-statements';
import { splitSqlStatements as vendoredSplit } from '../../../cli/src/lib/sql-statements';
import { bindAction } from '../../../cli/src/migrations-test';

// #503: `pas migrations test` mirrors two pieces of the platform (the data worker's statement splitter and the
// backend executor's placeholder binding). Held equal here, where cross-package imports are normal.

const here = dirname(fileURLToPath(import.meta.url));

describe('what `pas migrations test` mirrors (#503)', () => {
  it("splits SQL with the data worker's own splitter: the vendored copy is the same file, header aside", () => {
    const original = readFileSync(join(here, '../../../data-worker/src/sql-statements.ts'), 'utf8');
    const vendored = readFileSync(join(here, '../../../cli/src/lib/sql-statements.ts'), 'utf8');
    expect(vendored.endsWith(original)).toBe(true);
    expect(vendored.slice(0, vendored.length - original.length)).toMatch(/^\/\/ VENDORED from packages\/data-worker\/src\/sql-statements\.ts/);
  });

  it('and agrees with it on triggers, CASE ... END, strings with semicolons and comments', () => {
    for (const sql of [
      "CREATE TABLE t (a TEXT); INSERT INTO t VALUES ('a;b');",
      "CREATE TRIGGER x AFTER INSERT ON t BEGIN UPDATE t SET a = CASE WHEN 1 THEN 'x' ELSE 'y' END; DELETE FROM t WHERE 0; END; CREATE INDEX i ON t (a);",
      '-- a comment; with a semicolon\nCREATE TABLE u (b INTEGER); /* block; comment */ CREATE TABLE v (c INTEGER)',
    ]) expect(vendoredSplit(sql)).toEqual(dataWorkerSplit(sql));
  });

  it("binds an action's SQL exactly as the backend executor does", () => {
    const query = {
      name: 'q', operation: 'query', requires_auth: true, params: { limit: { type: 'integer', max: 50 }, q: { type: 'string' } },
      sql: 'SELECT * FROM t WHERE user_id = :__user_id AND body LIKE :q LIMIT :limit',
    } as unknown as ToolManifest;
    const resolved = { limit: 5, q: 'x' };
    const theirs = prepareActionQuery(query, resolved, 'u1');
    const ours = bindAction(query.sql!, resolved, 'u1');
    expect(ours).toEqual(theirs);

    const batch = { name: 'b', operation: 'batch', requires_auth: true, params: { id: { type: 'string' } }, statements: ['INSERT INTO t (id, u, at) VALUES (:id, :__user_id, :__now)', 'UPDATE t SET at = :__now WHERE id = :id'] } as unknown as ToolManifest;
    const now = 1_700_000_000_000;
    const bound = batch.statements!.map((sql) => bindAction(sql, { id: 'a' }, 'u1', now));
    const dateNow = Date.now;
    Date.now = () => now;
    try {
      expect(bound).toEqual(prepareActionBatch(batch, { id: 'a' }, 'u1'));
    } finally {
      Date.now = dateNow;
    }
  });
});
