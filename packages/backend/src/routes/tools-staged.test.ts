import { Hono } from 'hono';
import { mintSession } from '@proappstore/build-core';
import { describe, expect, it, vi } from 'vitest';
import { sqliteD1 } from '../sqlite-d1.js';
import { HttpError } from '../lib/auth.js';
import { toolsRoutes } from './tools.js';
import type { Env } from '../types.js';

// #609: the MCP asks for an app's staged actions on every app tool call. That read
// must cost the staged rows, not the app's whole manifest (300 rows a call for hiring).
const KEY = 'tools-staged-unit-test-signing-key';
const api = new Hono<{ Bindings: Env }>();
api.onError((e, c) => c.json({ error: e.message }, (e instanceof HttpError ? e.status : 500) as 400));
api.route('/v1', toolsRoutes);

async function world() {
  const db = sqliteD1();
  const cols = (await db.prepare('PRAGMA table_info(apps)').all<{ name: string; notnull: number; dflt_value: unknown }>()).results!
    .filter((c) => c.notnull && c.dflt_value === null && !['id', 'creator_id'].includes(c.name)).map((c) => c.name);
  await db.prepare(`INSERT INTO apps (id,creator_id,${cols.join(',')}) VALUES (?, ?, ${cols.map(() => '?').join(',')})`)
    .bind('hiring', 'google:owner', ...cols.map((c) => (/_at$/.test(c) ? 1 : `hiring-${c}`))).run();
  const insert = db.prepare("INSERT INTO app_tools (app_id, name, manifest, created_at, updated_at, state) VALUES ('hiring', ?, ?, 1, 1, ?)");
  const manifest = (name: string) => JSON.stringify({ name, description: name, operation: 'query', sql: 'SELECT 1 LIMIT 1', params: {}, requires_auth: true });
  for (let i = 0; i < 300; i += 1) await insert.bind(`live_${i}`, manifest(`live_${i}`), 'live').run();
  await insert.bind('draft_report', manifest('draft_report'), 'staged').run();
  const prepare = vi.spyOn(db, 'prepare');
  const env = { DB: db, SESSION_SIGNING_KEY: KEY } as unknown as Env;
  const list = async (uid: string | null, query = '') => {
    const token = uid ? await mintSession({ uid, login: uid, roles: ['user'], auth_time: Math.floor(Date.now() / 1000) }, KEY) : null;
    const res = await api.request(`/v1/apps/hiring/tools${query}`, { headers: token ? { authorization: `Bearer ${token}` } : {} }, env);
    return { status: res.status, tools: ((await res.json()) as { tools: { name: string; state?: string }[] }).tools };
  };
  const toolReads = () => prepare.mock.calls.map(([sql]) => sql).filter((sql) => /FROM app_tools\b/.test(sql));
  return { db, list, toolReads };
}

describe('GET /v1/apps/:appId/tools?state=staged (#609)', () => {
  it("gives the owner only the staged actions, through the partial index and not the app's live rows", async () => {
    const { db, list, toolReads } = await world();
    const res = await list('google:owner', '?state=staged');
    expect(res.status).toBe(200);
    expect(res.tools).toEqual([expect.objectContaining({ name: 'draft_report', state: 'staged' })]);

    const reads = toolReads();
    expect(reads).toHaveLength(1);
    const plan = db.sql.prepare(`EXPLAIN QUERY PLAN ${reads[0]}`).all('hiring').map((r) => String(r.detail));
    expect(plan[0]).toBe('SEARCH t USING INDEX idx_app_tools_staged (app_id=?)');
    expect(plan.join('\n')).not.toMatch(/SCAN|sqlite_autoindex_app_tools_1/);
  });

  it('gives a caller who is not on the team none, without reading app_tools', async () => {
    const { list, toolReads } = await world();
    expect(await list('google:stranger', '?state=staged')).toEqual({ status: 200, tools: [] });
    expect(await list(null, '?state=staged')).toEqual({ status: 200, tools: [] });
    expect(toolReads()).toHaveLength(0);
  });

  it('leaves the unfiltered listing as it was: all 301 for the owner, the 300 live ones for anyone else', async () => {
    const { list } = await world();
    expect((await list('google:owner')).tools).toHaveLength(301);
    const pub = await list(null);
    expect(pub.tools).toHaveLength(300);
    expect(pub.tools.map((t) => t.name)).not.toContain('draft_report');
  });
});

// #609: the MCP's signed-out list is revalidated by ETag, so a lapsed cache costs the
// app's stamp (one row), not its whole manifest. Triggers on app_tools (0153) change
// the stamp on every write, and a private app never gets a 304.
describe('GET /v1/apps/:appId/tools revalidation (#609)', () => {
  async function get(env: { db: D1Database }, headers: Record<string, string> = {}) {
    return api.request('/v1/apps/hiring/tools', { headers }, { DB: env.db, SESSION_SIGNING_KEY: KEY } as unknown as Env);
  }

  it("answers a matching If-None-Match with 304 and no app_tools read, and the stamp changes on every write", async () => {
    const { db, toolReads } = await world();
    const first = await get({ db });
    const etag = first.headers.get('ETag')!;
    expect(etag).toMatch(/^"[0-9a-f]{16}"$/);
    expect(((await first.json()) as { tools: unknown[] }).tools).toHaveLength(300);
    const listReads = toolReads().length;

    const again = await get({ db }, { 'If-None-Match': etag });
    expect(again.status).toBe(304);
    expect(again.headers.get('ETag')).toBe(etag);
    expect(toolReads()).toHaveLength(listReads);

    // Every kind of write to app_tools changes the stamp, so the old ETag gets the new list.
    const writes = [
      "INSERT INTO app_tools (app_id, name, manifest, created_at, updated_at, state) VALUES ('hiring', 'added', '{\"name\":\"added\",\"operation\":\"query\",\"params\":{}}', 1, 1, 'live')",
      "UPDATE app_tools SET state = 'live' WHERE app_id = 'hiring' AND name = 'draft_report'",
      // Registration's shape: an upsert. SQLite applies its conflict policy to the trigger body too.
      "INSERT INTO app_tools (app_id, name, manifest, created_at, updated_at, state) VALUES ('hiring', 'live_1', '{\"name\":\"live_1\",\"operation\":\"query\",\"params\":{}}', 1, 2, 'live') ON CONFLICT(app_id, name) DO UPDATE SET updated_at = excluded.updated_at",
      "DELETE FROM app_tools WHERE app_id = 'hiring' AND name = 'live_0'",
    ];
    let current = etag;
    for (const sql of writes) {
      await db.prepare(sql).run();
      const res = await get({ db }, { 'If-None-Match': current });
      expect(res.status, sql).toBe(200);
      const next = res.headers.get('ETag')!;
      expect(next, sql).not.toBe(current);
      current = next;
    }
    expect(((await (await get({ db })).json()) as { tools: { name: string }[] }).tools.map((t) => t.name)).toEqual(expect.arrayContaining(['added', 'draft_report']));
  });

  it('never gives a private app an ETag or a 304: a revalidation after the flip is refused', async () => {
    const { db } = await world();
    const etag = (await get({ db })).headers.get('ETag')!;
    await db.prepare("INSERT INTO app_visibility (app_id, mode, roles, created_at) VALUES ('hiring', 'private', '[]', 1)").run();
    const res = await get({ db }, { 'If-None-Match': etag });
    expect(res.status).toBe(403);
    expect(res.headers.get('ETag')).toBeNull();
  });

  it("gives the team's per-caller list no ETag", async () => {
    const { db } = await world();
    const token = await mintSession({ uid: 'google:owner', login: 'owner', roles: ['user'], auth_time: Math.floor(Date.now() / 1000) }, KEY);
    const res = await get({ db }, { authorization: `Bearer ${token}` });
    expect(res.status).toBe(200);
    expect(res.headers.get('ETag')).toBeNull();
  });
});
