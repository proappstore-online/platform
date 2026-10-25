import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { applySchema } from './project-schema.ts';

const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');

function sqlOf(db: InstanceType<typeof DatabaseSync>) {
  return { exec: (q: string) => { db.exec(q); return { toArray: () => [] }; } } as never;
}

describe('applySchema', () => {
  it('creates the tables and the migrated project columns', () => {
    const db = new DatabaseSync(':memory:');
    applySchema(sqlOf(db));
    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map((t) => t.name);
    for (const t of ['project', 'tickets', 'messages', 'role_configs', 'chat_history', 'activity_log', 'project_files', 'project_memory', 'test_runs', 'test_results', 'cost_ledger']) {
      expect(tables, t).toContain(t);
    }
    const cols = (db.prepare('PRAGMA table_info(project)').all() as { name: string }[]).map((c) => c.name);
    expect(cols).toEqual(expect.arrayContaining(['status', 'last_user_activity', 'cost_month', 'max_run_minutes', 'owner_session_token']));
  });

  it('is idempotent: a second run over an initialised DO keeps its data', () => {
    const db = new DatabaseSync(':memory:');
    applySchema(sqlOf(db));
    db.prepare('INSERT INTO project (id, owner_id, name, slug, created_at) VALUES (?, ?, ?, ?, ?)').run('p', 'o', 'N', 's', 1);
    expect(() => applySchema(sqlOf(db))).not.toThrow();
    expect(db.prepare('SELECT COUNT(*) AS n FROM project').get()).toEqual({ n: 1 });
  });

  it('purges an owner session token an older deploy left in storage', () => {
    const db = new DatabaseSync(':memory:');
    applySchema(sqlOf(db));
    db.prepare('INSERT INTO project (id, owner_id, name, slug, created_at, owner_session_token) VALUES (?, ?, ?, ?, ?, ?)').run('p', 'o', 'N', 's', 1, 'secret');
    applySchema(sqlOf(db));
    expect(db.prepare('SELECT owner_session_token AS t FROM project').get()).toEqual({ t: null });
  });
});
