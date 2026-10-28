import { describe, expect, it } from 'vitest';
import { type ActionManifest, testMigrationChain, withFreshD1 } from '../../../cli/src/migrations-test';

// #503 on workerd's own D1 (miniflare), in plain Node: `pas migrations test` applies a chain to a fresh database and
// runs every action once. The point is what node:sqlite let through in bookkeeper #62 and D1 did not.

// miniflare resolves from this package, as it does beside the CLI under `npx -p @proappstore/cli -p miniflare`.
const load = () => import('miniflare') as never;
const run = (migrations: { name: string; sql: string }[], actions: ActionManifest[]) => withFreshD1((db) => testMigrationChain(db, { migrations, actions }), load);
const outcomes = (r: Awaited<ReturnType<typeof run>>) => Object.fromEntries(r.actions.map((a) => [a.name, a.outcome]));

const NOTES = {
  name: '0001_notes',
  sql: `CREATE TABLE notes (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, body TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'open', updated_at INTEGER);
CREATE UNIQUE INDEX notes_body ON notes (user_id, body);`,
};
const addNote: ActionManifest = {
  name: 'add_note', operation: 'execute', params: { body: { type: 'string', default: 'first note' } },
  sql: 'INSERT INTO notes (id, user_id, body) VALUES (:__uuid, :__user_id, :body)',
};
const listNotes: ActionManifest = { name: 'list_notes', operation: 'query', params: {}, sql: 'SELECT id, body FROM notes WHERE user_id = :__user_id LIMIT 50' };

describe('migration chain on a fresh D1 (#503)', () => {
  it('applies a good chain, including a trigger with CASE ... END, and every action runs', async () => {
    const r = await run([
      NOTES,
      { name: '0002_touch', sql: `CREATE TRIGGER notes_touch AFTER INSERT ON notes BEGIN UPDATE notes SET updated_at = CASE WHEN NEW.status = 'open' THEN 1 ELSE 2 END WHERE id = NEW.id; END;` },
    ], [addNote, listNotes, {
      name: 'rename_body', operation: 'batch', params: { id: { type: 'string', default: 'row-2' }, body: { type: 'string', default: 'second note' } },
      statements: ['INSERT INTO notes (id, user_id, body) VALUES (:id, :__user_id, :body)', "UPDATE notes SET body = :body || '!' WHERE id = :id"],
    }]);
    expect(r.migrationFailure).toBeNull();
    expect(r.migrations).toBe(2);
    expect(outcomes(r)).toEqual({ add_note: 'ok', list_notes: 'ok', rename_body: 'ok' });
    expect(r.ok).toBe(true);
  });

  it('fails the run on a migration statement D1 refuses, names it, and does not go on', async () => {
    const r = await run([NOTES, { name: '0002_bad', sql: 'CREATE TABLE ok (id TEXT); CREATE INDEX nope ON missing_table (x);' }, { name: '0003_after', sql: 'CREATE TABLE after (id TEXT)' }], [listNotes]);
    expect(r.ok).toBe(false);
    expect(r.migrationFailure).toMatchObject({ migration: '0002_bad', statementIndex: 1 });
    expect(r.migrationFailure!.detail).toMatch(/missing_table|no such table/);
    expect(r.migrations).toBe(1);
    expect(r.actions).toEqual([]); // nothing after a broken migration means anything
  });

  it("catches a trigger that applies cleanly but breaks every insert: the bookkeeper #62 class", async () => {
    const r = await run([
      NOTES,
      // Applies without complaint; fails the moment a row goes in, because the column it reads is not there.
      { name: '0002_broken_trigger', sql: 'CREATE TRIGGER notes_bad AFTER INSERT ON notes BEGIN UPDATE notes SET updated_at = NEW.no_such_column WHERE id = NEW.id; END;' },
    ], [addNote, listNotes]);
    expect(r.migrationFailure).toBeNull(); // the migration itself went through, as it did in production
    expect(outcomes(r)).toEqual({ add_note: 'failed', list_notes: 'ok' });
    expect(r.actions.find((a) => a.name === 'add_note')!.detail).toMatch(/no such column|SQLITE_ERROR/);
    expect(r.ok).toBe(false);
  });

  it('fails an action whose SQL names a column the schema does not have', async () => {
    const r = await run([NOTES], [{ name: 'by_title', operation: 'query', params: {}, sql: 'SELECT id FROM notes WHERE title = :__user_id' }, listNotes]);
    expect(outcomes(r)).toEqual({ by_title: 'failed', list_notes: 'ok' });
    expect(r.ok).toBe(false);
  });

  it('does not fail on a constraint rejection: a unique index, a NOT NULL, a foreign key or a trigger RAISE is the schema working', async () => {
    const r = await run([
      { name: '0001', sql: `PRAGMA foreign_keys = ON; CREATE TABLE orgs (id TEXT PRIMARY KEY); CREATE TABLE members (id TEXT PRIMARY KEY, org_id TEXT NOT NULL REFERENCES orgs(id), email TEXT UNIQUE);
CREATE TRIGGER guard BEFORE INSERT ON members WHEN NEW.id = 'sample' BEGIN SELECT RAISE(ABORT, 'APP:sensitive_input'); END;` },
    ], [
      { name: 'add_member', operation: 'execute', params: { org: { type: 'string' } }, sql: 'INSERT INTO members (id, org_id) VALUES (:org, :org)' },
      { name: 'no_org', operation: 'execute', params: { id: { type: 'string' } }, sql: 'INSERT INTO members (id) VALUES (:id)' },
    ]);
    expect(Object.values(outcomes(r))).toEqual(['rejected', 'rejected']);
    expect(r.ok).toBe(true);
  });

  it('runs a batch atomically and reports a failing statement in it', async () => {
    const r = await run([NOTES], [{
      name: 'two_step', operation: 'batch', params: { body: { type: 'string' } },
      statements: ['INSERT INTO notes (id, user_id, body) VALUES (:__uuid, :__user_id, :body)', 'UPDATE notes SET nope = 1 WHERE user_id = :__user_id'],
    }]);
    expect(outcomes(r)).toEqual({ two_step: 'failed' });
    // the first statement was rolled back with the batch
    expect(r.actions[0]!.detail).toMatch(/nope|no such column|SQLITE_ERROR/);
  });

  it('types the sample params the way the executor does: integers, booleans, enums, defaults, caps', async () => {
    const r = await run([{ name: '0001', sql: 'CREATE TABLE t (n INTEGER NOT NULL CHECK (n <= 5), flag INTEGER, kind TEXT CHECK (kind IN (\'a\',\'b\')), label TEXT)' }], [{
      name: 'put', operation: 'execute',
      params: { n: { type: 'integer', max: 5 }, flag: { type: 'boolean' }, kind: { type: 'string', enum: ['b'] }, label: { type: 'string', default: 'fixed' } },
      sql: 'INSERT INTO t VALUES (:n, :flag, :kind, :label)',
    }]);
    expect(outcomes(r)).toEqual({ put: 'ok' });
  });

  it('skips verify actions, and an action with no SQL', async () => {
    const r = await run([NOTES], [{ name: 'check', operation: 'verify', params: {}, sql: 'SELECT 1' }, { name: 'empty', operation: 'execute', params: {} }]);
    expect(outcomes(r)).toEqual({ check: 'skipped', empty: 'skipped' });
    expect(r.ok).toBe(true);
  });
});
