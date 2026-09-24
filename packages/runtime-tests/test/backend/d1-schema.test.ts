import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { mockNetwork, resetTables } from './helpers';

// What a mocked route test can never notice: the migration set, applied to a real
// D1, produces the tables and columns the code binds to.
beforeEach(async () => { mockNetwork(); await resetTables(); });

describe('root migrations against a real D1', () => {
  it('creates every table the hot paths depend on', async () => {
    const rows = await env.DB.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all<{ name: string }>();
    const names = new Set((rows.results ?? []).map((r) => r.name));
    for (const t of ['users', 'apps', 'team_members', 'app_roles', 'app_tools', 'app_endpoint_audit', 'app_logs', 'app_log_usage', 'user_app_tokens', 'oidc_session_grants', 'oidc_session_mints', 'deploy_audit', 'migration_audit']) {
      expect(names.has(t), `table ${t}`).toBe(true);
    }
  });

  it('app_tools carries the console-endpoint columns (#155) with the documented default', async () => {
    const cols = await env.DB.prepare('PRAGMA table_info(app_tools)').all<{ name: string; dflt_value: string | null; notnull: number }>();
    const byName = new Map((cols.results ?? []).map((c) => [c.name, c]));
    expect(byName.get('source')).toMatchObject({ notnull: 1, dflt_value: "'code'" });
    expect(byName.has('config') && byName.has('updated_by')).toBe(true);
    await env.DB.prepare("INSERT INTO app_tools (app_id, name, manifest, created_at, updated_at) VALUES ('probe', 'list_x', '{}', 1, 1)").run();
    const row = await env.DB.prepare("SELECT source FROM app_tools WHERE app_id = 'probe'").first<{ source: string }>();
    expect(row?.source).toBe('code');
  });

  it('D1 enforces the primary keys and unique constraints the routes rely on', async () => {
    await env.DB.prepare("INSERT INTO user_app_tokens (token_hash, token_id, user_id, app_id, scopes, created_at, expires_at) VALUES ('h1', 'id1', 'gh:1', 'a', '{}', 1, 2)").run();
    await expect(env.DB.prepare("INSERT INTO user_app_tokens (token_hash, token_id, user_id, app_id, scopes, created_at, expires_at) VALUES ('h2', 'id1', 'gh:1', 'a', '{}', 1, 2)").run()).rejects.toThrow(/UNIQUE/);
    await expect(env.DB.prepare("INSERT INTO app_tools (app_id, name, manifest, created_at, updated_at) VALUES ('probe', 'dup', '{}', 1, 1), ('probe', 'dup', '{}', 1, 1)").run()).rejects.toThrow(/UNIQUE|PRIMARY/);
  });

  it('a batch is one transaction: a failing statement rolls the earlier ones back', async () => {
    await expect(env.DB.batch([
      env.DB.prepare("INSERT INTO app_log_usage (app_id, day, count) VALUES ('tx', '2026-01-01', 1)"),
      env.DB.prepare("INSERT INTO app_log_usage (app_id, day, count) VALUES ('tx', '2026-01-01', 2)"), // PK collision
    ])).rejects.toThrow();
    const row = await env.DB.prepare("SELECT count FROM app_log_usage WHERE app_id = 'tx'").first();
    expect(row).toBeNull();
  });
});
