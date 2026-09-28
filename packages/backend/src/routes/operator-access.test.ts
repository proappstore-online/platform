import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { app } from '../index.js';
import { mintSession } from '@proappstore/build-core';
import { TEST_SK, makeEnv, mockD1, mockStmt, testToken } from '../test-helpers.js';
import { validateOperatorView } from '../lib/operator-contract.js';
import type { ToolManifest } from '../lib/action-sql.js';
import { STASH } from '../__fixtures__/operator-view.js';
import { operatorView } from './operator-view.js';

// #240 regression: every console operator route is owner-only. One table, every
// route × every non-owner caller: the refusal happens at the ownership check —
// before the contract, app data, the data worker or R2 is touched — and writes
// no audit row, so a stranger can neither read an app nor fill its trail.

type Route = { method: 'GET' | 'POST'; pattern: string; path: string; body?: unknown };

const ROUTES: Route[] = [
  { method: 'GET', pattern: '/apps/:appId/operator', path: '/v1/apps/stash/operator' },
  { method: 'GET', pattern: '/apps/:appId/operator/resources/:resourceId', path: '/v1/apps/stash/operator/resources/members' },
  { method: 'GET', pattern: '/apps/:appId/operator/resources/:resourceId/records/:key', path: '/v1/apps/stash/operator/resources/members/records/u001' },
  {
    method: 'GET', pattern: '/apps/:appId/operator/resources/:resourceId/records/:key/evidence/:field',
    path: '/v1/apps/stash/operator/resources/kyc/records/k1/evidence/document_path',
  },
  {
    method: 'POST', pattern: '/apps/:appId/operator/actions/:actionId', path: '/v1/apps/stash/operator/actions/suspend_member',
    body: { row: { user_id: 'u001' } },
  },
  { method: 'GET', pattern: '/apps/:appId/operator/metrics/:resourceId', path: '/v1/apps/stash/operator/metrics/growth' },
  { method: 'POST', pattern: '/apps/:appId/operator/entries', path: '/v1/apps/stash/operator/entries', body: { visit: 'visit-0001' } },
  { method: 'GET', pattern: '/apps/:appId/operator/audit', path: '/v1/apps/stash/operator/audit' },
];

/** stash is created by gh:9; the callers below are all gh:1 unless a team row says otherwise. */
const ownerGate = (team: { role: string } | null) =>
  mockD1(mockStmt({ first: { creator_id: 'gh:9' } }), mockStmt({ first: team }));

const OWNER_GATE_SQL = /SELECT creator_id FROM apps WHERE id = \?|SELECT role FROM team_members WHERE app_id = \? AND user_id = \?/;

type Caller = { name: string; token: () => Promise<string | null>; db: () => ReturnType<typeof mockD1>; status: 401 | 403; readsDb: boolean };

const CALLERS: Caller[] = [
  { name: 'signed out', token: async () => null, db: () => mockD1(), status: 401, readsDb: false },
  { name: 'forged token', token: async () => 'not-a-session', db: () => mockD1(), status: 401, readsDb: false },
  {
    name: 'expired session', token: () => mintSession({ uid: 'gh:1', login: 'testuser', roles: ['user'] }, TEST_SK, -60),
    db: () => mockD1(), status: 401, readsDb: false,
  },
  {
    name: 'session signed with another key', token: () => mintSession({ uid: 'gh:1', login: 'testuser', roles: ['user'] }, 'not-the-signing-key'),
    db: () => mockD1(), status: 401, readsDb: false,
  },
  { name: "another app's owner", token: () => testToken('gh:1'), db: () => ownerGate(null), status: 403, readsDb: true },
  ...['viewer', 'po', 'developer', 'admin'].map((role): Caller => ({
    name: `team ${role}`, token: () => testToken('gh:1'), db: () => ownerGate({ role }), status: 403, readsDb: true,
  })),
];

function request(route: Route, token: string | null, db: ReturnType<typeof mockD1>, storage: { get: ReturnType<typeof vi.fn> }) {
  const headers: Record<string, string> = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (route.body !== undefined) headers['Content-Type'] = 'application/json';
  return app.request(
    route.path,
    { method: route.method, headers, ...(route.body !== undefined ? { body: JSON.stringify(route.body) } : {}) },
    makeEnv({ STORAGE: storage }, db),
  );
}

let fetches: string[];
beforeEach(() => {
  fetches = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    fetches.push(String(url));
    return Response.json({ rows: [], meta: {} });
  }));
});
afterEach(() => vi.unstubAllGlobals());

describe('operator routes are owner-only (#240 regression matrix)', () => {
  it('the matrix covers every route the operator view mounts', () => {
    const mounted = new Set(
      operatorView.routes.filter((r) => r.method !== 'ALL').map((r) => `${r.method} ${r.path}`),
    );
    expect(mounted).toEqual(new Set(ROUTES.map((r) => `${r.method} ${r.pattern}`)));
  });

  for (const route of ROUTES) {
    for (const caller of CALLERS) {
      it(`${route.method} ${route.pattern}: ${caller.name} → ${caller.status}, nothing read or written`, async () => {
        const db = caller.db();
        const storage = { get: vi.fn() };
        const res = await request(route, await caller.token(), db, storage);

        expect(res.status).toBe(caller.status);
        const sql = db.prepare.mock.calls.map(([s]) => String(s));
        if (caller.readsDb) {
          // Only the ownership check ran: no contract, app data, role or audit query.
          expect(sql.length).toBeGreaterThan(0);
          for (const s of sql) expect(s).toMatch(OWNER_GATE_SQL);
        } else {
          expect(db.prepare).not.toHaveBeenCalled();
        }
        expect(sql.some((s) => /app_action_audit|storage_review_access/.test(s))).toBe(false);
        expect(fetches).toEqual([]);
        expect(storage.get).not.toHaveBeenCalled();
      });
    }
  }

  // A platform admin is admitted by the ownership check by design (requireAppAccess
  // treats `admin` as owner), so it is not in the refusal matrix above. What it
  // must NOT get is the app's own data: the app-role gate still applies.
  for (const route of ROUTES) {
    it(`${route.method} ${route.pattern}: a platform admin passes the ownership check`, async () => {
      const token = await testToken('gh:7', { roles: ['user', 'admin'] });
      const db = mockD1();
      const res = await request(route, token, db, { get: vi.fn() });
      expect([401, 403]).not.toContain(res.status);
      // Admitted without a creator/team lookup.
      expect(db.prepare.mock.calls.map(([s]) => String(s)).some((s) => OWNER_GATE_SQL.test(s))).toBe(false);
    });
  }

  it('a platform admin without the declared app role is refused before the data worker', async () => {
    const r = validateOperatorView(STASH.tools as ToolManifest[], STASH.operator_view);
    if (!('contract' in r)) throw new Error(r.error);
    const manifest = STASH.tools.find((t) => t.name === 'op_list_users')!;
    const db = mockD1(
      mockStmt({ first: { contract: JSON.stringify(r.contract) } }),
      mockStmt({ first: { manifest: JSON.stringify(manifest) } }),
      mockStmt({ all: { results: [] } }),
    );
    const token = await testToken('gh:7', { roles: ['user', 'admin'] });
    const res = await request(ROUTES[1]!, token, db, { get: vi.fn() });
    expect(res.status).toBe(403);
    expect(await res.text()).toContain('requires app role');
    expect(fetches).toEqual([]);
  });
});
