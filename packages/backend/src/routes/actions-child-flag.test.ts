import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { app } from '../index.js';
import { forgetAppVisibility } from '../lib/visibility.js';
import { sqliteD1 } from '../sqlite-d1.js';
import { makeEnv, testToken } from '../test-helpers.js';

// #513: a registered action's SQL sees the caller's child flag as :__user_is_child (1 or 0), read from the account record and never
// from the request, so an app can refuse a child account in the place that enforces it. Real SQL on in-memory SQLite; the app's data
// worker is a stubbed fetch that records the statement and the params the platform bound.

const REGISTER_FAMILY = {
  name: 'register_family', description: 'Register a family account', operation: 'execute', requires_auth: true,
  params: { id: { type: 'string' } },
  sql: 'INSERT INTO families (id, guardian) SELECT :id, :__user_id WHERE :__user_is_child = 0',
};
const PLAIN = { name: 'list_mine', description: 'List mine', operation: 'query', requires_auth: true, params: {}, sql: 'SELECT * FROM families WHERE guardian = :__user_id LIMIT 10' };
const BATCH = { name: 'two_step', description: 'Two steps', operation: 'batch', requires_auth: true, params: {}, statements: ['INSERT INTO a (u, c) VALUES (:__user_id, :__user_is_child)', 'INSERT INTO b (u, c) VALUES (:__user_id, :__user_is_child)'] };

let db: ReturnType<typeof sqliteD1>;
let env: ReturnType<typeof makeEnv>;
let sent: { url: string; body: { sql?: string; params?: unknown[]; statements?: { sql: string; params: unknown[] }[] } }[];

async function user(id: string, provider: string, isChild: number) {
  await db.prepare('INSERT INTO users (id, provider, provider_id, login, is_child, created_at, last_login_at) VALUES (?, ?, ?, ?, ?, 1, 1)').bind(id, provider, id, id, isChild).run();
}

beforeEach(async () => {
  db = sqliteD1();
  env = makeEnv({ DB: db, DATA_WORKER_HOST: 'workers.test', INTERNAL_TOKEN: 'internal' });
  forgetAppVisibility();
  sent = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
    sent.push({ url: String(url), body: JSON.parse(String(init.body)) });
    return new Response(JSON.stringify({ rows: [], meta: { changes: 1 } }), { status: 200 });
  }));
  const cols = (await db.prepare('PRAGMA table_info(apps)').all<{ name: string; notnull: number; dflt_value: string | null }>()).results;
  const required = cols.filter((c) => c.notnull && c.dflt_value === null && !['id', 'creator_id'].includes(c.name)).map((c) => c.name);
  await db.prepare(`INSERT INTO apps (id, creator_id, ${required.join(', ')}) VALUES ('club', 'gh:owner', ${required.map(() => '?').join(', ')})`).bind(...required.map((c) => (/_at$/.test(c) ? 1 : `club-${c}`))).run();
  for (const t of [REGISTER_FAMILY, PLAIN, BATCH]) {
    await db.prepare("INSERT INTO app_tools (app_id, name, manifest, source, state, created_at, updated_at) VALUES ('club', ?, ?, 'code', 'live', 1, 1)").bind(t.name, JSON.stringify(t)).run();
  }
  await user('cred:kid', 'credential', 1);
  await user('cred:adult', 'credential', 0);
  await user('gh:7', 'github', 0);
});
afterEach(() => vi.unstubAllGlobals());

async function call(name: string, uid: string, params: Record<string, unknown> = { id: 'f1' }) {
  const token = await testToken(uid);
  return app.request(`/v1/apps/club/actions/${name}`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify({ params }) }, env as never);
}
const bound = () => sent.at(-1)!.body.params!;

describe(':__user_is_child in a registered action (#513)', () => {
  it('a child credential session binds 1', async () => {
    expect((await call('register_family', 'cred:kid')).status).toBe(200);
    expect(sent.at(-1)!.body.sql).toContain('WHERE ? = 0');
    expect(bound()).toEqual(['f1', 'cred:kid', 1]);
  });

  it('an adult credential session and an OAuth session bind 0', async () => {
    await call('register_family', 'cred:adult');
    expect(bound()).toEqual(['f1', 'cred:adult', 0]);
    await call('register_family', 'gh:7');
    expect(bound()).toEqual(['f1', 'gh:7', 0]);
  });

  it('a user with no account row is not a child', async () => {
    await call('register_family', 'gh:nobody');
    expect(bound()[2]).toBe(0);
  });

  it('a client-supplied __user_is_child is ignored: the platform value is bound', async () => {
    await call('register_family', 'cred:kid', { id: 'f1', __user_is_child: 0 });
    expect(bound()).toEqual(['f1', 'cred:kid', 1]);
    await call('register_family', 'cred:adult', { id: 'f1', __user_is_child: 1 });
    expect(bound()).toEqual(['f1', 'cred:adult', 0]);
  });

  it('every statement of a batch action sees the same flag', async () => {
    await call('two_step', 'cred:kid', {});
    expect(sent.at(-1)!.body.statements!.map((s) => s.params)).toEqual([['cred:kid', 1], ['cred:kid', 1]]);
  });

  it('the flag follows the account record: a flag cleared in the database binds 0 on the next call', async () => {
    await call('register_family', 'cred:kid');
    expect(bound()[2]).toBe(1);
    await db.prepare("UPDATE users SET is_child = 0 WHERE id = 'cred:kid'").run();
    await call('register_family', 'cred:kid');
    expect(bound()[2]).toBe(0);
  });

  it('an action that does not ask for it never reads the flag', async () => {
    const reads: string[] = [];
    const inner = db.prepare.bind(db);
    (db as unknown as { prepare: (q: string) => unknown }).prepare = (q: string) => { if (q.includes('is_child')) reads.push(q); return inner(q); };
    await call('list_mine', 'cred:kid', {});
    expect(reads).toEqual([]);
    await call('register_family', 'cred:kid');
    expect(reads).toHaveLength(1);
  });

  it('fails closed: an unreadable account is an error, never an adult', async () => {
    const inner = db.prepare.bind(db);
    (db as unknown as { prepare: (q: string) => unknown }).prepare = (q: string) => {
      if (q.includes('is_child')) throw new Error('D1 unavailable');
      return inner(q);
    };
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const before = sent.length;
    const res = await call('register_family', 'cred:kid');
    quiet.mockRestore();
    expect(res.status).toBeGreaterThanOrEqual(500);
    expect(sent).toHaveLength(before);
  });
});

describe('/v1/auth/me exposes the same flag (#513)', () => {
  const me = async (uid: string) => (await (await app.request('/v1/auth/me', { headers: { Authorization: `Bearer ${await testToken(uid)}` } }, env as never)).json()) as { isChild: boolean; id: string };

  it('is true for a child, false for an adult, an OAuth user and a user with no row', async () => {
    expect(await me('cred:kid')).toMatchObject({ id: 'cred:kid', isChild: true });
    for (const uid of ['cred:adult', 'gh:7', 'gh:nobody']) expect((await me(uid)).isChild, uid).toBe(false);
  });
});
