import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

/**
 * Migrations 0113/0114 (#432/#434) on real D1: the audit trail is append-only,
 * legacy (#146) grants keep NULL principal bindings, and the lookup indexes exist.
 * setup.ts has already applied every migration to an empty database.
 */
describe('test principal schema', () => {
  const seedPrincipal = () =>
    env.DB.batch([
      env.DB.prepare("INSERT INTO test_principals (id, slug, user_id, status, created_by, created_at) VALUES ('tp_m', 'mig', 'test:mig', 'active', 'gh:1', 1)"),
      env.DB.prepare("INSERT INTO test_principal_events (principal_id, action, actor, detail, at, request_id, reason) VALUES ('tp_m', 'principal.create', 'gh:1', '{}', 1, 'req-1', 'why')"),
    ]);

  it('enforces unique slugs and user ids', async () => {
    await seedPrincipal();
    await expect(env.DB.prepare("INSERT INTO test_principals (id, slug, user_id, status, created_by, created_at) VALUES ('tp_x', 'mig', 'test:other', 'active', 'gh:1', 2)").run()).rejects.toThrow();
    await expect(env.DB.prepare("INSERT INTO test_principals (id, slug, user_id, status, created_by, created_at) VALUES ('tp_y', 'other', 'test:mig', 'active', 'gh:1', 2)").run()).rejects.toThrow();
  });

  it('keeps audit events append-only and stores request id and reason', async () => {
    await seedPrincipal().catch(() => undefined);
    const row = await env.DB.prepare("SELECT request_id, reason FROM test_principal_events WHERE principal_id = 'tp_m' LIMIT 1").first();
    expect(row).toEqual({ request_id: 'req-1', reason: 'why' });
    await expect(env.DB.prepare("UPDATE test_principal_events SET actor = 'evil'").run()).rejects.toThrow(/append-only/);
    await expect(env.DB.prepare('DELETE FROM test_principal_events').run()).rejects.toThrow(/append-only/);
  });

  it('leaves legacy #146 grants unbound and un-expanded', async () => {
    await env.DB.prepare("INSERT INTO oidc_session_grants (id, repository, workflow, ref, user_id, created_by, created_at) VALUES ('legacy', 'proappstore-online/x', NULL, 'refs/heads/main', 'gh:42', 'gh:1', 1)").run();
    const g = await env.DB.prepare("SELECT principal_id, environment, expires_at, session_ttl_seconds, scope FROM oidc_session_grants WHERE id = 'legacy'").first();
    expect(g).toEqual({ principal_id: null, environment: null, expires_at: null, session_ttl_seconds: null, scope: null });
  });

  it('indexes principal, grant and event lookups', async () => {
    const names = ((await env.DB.prepare("SELECT name FROM sqlite_master WHERE type = 'index'").all()).results as { name: string }[]).map((r) => r.name);
    expect(names).toEqual(expect.arrayContaining(['idx_test_principals_created', 'idx_oidc_session_grants_principal', 'idx_test_principal_events_principal', 'idx_test_principal_events_grant']));
  });
});
