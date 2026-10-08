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
  ] as const) {
    it(`${what}: every query uses only documented functions and columns`, async () => {
      const token = admin ? await testToken('gh:1', { roles: ['admin'] }) : await testToken('gh:1');
      const queries = await requestAndCaptureSql(path, token, admin ? makeEnv({ CF_ANALYTICS_API_TOKEN: 'analytics-token' }) : owner());
      expect(queries.length).toBeGreaterThan(0);
      for (const q of queries) expect(unsupported(q), q).toEqual([]);
    });
  }

  it('stats, events and the platform aggregate filter and bucket on the effective time', async () => {
    for (const [path, admin] of [['/apps/demo/analytics/stats', false], ['/apps/demo/analytics/events', false], ['/analytics/admin/platform', true]] as const) {
      const token = admin ? await testToken('gh:1', { roles: ['admin'] }) : await testToken('gh:1');
      const queries = await requestAndCaptureSql(path, token, admin ? makeEnv({ CF_ANALYTICS_API_TOKEN: 'analytics-token' }) : owner());
      for (const q of queries) expect(q, path).toContain(`${EFFECTIVE_TIME} > NOW() - INTERVAL`);
    }
  });
});
