import { afterEach, describe, expect, it, vi } from 'vitest';
import { makeEnv, mockD1, mockStmt, testToken } from '../test-helpers.js';
import { analyticsRoutes } from './analytics.js';
import { EFFECTIVE_TIME } from './analytics-shared.js';

/**
 * #349: Analytics Engine SQL is a small, documented subset of ClickHouse. A
 * query that leaves it is refused by Cloudflare and the dashboard answers 502,
 * which a string-match on one expression (#332) could not catch. Every query
 * the analytics routes send is checked against the documented surface:
 * https://developers.cloudflare.com/analytics/analytics-engine/sql-reference/
 * https://developers.cloudflare.com/analytics/analytics-engine/sql-api/ (columns)
 */
const DOCUMENTED_FUNCTIONS = new Set([
  // aggregate
  'count', 'sum', 'avg', 'min', 'max', 'quantileexactweighted', 'quantileweighted', 'argmax', 'argmin',
  'first_value', 'last_value', 'topk', 'topkweighted', 'countif', 'sumif', 'avgif',
  // conditional
  'if',
  // date and time
  'formatdatetime', 'now', 'today', 'todatetime', 'toyear', 'tomonth', 'todayofweek', 'todayofmonth', 'tohour',
  'tominute', 'tosecond', 'tounixtimestamp', 'tostartofinterval', 'tostartofyear', 'tostartofmonth', 'tostartofweek',
  'tostartofday', 'tostartofhour', 'tostartoffifteenminutes', 'tostartoftenminutes', 'tostartoffiveminutes',
  'tostartofminute', 'toyyyymm',
  // type conversion
  'touint8', 'touint32',
]);
/** SQL words that are followed by `(` without being a function call. */
const KEYWORDS = new Set(['in', 'and', 'or', 'not', 'from', 'where', 'as', 'select']);
/** A dataset has these columns only: no `doubles` / `blobs` arrays. */
const NUMBERED_COLUMN = /\b(blob|double)(\d+)\b/g;

function unsupported(sql: string): string[] {
  const code = sql.replace(/'(?:[^'\\]|\\.|'')*'/g, "''"); // literals cannot hold calls or columns
  const problems: string[] = [];
  for (const [, fn] of code.matchAll(/\b([A-Za-z_][A-Za-z0-9_]*)\s*\(/g)) {
    if (!KEYWORDS.has(fn!.toLowerCase()) && !DOCUMENTED_FUNCTIONS.has(fn!.toLowerCase())) problems.push(`function ${fn}`);
  }
  for (const [, kind, n] of code.matchAll(NUMBERED_COLUMN)) if (Number(n) < 1 || Number(n) > 20) problems.push(`column ${kind}${n}`);
  if (/\b(doubles|blobs)\b/.test(code)) problems.push('array column (doubles/blobs)');
  if (/\[/.test(code)) problems.push('array indexing');
  if (/\bCAST\s*\(/i.test(code)) problems.push('CAST');
  return problems;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

async function requestAndCaptureSql(path: string, token: string, env: ReturnType<typeof makeEnv>): Promise<string[]> {
  const queries: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
    queries.push(String(init?.body));
    return Response.json({ data: [] });
  }));
  const response = await analyticsRoutes.request(path, { headers: { Authorization: `Bearer ${token}` } }, env);
  expect(response.status, await response.clone().text()).toBe(200);
  return queries;
}

const owner = () => makeEnv({ CF_ANALYTICS_API_TOKEN: 'analytics-token' }, mockD1(mockStmt({ first: { creator_id: 'gh:1' } })));

describe('analytics SQL stays inside Analytics Engine SQL (#349)', () => {
  it('the guard rejects every form the effective time took before', () => {
    expect(unsupported('SELECT 1 WHERE if(length(doubles) > 1, fromUnixTimestamp64Milli(toInt64(double2)), timestamp) > NOW()')).toEqual(
      expect.arrayContaining(['function length', 'function fromUnixTimestamp64Milli', 'function toInt64', 'array column (doubles/blobs)']),
    );
    expect(unsupported('SELECT if(length(doubles) > 1, fromUnixTimestamp64Milli(CAST(doubles[2] AS Int64)), timestamp)')).toEqual(
      expect.arrayContaining(['CAST', 'array indexing', 'array column (doubles/blobs)']),
    );
    expect(unsupported(`SELECT ${EFFECTIVE_TIME}`)).toEqual([]);
  });

  it('the effective time is the client time in epoch seconds when recorded, else the write time', () => {
    expect(EFFECTIVE_TIME).toBe('if(double2 > 0, toDateTime(toUInt32(double2 / 1000)), timestamp)');
  });

  for (const [what, path, admin] of [
    ['stats (day buckets)', '/apps/demo/analytics/stats', false],
    ['stats (hour buckets, a page and a custom kind)', "/apps/demo/analytics/stats?days=1&kind=signup&path=%2Fa'b%5C", false],
    ['custom events', '/apps/demo/analytics/events', false],
    ['live view', '/apps/demo/analytics/live', false],
    ['platform aggregate', '/analytics/admin/platform', true],
    ['per-app usage', '/analytics/admin/apps', true],
  ] as const) {
    it(`${what}: every query uses only documented functions and columns`, async () => {
      const token = admin ? await testToken('gh:1', { roles: ['admin'] }) : await testToken('gh:1');
      const queries = await requestAndCaptureSql(path, token, admin ? makeEnv({ CF_ANALYTICS_API_TOKEN: 'analytics-token' }) : owner());
      expect(queries.length).toBeGreaterThan(0);
      for (const q of queries) expect(unsupported(q), q).toEqual([]);
    });
  }

  it('stats, events and the platform aggregate filter and bucket on the effective time', async () => {
    for (const [path, admin] of [['/apps/demo/analytics/stats', false], ['/apps/demo/analytics/events', false], ['/analytics/admin/platform', true], ['/analytics/admin/apps', true]] as const) {
      const token = admin ? await testToken('gh:1', { roles: ['admin'] }) : await testToken('gh:1');
      const queries = await requestAndCaptureSql(path, token, admin ? makeEnv({ CF_ANALYTICS_API_TOKEN: 'analytics-token' }) : owner());
      for (const q of queries) expect(q, path).toContain(`${EFFECTIVE_TIME} > NOW() - INTERVAL`);
    }
  });
});

describe('GET /analytics/admin/apps (#417)', () => {
  const get = async (path: string, token: string | null, env: ReturnType<typeof makeEnv>) =>
    analyticsRoutes.request(path, token ? { headers: { Authorization: `Bearer ${token}` } } : {}, env);

  it('refuses anonymous callers (401) and non-admins (403) before querying Analytics Engine', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const env = makeEnv({ CF_ANALYTICS_API_TOKEN: 'analytics-token' });
    expect((await get('/analytics/admin/apps', null, env)).status).toBe(401);
    expect((await get('/analytics/admin/apps', await testToken('gh:1'), env)).status).toBe(403);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('lists every registered app, zero-view apps included, with per-app and platform totals and daily series', async () => {
    const sqls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
      const sql = String(init?.body);
      sqls.push(sql);
      if (sql.includes('NOT IN')) return Response.json({ data: [{ views: 1, ids: 1 }] }); // 'gone': no longer registered
      return Response.json({ data: [
        { app: 'notes', t: '2026-10-16 00:00:00', views: 3 },
        { app: 'crm', t: '2026-10-16 00:00:00', views: '10' },
        { app: 'notes', t: '2026-10-17 00:00:00', views: 4 },
      ] });
    }));
    const db = mockD1(mockStmt({ all: { results: [{ id: 'crm' }, { id: 'notes' }, { id: 'quiet' }] } }));
    const res = await get('/analytics/admin/apps?days=30', await testToken('gh:1', { roles: ['admin'] }), makeEnv({ CF_ANALYTICS_API_TOKEN: 'analytics-token' }, db));
    expect(res.status).toBe(200);
    expect(sqls).toHaveLength(2);
    for (const sql of sqls) { expect(sql).toContain("INTERVAL '30' DAY"); expect(sql).toContain("blob2 = 'pageview'"); }
    expect(await res.json()).toEqual({
      days: 30,
      totals: { views: 17, apps: 3, apps_with_views: 2, apps_without_views: 1 },
      unregistered: { app_ids: 1, views: 1 },
      truncated: false,
      series: [{ t: '2026-10-16 00:00:00', views: 13 }, { t: '2026-10-17 00:00:00', views: 4 }],
      apps: [
        { app_id: 'crm', registered: true, views: 10, series: [{ t: '2026-10-16 00:00:00', views: 10 }] },
        { app_id: 'notes', registered: true, views: 7, series: [{ t: '2026-10-16 00:00:00', views: 3 }, { t: '2026-10-17 00:00:00', views: 4 }] },
        { app_id: 'quiet', registered: true, views: 0, series: [] },
      ],
    });
  });

  it('#444: fabricated app ids never inflate the app counts or the list; the query is bounded to registered ids', async () => {
    const sqls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
      const sql = String(init?.body);
      sqls.push(sql);
      // A well-behaved Analytics Engine applies the IN / NOT IN filter; the endpoint must be sending them.
      if (sql.includes('NOT IN')) return Response.json({ data: [{ views: '5000', ids: '5000' }] });
      return Response.json({ data: [{ app: 'crm', t: '2026-10-16 00:00:00', views: 2 }] });
    }));
    const db = mockD1(mockStmt({ all: { results: [{ id: 'crm' }, { id: 'quiet' }] } }));
    const res = await get('/analytics/admin/apps', await testToken('gh:1', { roles: ['admin'] }), makeEnv({ CF_ANALYTICS_API_TOKEN: 'analytics-token' }, db));
    const body = await res.json() as { totals: Record<string, number>; unregistered: Record<string, number>; apps: { app_id: string }[] };
    expect(body.totals).toEqual({ views: 2, apps: 2, apps_with_views: 1, apps_without_views: 1 });
    expect(body.unregistered).toEqual({ app_ids: 5000, views: 5000 });
    expect(body.apps.map((a) => a.app_id)).toEqual(['crm', 'quiet']);
    expect(sqls.find((s) => !s.includes('NOT IN'))).toContain("blob1 IN ('crm', 'quiet')");
    expect(sqls.find((s) => s.includes('NOT IN'))).toContain("blob1 NOT IN ('crm', 'quiet')");
  });

  it('#444: even if the store returns ids outside the registry they are dropped, and the registry read is capped', async () => {
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) =>
      Response.json({ data: String(init?.body).includes('NOT IN') ? [] : [{ app: 'fake-1', t: 'd', views: 9 }, { app: 'crm', t: 'd', views: 1 }] })));
    const stmt = mockStmt({ all: { results: [{ id: 'crm' }] } });
    const res = await get('/analytics/admin/apps', await testToken('gh:1', { roles: ['admin'] }), makeEnv({ CF_ANALYTICS_API_TOKEN: 'analytics-token' }, mockD1(stmt)));
    const body = await res.json() as { totals: Record<string, number>; apps: unknown[]; unregistered: Record<string, number> };
    expect(body.totals).toMatchObject({ views: 1, apps: 1 });
    expect(body.apps).toHaveLength(1);
    expect(body.unregistered).toEqual({ app_ids: 0, views: 0 });
    expect(stmt.bind).toHaveBeenCalledWith(1001);
  });

  it('answers 503 when the analytics token is not configured', async () => {
    const res = await get('/analytics/admin/apps', await testToken('gh:1', { roles: ['admin'] }), makeEnv());
    expect(res.status).toBe(503);
  });
});
