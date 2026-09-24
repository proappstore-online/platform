import { SELF, env, fetchMock } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BASE, json, seedApp, seedUser, session, mockNetwork, resetTables } from './helpers';

afterEach(() => fetchMock.assertNoPendingInterceptors());

beforeEach(async () => { mockNetwork(); await resetTables(); });

describe('sessions and authorization against real D1', () => {
  it('happy path: a minted session resolves to its user row', async () => {
    await seedUser('gh:1', 'alice');
    const res = await SELF.fetch(`${BASE}/v1/auth/me`, json('GET', undefined, await session('gh:1', { login: 'alice' })));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ id: 'gh:1', login: 'alice' });
  });

  it('no session → 401; a tampered session → 401', async () => {
    expect((await SELF.fetch(`${BASE}/v1/auth/me`)).status).toBe(401);
    const tok = await session('gh:1');
    expect((await SELF.fetch(`${BASE}/v1/auth/me`, json('GET', undefined, tok.slice(0, -2) + 'xx'))).status).toBe(401);
  });

  it('forbidden path: a non-owner cannot register tools; the owner can, and the row lands in D1 with source = code', async () => {
    await seedUser('gh:1'); await seedUser('gh:2');
    await seedApp('demo', 'gh:1');
    const tools = [{ name: 'list_mine', description: 'Mine', operation: 'query', sql: 'SELECT id FROM items WHERE owner_id = :__user_id LIMIT 50', params: {}, requires_auth: true }];
    const denied = await SELF.fetch(`${BASE}/v1/apps/demo/tools`, json('PUT', { tools }, await session('gh:2')));
    expect(denied.status).toBe(403);
    // Registration validates the SQL against the app's data worker (#33) at
    // https://pas-data-<app>.<DATA_WORKER_HOST>/validate — intercepted here,
    // which also pins the outbound URL shape (#153).
    fetchMock.get(`https://pas-data-demo.${env.DATA_WORKER_HOST}`).intercept({ path: '/validate', method: 'POST' }).reply(200, { results: [{ id: 'list_mine#0', ok: true }] });
    const ok = await SELF.fetch(`${BASE}/v1/apps/demo/tools`, json('PUT', { tools }, await session('gh:1')));
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ ok: true, registered: 1 });
    const row = await env.DB.prepare("SELECT name, source FROM app_tools WHERE app_id = 'demo'").first<{ name: string; source: string }>();
    expect(row).toEqual({ name: 'list_mine', source: 'code' });
    // The public listing (no session) reads the same D1 row, allowlisted.
    const listing = await SELF.fetch(`${BASE}/v1/apps/demo/tools`);
    const body = (await listing.json()) as { tools: { name: string; source: string; sql?: string }[] };
    expect(body.tools).toEqual([expect.objectContaining({ name: 'list_mine', source: 'code' })]);
    expect(body.tools[0]!.sql).toBeUndefined();
  });

  it('an app role read from D1 gates an action at execution time', async () => {
    await seedUser('gh:1'); await seedUser('gh:3', 'carol');
    await seedApp('demo', 'gh:1');
    await env.DB.prepare("INSERT INTO app_tools (app_id, name, manifest, created_at, updated_at) VALUES ('demo', 'gated', ?, 1, 1)")
      .bind(JSON.stringify({ name: 'gated', description: 'x', operation: 'query', sql: 'SELECT 1 AS one WHERE :__user_id = :__user_id LIMIT 1', params: {}, requires_auth: true, auth: { app_roles: ['manager'] } })).run();
    const tok = await session('gh:3', { login: 'carol', roles: ['user'] });
    const before = await SELF.fetch(`${BASE}/v1/apps/demo/actions/gated`, json('POST', { params: {} }, tok));
    expect(before.status).toBe(403);
    await env.DB.prepare("INSERT INTO app_roles (app_id, user_id, role_name, granted_by) VALUES ('demo', 'carol', 'manager', 'gh:1')").run();
    fetchMock.get(`https://pas-data-demo.${env.DATA_WORKER_HOST}`).intercept({ path: '/query', method: 'POST' }).reply(200, { rows: [{ one: 1 }], meta: {} });
    const after = await SELF.fetch(`${BASE}/v1/apps/demo/actions/gated`, json('POST', { params: {} }, tok));
    expect(after.status).toBe(200);
    expect(await after.json()).toEqual({ rows: [{ one: 1 }], meta: {} });
  });
});
