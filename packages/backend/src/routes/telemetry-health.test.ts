import { afterEach, describe, expect, it, vi } from 'vitest';
import { app } from '../index.js';
import { testToken, mockStmt, makeEnv as sharedMakeEnv } from '../test-helpers.js';
import { componentStatus } from './telemetry-health.js';

// #391: request denominators come from Analytics Engine, weighted by its sample
// interval; the real-D1 half of this API is in runtime-tests telemetry-health.test.ts.

const TOK = await testToken('gh:1');
function mockD1(...stmts: ReturnType<typeof mockStmt>[]) {
  const prepare = vi.fn();
  for (const stmt of stmts) prepare.mockReturnValueOnce(stmt);
  prepare.mockReturnValue(mockStmt());
  return { prepare, batch: vi.fn().mockResolvedValue([]) };
}
const healthy = () => mockStmt({ all: { results: [{ component: 'evaluator', app_id: '', last_ok_at: Date.now(), last_failure_at: null, last_error: null }] } });
afterEach(() => vi.unstubAllGlobals());

describe('GET /v1/apps/:appId/telemetry/health — request denominators (#391)', () => {
  it('weights AE rows by sample interval and derives the 5xx rate from the same points', async () => {
    const sql: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
      sql.push(String(init.body));
      return Response.json({ data: [
        { outcome: 'ok', latency: 'lt_100ms', family: 'actions', n: '80' },
        { outcome: 'ok', latency: 'lt_100ms', family: 'kv', n: '10' },
        { outcome: '4xx', latency: 'lt_500ms', family: 'actions', n: 6 },
        { outcome: '5xx', latency: 'ge_2s', family: 'actions', n: 4 },
      ] });
    }));
    const env = sharedMakeEnv({ CF_ANALYTICS_API_TOKEN: 'tok', CF_ACCOUNT_ID: 'acct' }, mockD1(mockStmt({ first: { creator_id: 'gh:1' } }), healthy()));
    const res = await app.request('/v1/apps/leads/telemetry/health', { headers: { Authorization: `Bearer ${TOK}` } }, env);
    expect(res.status).toBe(200);
    const body = await res.json() as { status: string; requests: { status: string; sampled: boolean; lastHour: Record<string, unknown> } };
    expect(body.requests).toMatchObject({ status: 'ok', sampled: true });
    expect(body.requests.lastHour).toEqual({
      total: 100, ok: 90, clientErrors: 6, serverErrors: 4, serverErrorRate: 0.04,
      latency: { lt_100ms: 90, lt_500ms: 6, lt_2s: 0, ge_2s: 4 },
      // Per family, each rate over that family's own total.
      byFamily: {
        actions: { total: 90, ok: 80, clientErrors: 6, serverErrors: 4, serverErrorRate: 4 / 90 },
        kv: { total: 10, ok: 10, clientErrors: 0, serverErrors: 0, serverErrorRate: 0 },
      },
    });
    expect(sql[0]).toContain('blob3 AS family');
    expect(sql[0]).toContain('SUM(_sample_interval)');
    expect(sql[0]).toContain("index1 = 'leads'");
  });

  it('an AE failure is unknown request data and a degraded whole, never zero', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('boom', { status: 500 })));
    const env = sharedMakeEnv({ CF_ANALYTICS_API_TOKEN: 'tok', CF_ACCOUNT_ID: 'acct' }, mockD1(mockStmt({ first: { creator_id: 'gh:1' } }), healthy()));
    const body = await (await app.request('/v1/apps/leads/telemetry/health', { headers: { Authorization: `Bearer ${TOK}` } }, env)).json() as { status: string; requests: { status: string; lastHour: unknown } };
    expect(body.requests).toMatchObject({ status: 'unknown', lastHour: null });
    expect(body.status).toBe('degraded');
  });
});

describe('request-outcome middleware (#391)', () => {
  it('writes one point per app-scoped request: outcome class and latency bucket only, never the path', async () => {
    const points: { indexes: string[]; blobs: string[]; doubles: number[] }[] = [];
    const env = sharedMakeEnv({ REQUEST_METRICS: { writeDataPoint: (p: never) => points.push(p) } }, mockD1());
    await app.request('/v1/apps/leads/kv/some-secret-key', {}, env);
    expect(points).toHaveLength(1);
    expect(points[0]!.indexes).toEqual(['leads']);
    expect(points[0]!.blobs).toEqual(['4xx', expect.stringMatching(/^(lt_100ms|lt_500ms|lt_2s|ge_2s)$/), 'kv']);
    expect(JSON.stringify(points)).not.toContain('some-secret-key');
  });

  it('excludes the telemetry plane, preflights and ids that are not app slugs', async () => {
    const points: unknown[] = [];
    const env = sharedMakeEnv({ REQUEST_METRICS: { writeDataPoint: (p: never) => points.push(p) } }, mockD1());
    await app.request('/v1/apps/leads/logs', { method: 'POST', body: '{}' }, env);
    await app.request('/v1/apps/leads/telemetry/health', {}, env);
    await app.request('/v1/apps/leads/kv/x', { method: 'OPTIONS' }, env);
    await app.request('/v1/apps/NOT_A_SLUG/kv/x', {}, env);
    expect(points).toHaveLength(0);
  });
});

describe('request family label (#391)', () => {
  it('is a fixed family name or `other` — never a path segment the caller chose', async () => {
    const points: { blobs: string[] }[] = [];
    const env = sharedMakeEnv({ REQUEST_METRICS: { writeDataPoint: (p: never) => points.push(p) } }, mockD1());
    await app.request('/v1/apps/leads/actions/save_lead', { method: 'POST', body: '{}' }, env);
    await app.request('/v1/apps/leads/some-secret-path-segment/x', {}, env);
    expect(points.map((p) => p.blobs[2])).toEqual(['actions', 'other']);
    expect(JSON.stringify(points)).not.toContain('some-secret');
  });
});

describe('componentStatus (#391)', () => {
  const row = (ok: number | null, fail: number | null) => ({ component: 'evaluator' as const, app_id: '', last_ok_at: ok, last_failure_at: fail, last_error: null });
  it('ok, degraded on a newer failure, unknown when never ok or stale', () => {
    expect(componentStatus(row(1000, null), 1500, 1000)).toBe('ok');
    expect(componentStatus(row(1000, 1200), 1500, 1000)).toBe('degraded');
    expect(componentStatus(row(1300, 1200), 1500, 1000)).toBe('ok');
    expect(componentStatus(row(null, null), 1500, 1000)).toBe('unknown');
    expect(componentStatus(row(100, null), 1500, 1000)).toBe('unknown');
    expect(componentStatus(undefined, 1500, 1000)).toBe('unknown');
  });
});
