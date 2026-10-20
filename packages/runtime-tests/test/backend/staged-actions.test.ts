import { SELF, env as providedEnv, fetchMock } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Env } from '../../../backend/src/types';
import { disableAppWorker } from '../../../backend/src/lib/app-worker-host';
import { BASE, json, mockNetwork, resetTables, seedApp, seedUser, session } from './helpers';

const env = providedEnv as unknown as Env;

// #428: registered actions are staged until the app goes live, on real D1 and the
// real migrations. Only the app's data worker is intercepted.
//
//   gh:admin creates 'club' (and is a platform admin)   gh:2 is a signed-in user

const listMine = {
  name: 'list_mine', description: 'My notes', operation: 'query', requires_auth: true, params: {},
  sql: 'SELECT id, body FROM notes WHERE user_id = :__user_id LIMIT 50',
};
const addNote = {
  name: 'add_note', description: 'Add a note', operation: 'execute', requires_auth: true, params: { body: { type: 'string' } },
  sql: 'INSERT INTO notes (user_id, body) VALUES (:__user_id, :body)',
};
const owner = () => session('gh:admin', { roles: ['user', 'admin'] });
const dataWorker = () => fetchMock.get(`https://pas-data-club.${env.DATA_WORKER_HOST}`);

async function register(tools: Record<string, unknown>[]): Promise<{ status: number; body: { staged?: string[]; warnings?: string[]; error?: string } }> {
  dataWorker().intercept({ path: '/validate', method: 'POST' })
    .reply(200, (req) => ({ results: (JSON.parse(String(req.body)) as { statements: { id: string }[] }).statements.map((st) => ({ id: st.id, ok: true })) }));
  const res = await SELF.fetch(`${BASE}/v1/apps/club/tools`, json('PUT', { tools }, await owner()));
  return { status: res.status, body: await res.json() };
}
async function call(name: string, token: string | undefined, body: Record<string, unknown> = { params: {} }): Promise<Response> {
  return SELF.fetch(`${BASE}/v1/apps/club/actions/${name}`, json('POST', body, token));
}
/** The data worker answers one real query/execute. */
function runs(endpoint: 'query' | 'execute'): void {
  dataWorker().intercept({ path: `/${endpoint}`, method: 'POST' }).reply(200, endpoint === 'query' ? { rows: [{ id: 1 }] } : { meta: { changes: 1 } });
}
const states = async () => Object.fromEntries(((await env.DB.prepare("SELECT name, state FROM app_tools WHERE app_id = 'club' ORDER BY name").all<{ name: string; state: string }>()).results ?? []).map((r) => [r.name, r.state]));

afterEach(() => fetchMock.assertNoPendingInterceptors());
beforeEach(async () => {
  mockNetwork();
  for (const r of (await env.DB.prepare('SELECT app_id FROM app_workers').all<{ app_id: string }>()).results ?? []) await disableAppWorker(env, r.app_id);
  await resetTables();
  await env.DB.prepare('UPDATE app_worker_platform SET open = 1, closed_reason = NULL, closed_at = NULL').run();
  await seedUser('gh:admin', 'admin');
  await seedUser('gh:2', 'someone');
  await env.DB.prepare('DELETE FROM app_go_live').run();
  await seedApp('club', 'gh:admin');
});

describe('staged actions (#428)', () => {
  it('migration 0108: a row written without a state is live', async () => {
    await env.DB.prepare("INSERT INTO app_tools (app_id, name, manifest, created_at, updated_at, source) VALUES ('club', 'list_mine', ?, 1, 1, 'code')")
      .bind(JSON.stringify(listMine)).run();
    expect(await states()).toEqual({ list_mine: 'live' });
  });

  it("a new app's actions register staged: refused to users, app listing hides them, the owner can call them", async () => {
    const reg = await register([listMine]);
    expect(reg.status).toBe(200);
    expect(reg.body.staged).toEqual(['list_mine']);
    expect(reg.body.warnings).toEqual(expect.arrayContaining([expect.stringMatching(/^1 action\(s\) are staged/)]));
    expect(await states()).toEqual({ list_mine: 'staged' });

    const refused = await call('list_mine', await session('gh:2'));
    expect(refused.status).toBe(403);
    expect(await refused.json()).toMatchObject({ error: expect.stringMatching(/action is staged/) });
    expect((await call('list_mine', undefined)).status).toBe(403);

    const anon = (await (await SELF.fetch(`${BASE}/v1/apps/club/tools`)).json()) as { tools: unknown[] };
    expect(anon.tools).toEqual([]);
    const team = (await (await SELF.fetch(`${BASE}/v1/apps/club/tools`, json('GET', undefined, await owner()))).json()) as { tools: { name: string; state: string }[] };
    expect(team.tools).toEqual([expect.objectContaining({ name: 'list_mine', state: 'staged' })]);

    runs('query');
    const own = await call('list_mine', await owner());
    expect(own.status).toBe(200);
  });

  it('dry run: the owner validates, authorizes and binds without running; nobody else may', async () => {
    await register([listMine, addNote]);
    // No data-worker interceptor: a request to it would fail the test.
    const q = await call('list_mine', await owner(), { params: {}, dry_run: true });
    expect(q.status).toBe(200);
    expect(await q.json()).toEqual({ dry_run: true, state: 'staged', rows: [] });
    const w = await call('add_note', await owner(), { params: { body: 'hi' }, dry_run: true });
    expect(await w.json()).toEqual({ dry_run: true, state: 'staged', changes: 0 });
    // Binding still runs: a missing required param is the same 400 a real call gets.
    expect((await call('add_note', await owner(), { params: {}, dry_run: true })).status).toBe(400);
    expect((await call('list_mine', await owner(), { params: {}, dry_run: 'yes' })).status).toBe(400);

    await SELF.fetch(`${BASE}/v1/apps/club/tools/promote`, json('POST', {}, await owner()));
    const user = await call('list_mine', await session('gh:2'), { params: {}, dry_run: true });
    expect(user.status).toBe(403);
    expect(await user.json()).toMatchObject({ error: expect.stringMatching(/dry_run is for the app's owner and team/) });
  });

  it('promote makes named (or all) staged actions callable; only the owner may promote', async () => {
    await register([listMine, addNote]);
    expect((await SELF.fetch(`${BASE}/v1/apps/club/tools/promote`, json('POST', {}, await session('gh:2')))).status).toBe(403);
    expect((await SELF.fetch(`${BASE}/v1/apps/club/tools/promote`, json('POST', { names: 'list_mine' }, await owner()))).status).toBe(400);

    const one = await SELF.fetch(`${BASE}/v1/apps/club/tools/promote`, json('POST', { names: ['list_mine', 'nope'] }, await owner()));
    expect(await one.json()).toEqual({ ok: true, promoted: ['list_mine'], not_staged: ['nope'], staged_remaining: 1 });
    expect(await states()).toEqual({ add_note: 'staged', list_mine: 'live' });
    runs('query');
    expect((await call('list_mine', await session('gh:2'))).status).toBe(200);
    expect((await call('add_note', await session('gh:2'), { params: { body: 'x' } })).status).toBe(403);

    const all = await SELF.fetch(`${BASE}/v1/apps/club/tools/promote`, json('POST', {}, await owner()));
    expect(await all.json()).toMatchObject({ promoted: ['add_note'], staged_remaining: 0 });
  });

  it('a live app registers new and changed actions live; unchanged ones keep their state', async () => {
    await register([listMine]);
    await SELF.fetch(`${BASE}/v1/apps/club/tools/promote`, json('POST', {}, await owner()));
    const next = await register([{ ...listMine, description: 'reworded' }, addNote]);
    expect(next.body.staged).toEqual([]);
    expect(await states()).toEqual({ add_note: 'live', list_mine: 'live' });
  });

  it('a changed action of a not-yet-live app stays staged; an unchanged one keeps its state', async () => {
    await register([listMine, addNote]);
    await SELF.fetch(`${BASE}/v1/apps/club/tools/promote`, json('POST', { names: ['list_mine'] }, await owner()));
    // The app is live now (it serves a live action), so a change registers live.
    await register([{ ...listMine, sql: 'SELECT id FROM notes WHERE user_id = :__user_id LIMIT 10' }, addNote]);
    expect(await states()).toEqual({ add_note: 'staged', list_mine: 'live' });
  });

  // #429: "live" was derived from the current rows, so clearing a live app's tools
  // (DELETE …/tools, or a deploy without mcp.json) made its next deploy all staged.
  it('a live app stays live after its tools are cleared: the next deploy registers live (migration 0109)', async () => {
    await register([listMine]);
    await SELF.fetch(`${BASE}/v1/apps/club/tools/promote`, json('POST', {}, await owner()));
    expect(await env.DB.prepare("SELECT went_live_by FROM app_go_live WHERE app_id = 'club'").first()).toEqual({ went_live_by: 'gh:admin' });
    expect((await SELF.fetch(`${BASE}/v1/apps/club/tools`, json('DELETE', undefined, await owner()))).status).toBe(200);
    expect(await states()).toEqual({});
    const next = await register([listMine, addNote]);
    expect(next.body.staged).toEqual([]);
    expect(await states()).toEqual({ add_note: 'live', list_mine: 'live' });
  });

  it('enabling the app worker is going live: staged actions are promoted, later ones register live', async () => {
    await register([listMine]);
    const enabled = await SELF.fetch(`${BASE}/v1/admin/apps/club/worker-enabled`, json('PUT', { enabled: true }, await owner()));
    expect(enabled.status).toBe(200);
    expect(await enabled.json()).toMatchObject({ enabled: true, promoted: 1 });
    expect(await env.DB.prepare("SELECT 1 AS live FROM app_go_live WHERE app_id = 'club'").first()).toEqual({ live: 1 });
    expect(await states()).toEqual({ list_mine: 'live' });
    const next = await register([listMine, addNote]);
    expect(next.body.staged).toEqual([]);
  });
});
