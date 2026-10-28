import { describe, expect, it } from 'vitest';
import { writesReservedTable } from './reserved-tables.js';

// #508: an app reads `_pas_*` tables and never writes them.

describe('writesReservedTable', () => {
  it('lets an app read and JOIN the entitlement table', () => {
    for (const sql of [
      'SELECT status FROM _pas_entitlements WHERE product = :p AND subject = :s',
      'SELECT o.id, e.status FROM orders o JOIN _pas_entitlements e ON e.subject = o.child_id WHERE e.status IN (\'active\', \'grace\')',
      'WITH live AS (SELECT subject FROM _pas_entitlements WHERE status = \'active\') SELECT * FROM live',
      'SELECT replace(subject, \'-\', \'\') FROM _pas_entitlements',
      'SELECT "subject" FROM "_pas_entitlements"',
    ]) expect(writesReservedTable(sql), sql).toBeNull();
  });

  it('refuses every way of writing one', () => {
    for (const sql of [
      "INSERT INTO _pas_entitlements (product, subject, status) VALUES ('t', 'x', 'active')",
      "INSERT OR REPLACE INTO _pas_entitlements (product, subject, status) VALUES ('t', 'x', 'active')",
      "UPDATE _pas_entitlements SET status = 'active'",
      'DELETE FROM _pas_entitlements',
      'REPLACE INTO _pas_entitlements (product, subject) VALUES (1, 2)',
      'DROP TABLE _pas_entitlements',
      'ALTER TABLE _pas_entitlements ADD COLUMN x TEXT',
      'CREATE TABLE _pas_other (x TEXT)',
      'CREATE INDEX i ON _pas_entitlements (subject)',
      "CREATE TRIGGER t AFTER INSERT ON orders BEGIN UPDATE _pas_entitlements SET status = 'active'; END",
      'WITH x AS (SELECT 1) INSERT INTO _pas_entitlements (product, subject) SELECT 1, 2 FROM x',
      "WITH x AS (SELECT 1) UPDATE _pas_entitlements SET status = 'active'",
      'ATTACH DATABASE x AS _pas_other',
      'INSERT INTO "_pas_entitlements" (product) VALUES (1)',
      'INSERT INTO [_pas_entitlements] (product) VALUES (1)',
      'INSERT INTO `_PAS_Entitlements` (product) VALUES (1)',
      'INSERT INTO main._pas_entitlements (product) VALUES (1)',
    ]) expect(writesReservedTable(sql), sql).toMatch(/_pas_/i);
  });

  it('finds a write hidden after a harmless statement', () => {
    expect(writesReservedTable("SELECT 1; DELETE FROM _pas_entitlements;")).toBe('_pas_entitlements');
    expect(writesReservedTable("CREATE TABLE ok (x TEXT); UPDATE _pas_entitlements SET status = 'x'")).toBe('_pas_entitlements');
  });

  it('does not read a name in a string or a comment as a name', () => {
    expect(writesReservedTable("INSERT INTO notes (body) VALUES ('see _pas_entitlements')")).toBeNull();
    expect(writesReservedTable('-- _pas_entitlements\nUPDATE notes SET body = 1')).toBeNull();
    expect(writesReservedTable('/* DELETE FROM _pas_entitlements */ SELECT 1')).toBeNull();
  });

  it('leaves tables with no reserved prefix alone, including look-alikes', () => {
    for (const sql of ['INSERT INTO pas_entitlements (x) VALUES (1)', 'DELETE FROM my_pas_table', 'UPDATE entitlements SET x = 1', 'INSERT INTO _pasx (x) VALUES (1)']) {
      expect(writesReservedTable(sql), sql).toBeNull();
    }
  });
});
