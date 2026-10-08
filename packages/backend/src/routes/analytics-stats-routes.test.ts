import { afterEach, describe, expect, it, vi } from 'vitest';
import { makeEnv, mockD1, mockStmt, testToken } from '../test-helpers.js';
import { analyticsRoutes } from './analytics.js';

const CAST_EFFECTIVE_TIME = 'CAST(doubles[2] AS Int64)';
const UNSUPPORTED_DOUBLE2_CAST = 'to' + 'Int64(double2)';

afterEach(() => {
  vi.unstubAllGlobals();
});

async function requestAndCaptureSql(
  path: string,
  token: string,
  env: ReturnType<typeof makeEnv>,
): Promise<string[]> {
  const queries: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
    queries.push(String(init?.body));
    return Response.json({ data: [] });
  }));

  const response = await analyticsRoutes.request(path, {
    headers: { Authorization: `Bearer ${token}` },
  }, env);

  expect(await response.text()).toBeTruthy();
  expect(response.status).toBe(200);
  return queries;
}

function expectSupportedEffectiveTime(queries: string[]) {
  expect(queries.length).toBeGreaterThan(0);
  for (const query of queries) {
    expect(query).toContain(CAST_EFFECTIVE_TIME);
    expect(query).toContain('timestamp');
    expect(query).not.toContain(UNSUPPORTED_DOUBLE2_CAST);
  }
}

describe('analytics effective-time SQL', () => {
  it('uses the indexed doubles cast for app stats queries', async () => {
    const queries = await requestAndCaptureSql(
      '/apps/demo/analytics/stats',
      await testToken('gh:1'),
      makeEnv(
        { CF_ANALYTICS_API_TOKEN: 'analytics-token' },
        mockD1(mockStmt({ first: { creator_id: 'gh:1' } })),
      ),
    );

    expectSupportedEffectiveTime(queries);
  });

  it('uses the indexed doubles cast for app event queries', async () => {
    const queries = await requestAndCaptureSql(
      '/apps/demo/analytics/events',
      await testToken('gh:1'),
      makeEnv(
        { CF_ANALYTICS_API_TOKEN: 'analytics-token' },
        mockD1(mockStmt({ first: { creator_id: 'gh:1' } })),
      ),
    );

    expectSupportedEffectiveTime(queries);
  });

  it('uses the indexed doubles cast for platform analytics queries', async () => {
    const adminToken = await testToken('gh:1', { roles: ['admin'] });
    const queries = await requestAndCaptureSql(
      '/analytics/admin/platform',
      adminToken,
      makeEnv({ CF_ANALYTICS_API_TOKEN: 'analytics-token' }),
    );

    expectSupportedEffectiveTime(queries);
  });
});
