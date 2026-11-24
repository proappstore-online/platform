import { readFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import { APP_ID_COLUMNS } from './app-rename-columns.js';

const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');
type Db = InstanceType<typeof DatabaseSync>;
const migrations = new URL('../../../../migrations/', import.meta.url);

// A column whose name could hold an app ID. Anchored to name endings rather than
// 0150's five exact names, which missed app_pags_bindings.repo and submissions.repo_url.
const APP_ID_SHAPED = /(^|_)(app_id|slug|project_slug|repo|repository|full_name|repo_url|pages_project|prefix|storage_key)$/;

function schema(): Db {
  const db = new DatabaseSync(':memory:');
  for (const file of readdirSync(migrations).filter((name) => name.endsWith('.sql')).sort()) db.exec(readFileSync(new URL(file, migrations), 'utf8'));
  return db;
}

function columns(db: Db): string[] {
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all() as { name: string }[];
  return tables.flatMap(({ name }) => (db.prepare(`PRAGMA table_info("${name}")`).all() as { name: string }[]).map((c) => `${name}.${c.name}`));
}

/** Tables whose every row is immutable: a BEFORE UPDATE trigger with no WHEN and no OF that aborts. */
function appendOnlyTables(db: Db): Set<string> {
  const triggers = db.prepare("SELECT tbl_name, sql FROM sqlite_master WHERE type = 'trigger'").all() as { tbl_name: string; sql: string }[];
  return new Set(triggers
    .filter(({ sql }) => /\bBEFORE\s+UPDATE\s+ON\b/i.test(sql) && !/\bWHEN\b/i.test(sql) && /RAISE\s*\(\s*ABORT/i.test(sql))
    .map(({ tbl_name }) => tbl_name));
}

/** Every reason the classification does not cover `db`'s schema; empty when it is complete. */
function problems(db: Db, classification: typeof APP_ID_COLUMNS = APP_ID_COLUMNS): string[] {
  const all = columns(db);
  const listed = classification.map((c) => `${c.table}.${c.column}`);
  const appendOnly = appendOnlyTables(db);
  return [
    ...all.filter((c) => c === 'apps.id' || APP_ID_SHAPED.test(c.split('.')[1]!))
      .filter((c) => listed.filter((l) => l === c).length !== 1)
      .map((c) => `unclassified or listed twice: ${c}`),
    ...listed.filter((l) => !all.includes(l)).map((l) => `no such column: ${l}`),
    ...classification.filter((c) => appendOnly.has(c.table) && c.kind !== 'keep').map((c) => `append-only, must be keep: ${c.table}.${c.column}`),
    ...classification.filter((c) => (c.kind === 'keep') !== Boolean(c.reason)).map((c) => `a reason belongs on keep only: ${c.table}.${c.column}`),
    ...classification.filter((c) => (c.kind === 'prefix') !== Boolean(c.segment)).map((c) => `a segment belongs on prefix only: ${c.table}.${c.column}`),
  ];
}

describe('app-ID column classification (#686 Phase 2)', () => {
  it('classifies every column of the current schema that could hold an app ID, exactly once', () => {
    const db = schema();
    try { expect(problems(db)).toEqual([]); } finally { db.close(); }
  });

  it('fails on a new unclassified app-ID column', () => {
    const db = schema();
    try {
      db.exec('CREATE TABLE app_widgets (id INTEGER PRIMARY KEY, foo_app_id TEXT NOT NULL)');
      expect(problems(db)).toEqual(['unclassified or listed twice: app_widgets.foo_app_id']);
    } finally { db.close(); }
  });

  it('fails when an append-only table is classified as anything but keep, and finds all six of them', () => {
    const db = schema();
    try {
      expect([...appendOnlyTables(db)].sort()).toEqual(['account_audit_events', 'app_ownership_audit', 'app_promoter_events', 'app_referral_events', 'project_contribution_events', 'test_principal_events']);
      const rewritten = APP_ID_COLUMNS.map((c) => (c.table === 'app_promoter_events' ? { table: c.table, column: c.column, kind: 'id' as const } : c));
      expect(problems(db, rewritten)).toEqual(['append-only, must be keep: app_promoter_events.app_id']);
    } finally { db.close(); }
  });

  it('carries the two columns 0150 missed', () => {
    expect(APP_ID_COLUMNS).toEqual(expect.arrayContaining([
      { table: 'app_pags_bindings', column: 'repo', kind: 'repository' },
      { table: 'submissions', column: 'repo_url', kind: 'url' },
    ]));
  });
});
