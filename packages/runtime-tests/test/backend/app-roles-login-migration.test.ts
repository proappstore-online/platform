import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { mockNetwork, resetTables, seedUser } from './helpers';

/**
 * Migration 0066 (#272): legacy app_roles rows keyed by a GitHub login are
 * rewritten to the holder's `gh:` id when exactly one GitHub user has that
 * login; anything else is left for the login alias. setup.ts has already run
 * every migration on an empty table, so this re-runs 0066's statements against
 * seeded legacy rows — which also proves a second run is harmless.
 */
const MIGRATION = env.TEST_MIGRATIONS.find((m) => m.name.startsWith('0066_'));

async function runMigration(): Promise<void> {
  for (const q of MIGRATION!.queries) await env.DB.prepare(q).run();
}

const roles = async () =>
  (await env.DB.prepare('SELECT app_id, user_id, role_name, granted_by FROM app_roles ORDER BY app_id, user_id, role_name').all()).results;

beforeEach(async () => {
  mockNetwork();
  await resetTables();
});

describe('migration 0066: login-keyed app_roles → gh: ids', () => {
  it('exists and is the file deploy-backend.yml will apply', () => {
    expect(MIGRATION?.name).toBe('0066_app_roles_login_to_id.sql');
  });

  it('rewrites a uniquely matched login, merges a duplicate, and leaves the rest alone', async () => {
    await seedUser('gh:1', 'alice');
    await seedUser('gh:2', 'bob');
    // Two GitHub accounts recorded with the same login (one renamed since): ambiguous.
    await seedUser('gh:3', 'twin');
    await seedUser('gh:4', 'twin');
    // A non-GitHub account whose display name is a login: never a match.
    await env.DB.prepare("INSERT INTO users (id, provider, provider_id, login, created_at, last_login_at) VALUES ('cred:9', 'credential', 'cred:9', 'carol', 0, 0)").run();
    await env.DB.prepare(`INSERT INTO app_roles (app_id, user_id, role_name, granted_by, granted_at) VALUES
      ('diary', 'alice', 'editor', 'gh:100', 5),
      ('diary', 'bob', 'viewer', 'gh:100', 6),
      ('diary', 'gh:2', 'viewer', 'gh:100', 7),
      ('diary', 'twin', 'viewer', 'gh:100', 8),
      ('diary', 'carol', 'viewer', 'gh:100', 9),
      ('diary', 'ghost', 'viewer', 'gh:100', 10),
      ('diary', 'gh:1', 'member', NULL, 11)`).run();

    await runMigration();
    const after = await roles();
    expect(after).toEqual([
      { app_id: 'diary', user_id: 'carol', role_name: 'viewer', granted_by: 'gh:100' },
      { app_id: 'diary', user_id: 'gh:1', role_name: 'editor', granted_by: 'gh:100' },
      { app_id: 'diary', user_id: 'gh:1', role_name: 'member', granted_by: null },
      { app_id: 'diary', user_id: 'gh:2', role_name: 'viewer', granted_by: 'gh:100' },
      { app_id: 'diary', user_id: 'ghost', role_name: 'viewer', granted_by: 'gh:100' },
      { app_id: 'diary', user_id: 'twin', role_name: 'viewer', granted_by: 'gh:100' },
    ]);
    const kept = await env.DB.prepare("SELECT granted_at FROM app_roles WHERE user_id = 'gh:1' AND role_name = 'editor'").first<{ granted_at: number }>();
    expect(kept?.granted_at).toBe(5);

    await runMigration();
    expect(await roles()).toEqual(after);
  });
});
