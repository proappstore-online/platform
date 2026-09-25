import { env, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { MIGRATIONS } from '../../../agent-teams/src/store.ts';
import { freshSlug } from './helpers';

/**
 * #23's "DO init-migration skips across deploys" bug class. ProjectDO applies
 * SCHEMA + the additive MIGRATIONS on first use of an isolate (ensureSchema). A
 * DO whose storage predates a column — created by an older deploy — must gain
 * it on the next request, not fail with "no such column".
 */
describe('ProjectDO schema migrations on real SQLite storage', () => {
  const OLD_SCHEMA = `
    CREATE TABLE IF NOT EXISTS project (
      id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, name TEXT NOT NULL, slug TEXT NOT NULL,
      created_at INTEGER NOT NULL, cost_cap_monthly_usd REAL NOT NULL DEFAULT 50.0,
      cost_spent_monthly_usd REAL NOT NULL DEFAULT 0.0, repo_url TEXT,
      repo_provisioned_at INTEGER, registry_entry_id TEXT, app_idea TEXT
    );
    CREATE TABLE IF NOT EXISTS role_configs (
      role TEXT PRIMARY KEY, runtime TEXT NOT NULL, model TEXT NOT NULL,
      system_prompt_override TEXT, spine_tools TEXT NOT NULL DEFAULT '[]', vendor_tools TEXT NOT NULL DEFAULT '[]'
    );
    CREATE TABLE IF NOT EXISTS activity_log (
      id TEXT PRIMARY KEY, ticket_id TEXT, type TEXT NOT NULL, detail TEXT NOT NULL, created_at INTEGER NOT NULL
    );`;

  const columns = (state: DurableObjectState, table: string) =>
    (state.storage.sql.exec(`PRAGMA table_info(${table})`).toArray() as { name: string }[]).map((c) => c.name);

  it('an object created by an older deploy gains every additive column on its next request', async () => {
    const id = env.PROJECT.idFromName(freshSlug('legacy'));
    const stub = env.PROJECT.get(id);

    // Pre-populate the storage as an older deploy would have left it: base
    // tables without the columns later MIGRATIONS add, and one project row.
    await runInDurableObject(stub, (_instance, state) => {
      state.storage.sql.exec(OLD_SCHEMA);
      state.storage.sql.exec(
        'INSERT INTO project (id, owner_id, name, slug, created_at) VALUES (?, ?, ?, ?, ?)',
        'p1', 'gh:1', 'Legacy', 'legacy', Date.now(),
      );
      expect(columns(state, 'project')).not.toContain('status');
      expect(columns(state, 'role_configs')).not.toContain('persona');
    });

    // Any request runs ensureSchema — SCHEMA (IF NOT EXISTS) then the additive groups.
    const res = await stub.fetch('https://do/project', { headers: { 'X-User-Id': 'gh:1' } });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ownerId: 'gh:1', name: 'Legacy', status: 'paused' });

    await runInDurableObject(stub, (_instance, state) => {
      const project = columns(state, 'project');
      const expected = MIGRATIONS.flat()
        .map((s) => /ALTER TABLE (\w+) ADD COLUMN (\w+)/.exec(s))
        .filter((m): m is RegExpExecArray => !!m);
      expect(expected.length).toBeGreaterThan(5);
      for (const [, table, column] of expected) expect(columns(state, table!), `${table}.${column}`).toContain(column);
      expect(project).toEqual(expect.arrayContaining(['status', 'cost_month', 'repo_synced_sha', 'repo_synced_at']));
      // Every base table exists too.
      expect(state.storage.sql.exec("SELECT name FROM sqlite_master WHERE type = 'table'").toArray().map((r) => (r as { name: string }).name))
        .toEqual(expect.arrayContaining(['tickets', 'messages', 'chat_history', 'project_files', 'project_memory', 'cost_ledger']));
    });
  });

  it('applying the migrations twice is a no-op (each additive group is best-effort)', async () => {
    const stub = env.PROJECT.get(env.PROJECT.idFromName(freshSlug('twice')));
    expect((await stub.fetch('https://do/project', { headers: { 'X-User-Id': 'gh:1' } })).status).toBe(404); // not initialised, but the schema ran
    await runInDurableObject(stub, (_instance, state) => {
      const before = columns(state, 'project');
      for (const group of MIGRATIONS) {
        try { for (const s of group) state.storage.sql.exec(s); } catch { /* already applied */ }
      }
      expect(columns(state, 'project')).toEqual(before);
    });
  });
});
