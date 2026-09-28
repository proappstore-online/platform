import { describe, expect, it } from 'vitest';
import { app } from '../index.js';
import { makeEnv, mockD1, mockStmt, testToken } from '../test-helpers.js';
import { validateOperatorView } from '../lib/operator-contract.js';
import type { ToolManifest } from '../lib/action-sql.js';
import { PARENTS_CLUBS, STASH } from '../__fixtures__/operator-view.js';

// #240: the console operator view is owner-only. Every refusal must happen
// before any of the app's data is read.

const OWNER = await testToken('gh:1');
const auth = (token: string) => ({ headers: { Authorization: `Bearer ${token}` } });
const get = (appId: string, init: RequestInit, db: ReturnType<typeof mockD1>) =>
  app.request(`/v1/apps/${appId}/operator`, init, makeEnv({}, db));

const readsAppData = (db: ReturnType<typeof mockD1>) =>
  db.prepare.mock.calls.some(([sql]) => /app_roles|usage_daily|app_operator_view|SELECT id, created_at/.test(String(sql)));

describe('GET /v1/apps/:appId/operator (#240)', () => {
  it('returns the baseline context to the app owner, private and uncached', async () => {
    const appRow = mockStmt({ first: { id: 'stash', created_at: 1_700_000_000_000 } });
    const roles = mockStmt({ first: { users: 4 } });
    const usage = mockStmt({ first: { users: 7, session_seconds: 3600, api_calls: 120 } });
    const db = mockD1(mockStmt({ first: { creator_id: 'gh:1' } }), appRow, roles, usage);

    const res = await get('stash', auth(OWNER), db);
    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe('private, no-store');
    expect(await res.json()).toEqual({
      app: { id: 'stash', createdAt: 1_700_000_000_000 },
      operator: { userId: 'gh:1', login: 'testuser' },
      baseline: {
        usersWithRoles: 4,
        activity: { days: 30, activeUsers: 7, sessionSeconds: 3600, apiCalls: 120 },
      },
      contract: null,
    });
    // Every data query is scoped to the requested app.
    for (const stmt of [appRow, roles, usage]) expect(stmt.bind.mock.calls[0]![0]).toBe('stash');
  });

  it('refuses an unauthenticated caller with 401 before touching the database', async () => {
    const db = mockD1();
    const res = await get('stash', {}, db);
    expect(res.status).toBe(401);
    expect(db.prepare).not.toHaveBeenCalled();
  });

  it('refuses a forged or expired token with 401', async () => {
    const db = mockD1();
    const res = await get('stash', auth('not-a-session'), db);
    expect(res.status).toBe(401);
    expect(db.prepare).not.toHaveBeenCalled();
  });

  it("refuses another app's owner: owning one app grants nothing on another", async () => {
    // gh:1 owns bingo, asks for stash (owned by gh:9, no team membership).
    const db = mockD1(mockStmt({ first: { creator_id: 'gh:9' } }), mockStmt({ first: null }));
    const res = await get('stash', auth(OWNER), db);
    expect(res.status).toBe(403);
    expect(readsAppData(db)).toBe(false);
  });

  it('refuses a team member below owner (e.g. admin/developer)', async () => {
    for (const role of ['viewer', 'developer', 'admin']) {
      const db = mockD1(mockStmt({ first: { creator_id: 'gh:9' } }), mockStmt({ first: { role } }));
      const res = await get('stash', auth(OWNER), db);
      expect(res.status, role).toBe(403);
      expect(readsAppData(db)).toBe(false);
    }
  });

  it('answers 404 for an unknown app without reading app data', async () => {
    const db = mockD1(mockStmt({ first: null }));
    const res = await get('ghost', auth(OWNER), db);
    expect(res.status).toBe(404);
    expect(readsAppData(db)).toBe(false);
  });

  it("returns each app's own stored contract to its owner, so the console renders any app generically", async () => {
    for (const [appId, sample] of [['stash', STASH], ['parents-clubs', PARENTS_CLUBS]] as const) {
      const stored = validateOperatorView(sample.tools as ToolManifest[], sample.operator_view);
      if (!('contract' in stored)) throw new Error(stored.error);
      const view = mockStmt({ first: { contract: JSON.stringify(stored.contract) } });
      const db = mockD1(mockStmt({ first: { creator_id: 'gh:1' } }), mockStmt(), mockStmt(), mockStmt(), view);
      const res = await get(appId, auth(OWNER), db);
      expect(res.status).toBe(200);
      expect(((await res.json()) as { contract: unknown }).contract).toEqual(stored.contract);
      expect(view.bind.mock.calls[0]![0]).toBe(appId);
    }
  });

  it('falls back to the baseline when a stored contract is unreadable', async () => {
    const db = mockD1(mockStmt({ first: { creator_id: 'gh:1' } }), mockStmt(), mockStmt(), mockStmt(), mockStmt({ first: { contract: '{not json' } }));
    const res = await get('stash', auth(OWNER), db);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { contract: unknown }).contract).toBeNull();
  });
});
