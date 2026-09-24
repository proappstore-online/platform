import { describe, expect, it, vi } from 'vitest';
import { app } from '../index.js';
import { testToken, mockStmt, makeEnv as sharedMakeEnv } from '../test-helpers.js';
import { sha256Hex } from '../lib/app-tokens.js';

const TOK = await testToken('gh:1', { login: 'alice' });
const OTHER = await testToken('gh:2', { login: 'bob' });

function mockD1(...stmts: ReturnType<typeof mockStmt>[]) {
  const prepare = vi.fn();
  for (const stmt of stmts) prepare.mockReturnValueOnce(stmt);
  prepare.mockReturnValue(mockStmt());
  return { prepare, batch: vi.fn().mockResolvedValue([]) };
}
const makeEnv = (db: ReturnType<typeof mockD1>) => sharedMakeEnv({}, db);
const appRow = () => mockStmt({ first: { id: 'leads' } });
const post = (body: unknown, headers: Record<string, string> = {}, token = TOK) =>
  ({ method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });

describe('POST /v1/apps/:appId/tokens', () => {
  it('mints: plaintext once, hash stored, scopes and origin recorded, 201', async () => {
    const insert = mockStmt();
    const db = mockD1(appRow(), insert);
    const res = await app.request('/v1/apps/leads/tokens', post({ label: 'zapier', expires_in: 3600, access: 'read' }), makeEnv(db));
    expect(res.status).toBe(201);
    const body = (await res.json()) as { token: string; token_id: string; access: string; actions: null; expires_at: number; created_at: number; created_origin: null; label: string };
    expect(body.token).toMatch(/^pas_at_[a-f0-9]{40}$/);
    expect(body.token_id).toMatch(/^[a-f0-9]{32}$/);
    expect(body).toMatchObject({ access: 'read', actions: null, label: 'zapier', created_origin: null });
    expect(body.expires_at - body.created_at).toBe(3600 * 1000);
    const [hash, id, userId, appId, label, scopes] = insert.bind.mock.calls[0] as unknown[];
    expect(hash).toBe(await sha256Hex(body.token));
    expect(id).toBe(body.token_id);
    expect([userId, appId, label]).toEqual(['gh:1', 'leads', 'zapier']);
    expect(JSON.parse(String(scopes))).toEqual({ access: 'read', actions: null });
  });

  it('400 without access, without expires_in, or below the minimum', async () => {
    expect((await app.request('/v1/apps/leads/tokens', post({ expires_in: 3600 }), makeEnv(mockD1(appRow())))).status).toBe(400);
    expect((await app.request('/v1/apps/leads/tokens', post({ access: 'read' }), makeEnv(mockD1(appRow())))).status).toBe(400);
    expect((await app.request('/v1/apps/leads/tokens', post({ access: 'admin', expires_in: 3600 }), makeEnv(mockD1(appRow())))).status).toBe(400);
    expect((await app.request('/v1/apps/leads/tokens', post({ access: 'read', expires_in: 5 }), makeEnv(mockD1(appRow())))).status).toBe(400);
  });

  it('caps the lifetime at 90 days from an app origin and 365 days from a first-party origin', async () => {
    const year = 365 * 86_400;
    const fromApp = await app.request('/v1/apps/leads/tokens', post({ access: 'read', expires_in: year }, { Origin: 'https://leads.proappstore.online' }), makeEnv(mockD1(appRow(), mockStmt())));
    const a = (await fromApp.json()) as { expires_at: number; created_at: number; note?: string; created_origin: string };
    expect(a.expires_at - a.created_at).toBe(90 * 86_400 * 1000);
    expect(a.note).toMatch(/capped/);
    expect(a.created_origin).toBe('leads.proappstore.online');
    const fromDash = await app.request('/v1/apps/leads/tokens', post({ access: 'read', expires_in: year }, { Origin: 'https://dashboard.proappstore.online' }), makeEnv(mockD1(appRow(), mockStmt())));
    const d = (await fromDash.json()) as { expires_at: number; created_at: number; note?: string };
    expect(d.expires_at - d.created_at).toBe(year * 1000);
    expect(d.note).toBeUndefined();
    // No Origin at all (a script holding a session JWT) gets the first-party cap: never non-expiring.
    const tooLong = await app.request('/v1/apps/leads/tokens', post({ access: 'read', expires_in: year * 2 }), makeEnv(mockD1(appRow(), mockStmt())));
    const t = (await tooLong.json()) as { expires_at: number; created_at: number; note?: string };
    expect(t.expires_at - t.created_at).toBe(year * 1000);
    expect(t.note).toMatch(/capped/);
  });

  it('validates scoped actions against app_tools: unknown → 400 naming it; known → stored', async () => {
    const bad = await app.request('/v1/apps/leads/tokens', post({ access: 'write', expires_in: 3600, actions: ['api_my_tasks', 'nope'] }), makeEnv(mockD1(appRow(), mockStmt({ all: { results: [{ name: 'api_my_tasks' }] } }))));
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { error: string }).error).toBe('unknown action: nope');
    const insert = mockStmt();
    const ok = await app.request('/v1/apps/leads/tokens', post({ access: 'write', expires_in: 3600, actions: ['api_my_tasks'] }), makeEnv(mockD1(appRow(), mockStmt({ all: { results: [{ name: 'api_my_tasks' }] } }), insert)));
    expect(ok.status).toBe(201);
    expect(((await ok.json()) as { actions: string[] }).actions).toEqual(['api_my_tasks']);
    expect(JSON.parse(String(insert.bind.mock.calls[0]![5]))).toEqual({ access: 'write', actions: ['api_my_tasks'] });
    const shape = await app.request('/v1/apps/leads/tokens', post({ access: 'write', expires_in: 3600, actions: ['Bad-Name'] }), makeEnv(mockD1(appRow())));
    expect(shape.status).toBe(400);
  });

  it('404 for an unknown app; 401 without a session; 401 with a pas_at_ bearer — a token never manages tokens', async () => {
    expect((await app.request('/v1/apps/ghost/tokens', post({ access: 'read', expires_in: 3600 }), makeEnv(mockD1(mockStmt({ first: null }))))).status).toBe(404);
    expect((await app.request('/v1/apps/leads/tokens', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }, makeEnv(mockD1()))).status).toBe(401);
    const tokenBearer = { Authorization: 'Bearer pas_at_' + 'f'.repeat(40) };
    expect((await app.request('/v1/apps/leads/tokens', { method: 'POST', headers: { ...tokenBearer, 'Content-Type': 'application/json' }, body: JSON.stringify({ access: 'read', expires_in: 3600 }) }, makeEnv(mockD1()))).status).toBe(401);
    expect((await app.request('/v1/apps/leads/tokens', { headers: tokenBearer }, makeEnv(mockD1()))).status).toBe(401);
    expect((await app.request('/v1/apps/leads/tokens/' + 'a'.repeat(32), { method: 'DELETE', headers: tokenBearer }, makeEnv(mockD1()))).status).toBe(401);
    expect((await app.request('/v1/me/tokens', { headers: tokenBearer }, makeEnv(mockD1()))).status).toBe(401);
  });
});

describe('GET /v1/apps/:appId/tokens and /v1/me/tokens', () => {
  const rows = [
    { token_id: 'a'.repeat(32), app_id: 'leads', label: 'zapier', scopes: '{"access":"read","actions":null}', created_origin: 'leads.proappstore.online', created_at: 1, last_used_at: 2, expires_at: Date.now() + 1000 },
    { token_id: 'b'.repeat(32), app_id: 'crm', label: null, scopes: '{"access":"write","actions":["api_x"]}', created_origin: null, created_at: 1, last_used_at: null, expires_at: 1 },
  ];
  it('lists mine with access / actions / origin and never the token or hash', async () => {
    const stmt = mockStmt({ all: { results: [rows[0]] } });
    const res = await app.request('/v1/apps/leads/tokens', { headers: { Authorization: `Bearer ${TOK}` } }, makeEnv(mockD1(stmt)));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { tokens: Record<string, unknown>[] };
    expect(body.tokens).toEqual([expect.objectContaining({ token_id: 'a'.repeat(32), access: 'read', actions: null, created_origin: 'leads.proappstore.online', expired: false })]);
    expect(Object.keys(body.tokens[0]!)).not.toEqual(expect.arrayContaining(['token', 'token_hash', 'scopes']));
    expect(stmt.bind).toHaveBeenCalledWith('leads', 'gh:1');
  });
  it('/v1/me/tokens spans apps and marks expired ones', async () => {
    const res = await app.request('/v1/me/tokens', { headers: { Authorization: `Bearer ${TOK}` } }, makeEnv(mockD1(mockStmt({ all: { results: rows } }))));
    const body = (await res.json()) as { tokens: { app_id: string; access: string; actions: string[] | null; expired: boolean }[] };
    expect(body.tokens.map((t) => [t.app_id, t.access, t.actions, t.expired])).toEqual([['leads', 'read', null, false], ['crm', 'write', ['api_x'], true]]);
  });
});

describe('DELETE /v1/apps/:appId/tokens/:tokenId', () => {
  it('revokes by exact id + user + app; another user, or a wildcard-shaped id, is 404', async () => {
    const upd = mockStmt({ run: { meta: { changes: 1 } } });
    const res = await app.request('/v1/apps/leads/tokens/' + 'a'.repeat(32), { method: 'DELETE', headers: { Authorization: `Bearer ${TOK}` } }, makeEnv(mockD1(upd)));
    expect(res.status).toBe(200);
    expect(upd.bind.mock.calls[0]!.slice(1)).toEqual(['a'.repeat(32), 'gh:1', 'leads']);
    const other = mockStmt({ run: { meta: { changes: 0 } } });
    const notMine = await app.request('/v1/apps/leads/tokens/' + 'a'.repeat(32), { method: 'DELETE', headers: { Authorization: `Bearer ${OTHER}` } }, makeEnv(mockD1(other)));
    expect(notMine.status).toBe(404);
    expect(other.bind.mock.calls[0]!.slice(1)).toEqual(['a'.repeat(32), 'gh:2', 'leads']);
    const wildcard = mockStmt({ run: { meta: { changes: 0 } } });
    const res2 = await app.request('/v1/apps/leads/tokens/%25', { method: 'DELETE', headers: { Authorization: `Bearer ${TOK}` } }, makeEnv(mockD1(wildcard)));
    expect(res2.status).toBe(404);
    expect(String(wildcard.bind.mock.calls[0]![1])).toBe('%');
    expect(String(mockD1(wildcard).prepare.mock.calls[0]?.[0] ?? '')).not.toContain('LIKE');
  });
});
