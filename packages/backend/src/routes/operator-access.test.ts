import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { app } from '../index.js';
import { mintSession } from '@proappstore/build-core';
import { TEST_SK, makeEnv, mockD1, mockStmt, testToken } from '../test-helpers.js';
import { validateOperatorView } from '../lib/operator-contract.js';
import type { ToolManifest } from '../lib/action-sql.js';
import { STASH } from '../__fixtures__/operator-view.js';
import { operatorView } from './operator-view.js';

// #240 / #293 regression: every console operator route refuses every caller who
// is neither the owner nor a holder of a declared admin role. One table, every
// route × every such caller: the refusal happens at the gate — the ownership
// check, then the admin-role lookup — before the contract's resources, app data,
// the data worker or R2 is touched, and writes no audit row, so a stranger can
// neither read an app nor fill its trail.

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
  { method: 'GET', pattern: '/apps/:appId/operator/users', path: '/v1/apps/stash/operator/users' },
];

/** stash is created by gh:9; the callers below are all gh:1 unless a team row says otherwise. */
const ownerGate = (team: { role: string } | null) =>
  mockD1(mockStmt({ first: { creator_id: 'gh:9' } }), mockStmt({ first: team }));

const OWNER_GATE_SQL = /SELECT creator_id FROM apps WHERE id = \?|SELECT role FROM team_members WHERE app_id = \? AND user_id = \?/;
/** #293: the admin gate's one extra read — the declared admin_access roles joined to the caller's app roles. */
const ADMIN_GATE_SQL = /FROM app_operator_view v, json_each\(v\.contract, '\$\.admin_access\.roles'\)/;
const GATE_SQL = new RegExp(`${OWNER_GATE_SQL.source}|${ADMIN_GATE_SQL.source}`);
/** The routes the admin gate opens (#293); the audit trail and the platform users list stay owner-only. */
const OWNER_ONLY = new Set(['/apps/:appId/operator/audit', '/apps/:appId/operator/users']);

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

describe('operator routes refuse every caller who is not the owner or a declared admin (#240/#293 regression matrix)', () => {
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
          // Only the gate ran: no contract resources, app data or audit query.
          expect(sql.length).toBeGreaterThan(0);
          for (const s of sql) expect(s).toMatch(GATE_SQL);
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

// #293: the admin role gate. A non-owner who holds one of the contract's
// admin_access roles is admitted to every route but the audit trail and the
// platform users list; the role is read per request with #272's role subject.
describe('admin role gate (#293)', () => {
  /** Not the creator, no team row, and the admin-role lookup answers `holds`. */
  const adminGate = (holds: boolean) =>
    mockD1(mockStmt({ first: { creator_id: 'gh:9' } }), mockStmt({ first: null }), mockStmt({ first: holds ? { 1: 1 } : null }));

  for (const route of ROUTES.filter((r) => !OWNER_ONLY.has(r.pattern))) {
    it(`${route.method} ${route.pattern}: a holder of a declared admin role passes the gate`, async () => {
      const db = adminGate(true);
      const res = await request(route, await testToken('gh:1'), db, { get: vi.fn() });
      expect([401, 403]).not.toContain(res.status);
      const sql = db.prepare.mock.calls.map(([s]) => String(s));
      expect(sql.some((s) => ADMIN_GATE_SQL.test(s))).toBe(true);
    });
  }

  for (const route of ROUTES.filter((r) => OWNER_ONLY.has(r.pattern))) {
    it(`${route.method} ${route.pattern}: stays owner-only for an admin, without consulting admin_access`, async () => {
      const db = adminGate(true);
      const res = await request(route, await testToken('gh:1'), db, { get: vi.fn() });
      expect(res.status).toBe(403);
      const sql = db.prepare.mock.calls.map(([s]) => String(s));
      expect(sql.some((s) => ADMIN_GATE_SQL.test(s))).toBe(false);
      expect(sql.some((s) => /app_action_audit/.test(s))).toBe(false);
    });
  }

  it('refuses a caller whose roles are not declared, with a clear error and no audit row', async () => {
    const db = adminGate(false);
    const res = await request(ROUTES[0]!, await testToken('gh:1'), db, { get: vi.fn() });
    expect(res.status).toBe(403);
    expect(await res.text()).toContain("the operator view needs the app owner or one of the app's admin roles");
    expect(db.prepare.mock.calls.some(([s]) => /app_action_audit/.test(String(s)))).toBe(false);
  });

  it('binds the canonical role subject: a GitHub login alias, never a credential or Google login (#272)', async () => {
    const bindsFor = async (uid: string, login: string) => {
      const db = adminGate(false);
      await request(ROUTES[0]!, await testToken(uid, { login }), db, { get: vi.fn() });
      const i = db.prepare.mock.calls.findIndex(([s]) => ADMIN_GATE_SQL.test(String(s)));
      return db.prepare.mock.results[i]!.value.bind.mock.calls[0];
    };
    expect(await bindsFor('gh:1', 'ada')).toEqual(['stash', 'gh:1', 'ada']);
    // A credential or Google account named like an admin's GitHub login or id matches on its own id only.
    expect(await bindsFor('cred:x', 'ada')).toEqual(['stash', 'cred:x', 'cred:x']);
    expect(await bindsFor('google:y', 'gh:1')).toEqual(['stash', 'google:y', 'google:y']);
  });
});
