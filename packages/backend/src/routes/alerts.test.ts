import { describe, expect, it, vi } from 'vitest';
import { app } from '../index.js';
import { testToken, mockStmt, makeEnv as sharedMakeEnv } from '../test-helpers.js';

const TOK = await testToken('gh:1');
const OTHER = await testToken('gh:2');
function mockD1(...stmts: ReturnType<typeof mockStmt>[]) {
  const prepare = vi.fn();
  for (const stmt of stmts) prepare.mockReturnValueOnce(stmt);
  prepare.mockReturnValue(mockStmt());
  return { prepare, batch: vi.fn().mockResolvedValue([]) };
}
const owner = () => mockStmt({ first: { creator_id: 'gh:1' } });
const auth = (t = TOK) => ({ headers: { Authorization: `Bearer ${t}` } });

describe('GET /v1/apps/:appId/alerts (#107)', () => {
  it('lists the app owner\'s alerts with parsed top and build; non-owners are refused', async () => {
    const row = { id: 7, app_id: 'leads', kind: 'error_spike', window_start: 1, window_end: 2, count: 40, affected_users: 9, baseline: 0, top: '{"categories":[{"category":"runtime","count":7}]}', build_meta: '{"sha":"abc"}', created_at: 3, acknowledged_at: null, acknowledged_by: null };
    const res = await app.request('/v1/apps/leads/alerts?open=1', auth(), sharedMakeEnv({}, mockD1(owner(), mockStmt({ all: { results: [row] } }))));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { alerts: Record<string, unknown>[] };
    expect(body.alerts[0]).toMatchObject({ id: 7, kind: 'error_spike', count: 40, affected_users: 9, top: { categories: [{ category: 'runtime', count: 7 }] }, build: { sha: 'abc' } });
    expect(body.alerts[0]).not.toHaveProperty('build_meta');
    const db = mockD1(mockStmt({ first: { creator_id: 'gh:1' } }), mockStmt({ first: { role: 'viewer' } }));
    expect((await app.request('/v1/apps/leads/alerts', auth(OTHER), sharedMakeEnv({}, db))).status).toBe(403);
    expect((await app.request('/v1/apps/leads/alerts', {}, sharedMakeEnv({}, mockD1()))).status).toBe(401);
  });

  it('ack marks one alert once; a second ack or a foreign id is 404', async () => {
    const ok = await app.request('/v1/apps/leads/alerts/7/ack', { method: 'POST', ...auth() }, sharedMakeEnv({}, mockD1(owner(), mockStmt({ run: { meta: { changes: 1 } } }))));
    expect(ok.status).toBe(200);
    const again = await app.request('/v1/apps/leads/alerts/7/ack', { method: 'POST', ...auth() }, sharedMakeEnv({}, mockD1(owner(), mockStmt({ run: { meta: { changes: 0 } } }))));
    expect(again.status).toBe(404);
    expect((await app.request('/v1/apps/leads/alerts/x/ack', { method: 'POST', ...auth() }, sharedMakeEnv({}, mockD1(owner())))).status).toBe(400);
  });

  it('evaluate runs the evaluator for this app only and returns its report', async () => {
    const db = mockD1(owner());
    const res = await app.request('/v1/apps/leads/alerts/evaluate', { method: 'POST', ...auth() }, sharedMakeEnv({}, db));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ alerts: [], recorded: 0, windowMs: 15 * 60_000 });
    const scoped = db.prepare.mock.calls.map((c) => String(c[0])).filter((s) => /FROM app_logs WHERE ingested_at/.test(s));
    expect(scoped.length).toBeGreaterThan(0);
    expect(scoped.every((s) => s.includes('AND app_id = ?'))).toBe(true);
  });
});
