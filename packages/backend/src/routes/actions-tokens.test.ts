/**
 * Personal app tokens on the actions route (#154). Separate from actions.test.ts
 * because it mocks the operation log to assert failure attribution.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { testToken, mockStmt, makeEnv as sharedMakeEnv } from '../test-helpers.js';

const recordOperationFailure = vi.fn(async () => {});
vi.mock('../lib/operation-log.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/operation-log.js')>()),
  recordOperationFailure: (...args: unknown[]) => recordOperationFailure(...(args as [])),
}));
const { app } = await import('../index.js');

const SESSION = await testToken('gh:7', { login: 'octo', roles: ['user'] });
const TOKEN = 'pas_at_' + 'c'.repeat(40);
const NOW = Date.now();

function mockD1(...stmts: ReturnType<typeof mockStmt>[]) {
  const prepare = vi.fn();
  for (const stmt of stmts) prepare.mockReturnValueOnce(stmt);
  prepare.mockReturnValue(mockStmt());
  return { prepare, batch: vi.fn().mockResolvedValue([]) };
}
const makeEnv = (db: ReturnType<typeof mockD1>, overrides: Record<string, unknown> = {}) =>
  sharedMakeEnv({ INTERNAL_TOKEN: 'internal-secret', ...overrides }, db);

const manifest = (o: Record<string, unknown> = {}) => JSON.stringify({
  name: 'list_mine', description: 'x', operation: 'query',
  sql: 'SELECT id FROM items WHERE user_id = :__user_id LIMIT 20', params: {}, requires_auth: true, ...o,
});
const tokenRow = (o: Record<string, unknown> = {}) => ({ token_id: 'a'.repeat(32), user_id: 'gh:7', app_id: 'leads', scopes: '{"access":"read","actions":null}', expires_at: NOW + 60_000, revoked_at: null, ...o });
const usersRow = () => mockStmt({ first: { login: 'octo', avatar_url: null } });

const call = (name: string, bearer: string | null = TOKEN, appId = 'leads') =>
  ({ method: 'POST', headers: { ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}), 'Content-Type': 'application/json' }, body: JSON.stringify({ params: {} }) });

afterEach(() => { vi.unstubAllGlobals(); recordOperationFailure.mockClear(); });

describe('POST /v1/apps/:appId/actions/:name with a pas_at_ token', () => {
  it('runs as the token user: X-Internal-Token upstream and NO Authorization; :__user_id bound; last_used_at touched', async () => {
    const fetchMock = vi.fn().mockResolvedValue(Response.json({ rows: [{ id: 'i1' }] }));
    vi.stubGlobal('fetch', fetchMock);
    const touch = mockStmt();
    const db = mockD1(mockStmt({ first: { manifest: manifest() } }), mockStmt({ first: tokenRow() }), usersRow(), touch);
    const res = await app.request('/v1/apps/leads/actions/list_mine', call('list_mine'), makeEnv(db));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ rows: [{ id: 'i1' }] });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://pas-data-leads.serge-the-dev.workers.dev/query');
    expect(init.headers).toEqual({ 'X-Internal-Token': 'internal-secret', 'Content-Type': 'application/json' });
    expect(JSON.parse(init.body as string).params).toEqual(['gh:7']);
    expect(String(db.prepare.mock.calls[3]![0])).toContain('UPDATE user_app_tokens SET last_used_at');
    expect(touch.bind.mock.calls[0]![1]).toBeDefined();
  });

  it('401 for a token bound to another app, revoked, expired or unknown — before any upstream call', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    for (const row of [tokenRow({ app_id: 'crm' }), tokenRow({ revoked_at: NOW - 1 }), tokenRow({ expires_at: NOW - 1 }), null]) {
      const res = await app.request('/v1/apps/leads/actions/list_mine', call('list_mine'), makeEnv(mockD1(mockStmt({ first: { manifest: manifest() } }), mockStmt({ first: row }))));
      expect(res.status).toBe(401);
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refuses a scheduled action even for a write token scoped to it, before the token is checked (#203)', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const scheduled = manifest({
      name: 'reap_stale', operation: 'execute', sql: 'UPDATE games SET status = \'abandoned\' WHERE updated_at < :__now - :idle_ms',
      params: { idle_ms: { type: 'integer' } },
      auth: { caller_unscoped: { reason: 'bounded by stale state' } },
      schedule: { cron: '*/15 * * * *', params: { idle_ms: 3_600_000 } },
    });
    const db = mockD1(mockStmt({ first: { manifest: scheduled } }), mockStmt({ first: tokenRow({ scopes: '{"access":"write","actions":["reap_stale"]}' }) }), usersRow());
    const res = await app.request('/v1/apps/leads/actions/reap_stale', call('reap_stale'), makeEnv(db));
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toBe('scheduled actions run only on the platform scheduler');
    expect(db.prepare).toHaveBeenCalledTimes(1); // the manifest read only
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('a read token may call query actions only', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ meta: { changes: 1 } })));
    const exec = manifest({ name: 'add_item', operation: 'execute', sql: 'INSERT INTO items (id, user_id) VALUES (:__uuid, :__user_id)' });
    const res = await app.request('/v1/apps/leads/actions/add_item', call('add_item'), makeEnv(mockD1(mockStmt({ first: { manifest: exec } }), mockStmt({ first: tokenRow() }), usersRow())));
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toBe('token is read-only');
    const batch = manifest({ name: 'two', operation: 'batch', sql: undefined, statements: ['DELETE FROM items WHERE user_id = :__user_id'] });
    const res2 = await app.request('/v1/apps/leads/actions/two', call('two'), makeEnv(mockD1(mockStmt({ first: { manifest: batch } }), mockStmt({ first: tokenRow() }), usersRow())));
    expect(res2.status).toBe(403);
    const write = await app.request('/v1/apps/leads/actions/add_item', call('add_item'), makeEnv(mockD1(mockStmt({ first: { manifest: exec } }), mockStmt({ first: tokenRow({ scopes: '{"access":"write","actions":null}' }) }), usersRow())));
    expect(write.status).toBe(200);
  });

  it('an action-scoped token reaches its actions and nothing else', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ rows: [] })));
    const scoped = tokenRow({ scopes: '{"access":"read","actions":["api_my_tasks"]}' });
    const ok = await app.request('/v1/apps/leads/actions/api_my_tasks', call('api_my_tasks'), makeEnv(mockD1(mockStmt({ first: { manifest: manifest({ name: 'api_my_tasks' }) } }), mockStmt({ first: scoped }), usersRow())));
    expect(ok.status).toBe(200);
    const no = await app.request('/v1/apps/leads/actions/list_mine', call('list_mine'), makeEnv(mockD1(mockStmt({ first: { manifest: manifest() } }), mockStmt({ first: scoped }), usersRow())));
    expect(no.status).toBe(403);
    expect(((await no.json()) as { error: string }).error).toBe('token is not scoped to this action');
  });

  it('app roles granted by login still match; platform roles never do for a token', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ rows: [] })));
    const gated = manifest({ auth: { app_roles: ['manager'] } });
    const roles = mockStmt({ all: { results: [{ role_name: 'manager' }] } });
    const ok = await app.request('/v1/apps/leads/actions/list_mine', call('list_mine'), makeEnv(mockD1(mockStmt({ first: { manifest: gated } }), mockStmt({ first: tokenRow() }), usersRow(), roles)));
    expect(ok.status).toBe(200);
    expect(roles.bind).toHaveBeenCalledWith('leads', 'gh:7', 'octo');
    const creatorOnly = manifest({ auth: { platform_roles: ['creator'] } });
    const res = await app.request('/v1/apps/leads/actions/list_mine', call('list_mine'), makeEnv(mockD1(mockStmt({ first: { manifest: creatorOnly } }), mockStmt({ first: tokenRow() }), usersRow())));
    expect(res.status).toBe(403);
  });

  it('a session-authed execute still works for a user who also holds a read-only token (scopes never touch sessions)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ meta: { changes: 1 } })));
    const exec = manifest({ name: 'add_item', operation: 'execute', sql: 'INSERT INTO items (id, user_id) VALUES (:__uuid, :__user_id)' });
    const res = await app.request('/v1/apps/leads/actions/add_item', call('add_item', SESSION), makeEnv(mockD1(mockStmt({ first: { manifest: exec } }))));
    expect(res.status).toBe(200);
  });

  it('a failed token call is logged with the token user id', async () => {
    const exec = manifest({ name: 'add_item', operation: 'execute', sql: 'INSERT INTO items (id, user_id) VALUES (:__uuid, :__user_id)' });
    const res = await app.request('/v1/apps/leads/actions/add_item', call('add_item'), makeEnv(mockD1(mockStmt({ first: { manifest: exec } }), mockStmt({ first: tokenRow() }), usersRow())));
    expect(res.status).toBe(403);
    await new Promise((r) => setTimeout(r, 0));
    expect(recordOperationFailure).toHaveBeenCalledTimes(1);
    expect((recordOperationFailure.mock.calls[0] as unknown[])[1]).toMatchObject({ appId: 'leads', userId: 'gh:7', status: 403 });
  });
});

describe('read tokens and verify actions (#148)', () => {
  const verify = (statements?: string[]) => manifest({
    name: 'claim', operation: 'verify', verifier: 'chess.replay',
    sql: 'SELECT moves FROM games WHERE id = :game_id AND white_id = :__user_id',
    ...(statements ? { statements } : {}),
    params: { game_id: { type: 'string' } },
  });
  const body = { method: 'POST', headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ params: { game_id: 'g1' } }) };

  it('a read token may run a verify action that declares no writes', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ rows: [{ moves: 'e4' }] })));
    const res = await app.request('/v1/apps/leads/actions/claim', body, makeEnv(mockD1(mockStmt({ first: { manifest: verify() } }), mockStmt({ first: tokenRow() }), usersRow())));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, output: { legal: true, over: false } });
  });

  it('a read token may NOT run a verify action that writes', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const writes = ["UPDATE games SET status = 'finished' WHERE id = :game_id AND white_id = :__user_id AND :__verify_over = 1"];
    const res = await app.request('/v1/apps/leads/actions/claim', body, makeEnv(mockD1(mockStmt({ first: { manifest: verify(writes) } }), mockStmt({ first: tokenRow() }), usersRow())));
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toBe('token is read-only');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
