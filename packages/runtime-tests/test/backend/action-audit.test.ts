import { SELF, env, fetchMock } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BASE, json, seedApp, seedUser, session, mockNetwork, resetTables } from './helpers';

// #232 (part of #228): every successful call of an action gated by
// `auth.app_roles` leaves exactly one app_action_audit row — who, app, action,
// role, when — and nothing from the request. Real D1; the data-worker hop is
// intercepted.

afterEach(() => fetchMock.assertNoPendingInterceptors());
beforeEach(async () => {
  mockNetwork();
  await resetTables();
  await env.DB.prepare('DELETE FROM app_action_audit').run();
});

const SQL = 'SELECT id, note FROM cases WHERE owner_id = :__user_id AND id = :case_id LIMIT 50';
const tool = (name: string, auth?: Record<string, unknown>) => ({
  name,
  description: name,
  operation: 'query',
  sql: SQL,
  params: { case_id: { type: 'string' } },
  requires_auth: true,
  ...(auth ? { auth } : {}),
});

async function registerTools(...tools: ReturnType<typeof tool>[]): Promise<void> {
  const now = Date.now();
  for (const t of tools) {
    await env.DB.prepare("INSERT INTO app_tools (app_id, name, manifest, created_at, updated_at, source) VALUES ('ops', ?, ?, ?, ?, 'code')")
      .bind(t.name, JSON.stringify(t), now, now).run();
  }
}

async function grant(userId: string, role: string): Promise<void> {
  await env.DB.prepare('INSERT INTO app_roles (app_id, user_id, role_name, granted_by) VALUES (?, ?, ?, NULL)').bind('ops', userId, role).run();
}

const dataWorker = () => fetchMock.get(`https://pas-data-ops.${env.DATA_WORKER_HOST}`);
const call = async (name: string, token: string) => SELF.fetch(`${BASE}/v1/apps/ops/actions/${name}`, json('POST', { params: { case_id: 'c-secret-42' } }, token));
const auditRows = async () =>
  (await env.DB.prepare('SELECT * FROM app_action_audit ORDER BY id').all<Record<string, unknown>>()).results ?? [];

/** operation-log writes in the background (waitUntil); wait for its row. */
async function eventually<T>(read: () => Promise<T | null>): Promise<T | null> {
  for (let i = 0; i < 50; i++) {
    const v = await read();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 20));
  }
  return null;
}

describe('success audit of role-gated actions (#232)', () => {
  beforeEach(async () => {
    await seedUser('gh:1', 'owner');
    await seedUser('gh:2', 'op');
    await seedApp('ops', 'gh:1');
  });

  it('a role-gated action that succeeds writes exactly one row: who, app, action, role, when — no params', async () => {
    await registerTools(tool('lookup_case', { app_roles: ['admin', 'operator'] }));
    await grant('gh:2', 'operator');
    dataWorker().intercept({ path: '/query', method: 'POST' }).reply(200, { rows: [{ id: 'c-secret-42', note: 'id document' }], meta: {} });

    const before = Date.now();
    const res = await call('lookup_case', await session('gh:2'));
    expect(res.status).toBe(200);
    await res.text();

    const rows = await auditRows();
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row).toMatchObject({ app_id: 'ops', action_name: 'lookup_case', actor_id: 'gh:2', role_name: 'operator', status: 200 });
    expect(row.created_at as number).toBeGreaterThanOrEqual(before);
    // Least privilege: nothing from the request or the result is kept.
    expect(Object.keys(row).sort()).toEqual(['action_name', 'actor_id', 'app_id', 'created_at', 'id', 'role_name', 'status']);
    expect(JSON.stringify(row)).not.toContain('c-secret-42');
    expect(JSON.stringify(row)).not.toContain('id document');
  });

  it('an action with no app-role gate writes no row', async () => {
    await registerTools(tool('list_mine'), tool('platform_only', { platform_roles: ['user'] }));
    for (const name of ['list_mine', 'platform_only']) {
      dataWorker().intercept({ path: '/query', method: 'POST' }).reply(200, { rows: [], meta: {} });
      const res = await call(name, await session('gh:2'));
      expect(res.status, name).toBe(200);
      await res.text();
    }
    expect(await auditRows()).toHaveLength(0);
  });

  it('a refused caller writes no audit row, and the failure is still logged to app_logs as before', async () => {
    await registerTools(tool('lookup_case', { app_roles: ['operator'] }));
    const res = await call('lookup_case', await session('gh:2'));
    expect(res.status).toBe(403);
    await res.text();

    const logged = await eventually(() =>
      env.DB.prepare("SELECT user_id, category, level, data FROM app_logs WHERE app_id = 'ops' AND source = 'server'").first<{ user_id: string; category: string; level: string; data: string }>(),
    );
    expect(logged).toMatchObject({ user_id: 'gh:2', category: 'action', level: 'warn' });
    expect(JSON.parse(logged!.data)).toMatchObject({ operation: 'lookup_case', status: 403 });
    expect(await auditRows()).toHaveLength(0);
  });

  it('a granted call whose data worker fails writes no audit row', async () => {
    await registerTools(tool('lookup_case', { app_roles: ['operator'] }));
    await grant('gh:2', 'operator');
    dataWorker().intercept({ path: '/query', method: 'POST' }).reply(500, { error: 'boom' });
    const res = await call('lookup_case', await session('gh:2'));
    expect(res.status).toBe(500);
    await res.text();
    expect(await auditRows()).toHaveLength(0);
  });
});
