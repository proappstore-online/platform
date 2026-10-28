import { SELF, env as providedEnv, fetchMock } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Env } from '../../../backend/src/types';
import { disableAppWorker } from '../../../backend/src/lib/app-worker-host';
import { BASE, mockNetwork, resetTables, seedApp, seedUser, session } from './helpers';

const env = providedEnv as unknown as Env;

// #500 on real D1 and the real migrations: an action marked owner_ui_only refuses a call the MCP
// server makes for an assistant, and still runs for the owner's own UI session. Only the app's data
// worker is intercepted.

const listNotes = {
  name: 'list_notes', description: 'List notes', operation: 'query', requires_auth: true, params: {},
  sql: 'SELECT id, body FROM notes WHERE user_id = :__user_id LIMIT 50',
};
const postNote = {
  name: 'post_note', description: 'Post a note for good', operation: 'execute', requires_auth: true, params: { body: { type: 'string' } },
  sql: 'INSERT INTO notes (user_id, body) VALUES (:__user_id, :body)', owner_ui_only: true,
};
const deleteNote = {
  name: 'delete_note', description: 'Delete a note', operation: 'execute', requires_auth: true, params: { id: { type: 'number' } },
  sql: 'DELETE FROM notes WHERE user_id = :__user_id AND id = :id',
};
const owner = () => session('gh:admin', { roles: ['user', 'admin'] });
const dataWorker = () => fetchMock.get(`https://pas-data-club.${env.DATA_WORKER_HOST}`);

/** `validated: false` for a manifest the platform refuses before it asks the data worker to validate any SQL. */
async function register(tools: Record<string, unknown>[], opts: { validated?: boolean } = {}): Promise<{ status: number; body: { warnings?: string[]; error?: string } }> {
  if (opts.validated !== false) dataWorker().intercept({ path: '/validate', method: 'POST' })
    .reply(200, (req) => ({ results: (JSON.parse(String(req.body)) as { statements: { id: string }[] }).statements.map((st) => ({ id: st.id, ok: true })) }));
  const res = await SELF.fetch(`${BASE}/v1/apps/club/tools`, { method: 'PUT', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${await owner()}` }, body: JSON.stringify({ tools }) });
  return { status: res.status, body: await res.json() };
}
/** One action call as the owner. `mcp` adds the header the MCP server puts on every call it makes for an assistant. */
async function call(name: string, opts: { mcp?: boolean; body?: Record<string, unknown> } = {}): Promise<Response> {
  return SELF.fetch(`${BASE}/v1/apps/club/actions/${name}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${await owner()}`, ...(opts.mcp ? { 'X-PAS-Via': 'mcp' } : {}) },
    body: JSON.stringify(opts.body ?? { params: {} }),
  });
}
const runs = (endpoint: 'query' | 'execute') =>
  dataWorker().intercept({ path: `/${endpoint}`, method: 'POST' }).reply(200, endpoint === 'query' ? { rows: [{ id: 1 }] } : { meta: { changes: 1 } });

afterEach(() => fetchMock.assertNoPendingInterceptors());
beforeEach(async () => {
  mockNetwork();
  for (const r of (await env.DB.prepare('SELECT app_id FROM app_workers').all<{ app_id: string }>()).results ?? []) await disableAppWorker(env, r.app_id);
  await resetTables();
  await env.DB.prepare('UPDATE app_worker_platform SET open = 1, closed_reason = NULL, closed_at = NULL').run();
  await seedUser('gh:admin', 'admin');
  await env.DB.prepare('DELETE FROM app_go_live').run();
  await seedApp('club', 'gh:admin');
});

describe('owner_ui_only actions (#500)', () => {
  it('registers the flag, stores it with the action, and rejects a malformed one', async () => {
    expect((await register([listNotes, postNote])).status).toBe(200);
    const row = await env.DB.prepare("SELECT manifest FROM app_tools WHERE app_id = 'club' AND name = 'post_note'").first<{ manifest: string }>();
    expect(JSON.parse(row!.manifest)).toMatchObject({ owner_ui_only: true });

    const bad = await register([{ ...postNote, owner_ui_only: 'yes' }], { validated: false });
    expect(bad.status).toBe(400);
    expect(JSON.stringify(bad.body)).toMatch(/owner_ui_only must be true or false/);
  });

  it("the owner's own UI session can run an owner-UI-only action", async () => {
    await register([postNote]);
    runs('execute');
    const res = await call('post_note', { body: { params: { body: 'hello' } } });
    expect(res.status).toBe(200);
  });

  it('a call the MCP server makes for an assistant is refused with a reason, and nothing reaches the data worker', async () => {
    await register([postNote]);
    const res = await call('post_note', { mcp: true, body: { params: { body: 'hello' } } });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: expect.stringMatching(/only be run by the signed-in owner in the app's own UI, not by an assistant/) });
  });

  it('actions without the flag still run for an assistant, flagged or unflagged siblings alike', async () => {
    await register([listNotes, postNote]);
    runs('query');
    expect((await call('list_notes', { mcp: true })).status).toBe(200);
  });

  it('an explicit owner_ui_only: false behaves like no flag', async () => {
    await register([{ ...listNotes, owner_ui_only: false }]);
    runs('query');
    expect((await call('list_notes', { mcp: true })).status).toBe(200);
  });

  it('registration warns about a post/delete/lock action an assistant can run, and stops once it is flagged', async () => {
    const before = await register([listNotes, deleteNote]);
    expect(before.body.warnings).toEqual(expect.arrayContaining([expect.stringMatching(/action "delete_note" posts, deletes or locks but an MCP agent can run it/)]));
    const after = await register([listNotes, { ...deleteNote, owner_ui_only: true }]);
    expect((after.body.warnings ?? []).join('\n')).not.toMatch(/delete_note" posts, deletes or locks/);
  });
});
