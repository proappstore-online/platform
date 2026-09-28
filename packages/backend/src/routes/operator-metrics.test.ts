import { afterEach, describe, expect, it, vi } from 'vitest';
import { app } from '../index.js';
import { makeEnv, mockD1, mockStmt, testToken } from '../test-helpers.js';
import { validateOperatorView } from '../lib/operator-contract.js';
import type { ToolManifest } from '../lib/action-sql.js';
import { PARENTS_CLUBS, STASH } from '../__fixtures__/operator-view.js';

// #240 metric time series: owner-only, validated before the app's query runs,
// under the query's own role gate, rolled up and bounded, audited without values.

const OWNER = await testToken('gh:1');
const stored = (sample: typeof STASH | typeof PARENTS_CLUBS) => {
  const r = validateOperatorView(sample.tools as ToolManifest[], sample.operator_view);
  if (!('contract' in r)) throw new Error(r.error);
  return JSON.stringify(r.contract);
};
/** owner check → contract → action manifest → app-role lookup → audit insert. */
function db(sample: typeof STASH | typeof PARENTS_CLUBS, action: string, opts: { creator?: string; roles?: string[] } = {}) {
  const audit = mockStmt();
  const d = mockD1(
    mockStmt({ first: { creator_id: opts.creator ?? 'gh:1' } }),
    mockStmt({ first: { contract: stored(sample) } }),
    mockStmt({ first: { manifest: JSON.stringify(sample.tools.find((t) => t.name === action)) } }),
    mockStmt({ all: { results: (opts.roles ?? ['operator']).map((role_name) => ({ role_name })) } }),
    audit,
  );
  return { d, audit };
}
let calls: { url: string; params: unknown[] }[] = [];
function dataWorker(rows: Record<string, unknown>[]) {
  calls = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
    calls.push({ url: String(url), params: (JSON.parse(String(init.body)) as { params: unknown[] }).params });
    return Response.json({ rows, meta: {} });
  }));
}
afterEach(() => vi.unstubAllGlobals());
const get = (path: string, d: ReturnType<typeof mockD1>, init: RequestInit = { headers: { Authorization: `Bearer ${OWNER}` } }) =>
  app.request(`/v1/apps/${path}`, init, makeEnv({}, d));

describe('GET /v1/apps/:appId/operator/metrics/:id (#240)', () => {
  it('binds the range to the declared params, rolls up, and audits the range but no value', async () => {
    dataWorker([
      { day: '2026-09-01', plan: 'free', signups: 5, secret: 'x' },
      { day: '2026-09-02', plan: 'pro', signups: 3 },
    ]);
    const { d, audit } = db(STASH, 'op_daily_signups');
    const res = await get('stash/operator/metrics/growth?from=2026-09-01&to=2026-09-03', d);
    expect(res.status, await res.clone().text()).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe('private, no-store');
    const body = await res.json() as Record<string, unknown>;
    expect(body).toMatchObject({ from: '2026-09-01', to: '2026-09-03', grain: 'day', buckets: ['2026-09-01', '2026-09-02', '2026-09-03'], omitted: 0 });
    expect(JSON.stringify(body)).not.toContain('secret');
    expect(calls[0]!.url).toContain('pas-data-stash.');
    expect(calls[0]!.params).toEqual(expect.arrayContaining(['2026-09-01', '2026-09-03']));
    const [app, action, actor, role, status, , operatorAction, target] = audit.bind.mock.calls[0]!;
    expect([app, action, actor, role, status, operatorAction, target]).toEqual(['stash', 'op_daily_signups', 'gh:1', 'operator', 200, 'series:growth', '2026-09-01..2026-09-03/day']);
    expect(JSON.stringify(audit.bind.mock.calls)).not.toMatch(/"5"|,5,|free|pro/);
  });

  it('validates the request before the query runs', async () => {
    for (const [qs, error] of [
      ['from=2025-01-01&to=2026-09-01', 'this metric allows at most 366'],
      ['from=2026-02-30', 'from must be a date'],
      ['from=2026-09-10&to=2026-09-01', 'from must not be after to'],
      ['to=2999-01-01', 'to must not be in the future'],
      ['grain=hour', 'grain must be one of day, week, month'],
    ] as const) {
      dataWorker([]);
      const res = await get(`stash/operator/metrics/growth?${qs}`, db(STASH, 'op_daily_signups').d);
      expect(res.status, qs).toBe(400);
      expect(await res.text(), qs).toContain(error);
      expect(calls, qs).toHaveLength(0);
    }
  });

  it('a second app (Parents Clubs) gets its own params, grain and measures; an empty range is all null', async () => {
    dataWorker([]);
    const res = await get('parents-clubs/operator/metrics/club_trends?from=2026-09-07&to=2026-09-20', db(PARENTS_CLUBS, 'op_weekly_clubs').d);
    expect(res.status, await res.clone().text()).toBe(200);
    const body = await res.json() as { grain: string; buckets: string[]; measures: { label: string; unit: string; currency: string | null; summary: unknown; series: { values: unknown[] }[] }[] };
    expect(body.grain).toBe('week');
    expect(body.buckets).toEqual(['2026-09-07', '2026-09-14']);
    expect(body.measures.map((m) => [m.label, m.unit, m.currency, m.summary, m.series[0]!.values])).toEqual([
      ['Attendance', 'percent', null, null, [null, null]],
      ['Events', 'count', null, null, [null, null]],
      ['Fees collected', 'currency', 'GBP', null, [null, null]],
    ]);
    expect(calls[0]!.url).toContain('pas-data-parents-clubs.');
    expect(calls[0]!.params).toEqual(expect.arrayContaining(['2026-09-07', '2026-09-20']));
    expect((await get('parents-clubs/operator/metrics/club_trends?grain=day', db(PARENTS_CLUBS, 'op_weekly_clubs').d)).status).toBe(400);
  });

  it('refuses signed-out callers, other owners and owners without the role; undeclared series are 404', async () => {
    dataWorker([]);
    const anon = mockD1();
    expect((await get('stash/operator/metrics/growth', anon, {})).status).toBe(401);
    expect(anon.prepare).not.toHaveBeenCalled();
    expect((await get('stash/operator/metrics/growth', mockD1(mockStmt({ first: { creator_id: 'gh:9' } }), mockStmt({ first: null })))).status).toBe(403);
    const noRole = db(STASH, 'op_daily_signups', { roles: [] });
    const refused = await get('stash/operator/metrics/growth', noRole.d);
    expect(refused.status).toBe(403);
    expect(await refused.text()).toContain('requires app role');
    expect(noRole.audit.bind).toHaveBeenCalledWith('stash', '', 'gh:1', '', 403, expect.any(Number), 'series:growth', null);
    expect((await get('stash/operator/metrics/moderation', db(STASH, 'op_report_metrics').d)).status).toBe(404); // a KPI row, not a series
    expect((await get('stash/operator/metrics/ghost', db(STASH, 'op_daily_signups').d)).status).toBe(404);
    expect((await get('parents-clubs/operator/metrics/growth', db(PARENTS_CLUBS, 'op_weekly_clubs').d)).status).toBe(404); // Stash's id
    const baseline = mockD1(mockStmt({ first: { creator_id: 'gh:1' } }), mockStmt({ first: null }));
    expect((await get('stash/operator/metrics/growth', baseline)).status).toBe(404);
    expect(calls).toHaveLength(0);
  });

  it('the plain resource route refuses a series, so its range is always bounded', async () => {
    dataWorker([]);
    const res = await get('stash/operator/resources/growth', db(STASH, 'op_daily_signups').d);
    expect(res.status).toBe(400);
    expect(await res.text()).toContain('read it from /operator/metrics/:id');
    expect(calls).toHaveLength(0);
  });
});
