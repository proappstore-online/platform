import { afterEach, describe, expect, it, vi } from 'vitest';
import { app } from '../index.js';
import { mintSession } from '@proappstore/build-core';
import { TEST_SK, makeEnv, mockD1, mockStmt, testToken } from '../test-helpers.js';
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

// #240 slice 3: reads of declared resources — owner-only, gated by the app's own
// action roles and step_up, projected to the declared fields, isolated per app.
describe('GET /v1/apps/:appId/operator/resources/* (#240 slice 3)', () => {
  const contractOf = (sample: typeof STASH | typeof PARENTS_CLUBS) => {
    const r = validateOperatorView(sample.tools as ToolManifest[], sample.operator_view);
    if (!('contract' in r)) throw new Error(r.error);
    return r.contract!;
  };
  const tool = (sample: typeof STASH | typeof PARENTS_CLUBS, name: string, patch: Record<string, unknown> = {}) =>
    ({ ...sample.tools.find((t) => t.name === name)!, ...patch });

  /** owner check → contract → action manifest → app-role lookup → (audit insert). */
  function db(opts: { sample?: typeof STASH | typeof PARENTS_CLUBS; action: string; creator?: string; roles?: string[]; patch?: Record<string, unknown>; contract?: unknown }) {
    const sample = opts.sample ?? STASH;
    const audit = mockStmt();
    const d = mockD1(
      mockStmt({ first: { creator_id: opts.creator ?? 'gh:1' } }),
      mockStmt({ first: opts.contract === null ? null : { contract: JSON.stringify(opts.contract ?? contractOf(sample)) } }),
      mockStmt({ first: { manifest: JSON.stringify(tool(sample, opts.action, opts.patch)) } }),
      mockStmt({ all: { results: (opts.roles ?? ['operator']).map((role_name) => ({ role_name })) } }),
      audit,
    );
    return { d, audit };
  }
  let dataCalls: { url: string; body: { sql: string; params: unknown[] } }[] = [];
  function dataWorker(rows: Record<string, unknown>[] | (() => Response)) {
    dataCalls = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
      dataCalls.push({ url: String(url), body: JSON.parse(String(init.body)) });
      return typeof rows === 'function' ? rows() : Response.json({ rows, meta: {} });
    }));
  }
  afterEach(() => vi.unstubAllGlobals());

  const member = (i: number) => ({ user_id: `u${String(i).padStart(3, '0')}`, display_name: `Member ${i}`, created_at: 1, suspended: 0, email: `m${i}@x.test`, password_hash: 'secret' });
  const list = (appId: string, qs: string, d: ReturnType<typeof mockD1>, init: RequestInit = auth(OWNER)) =>
    app.request(`/v1/apps/${appId}/operator/resources/${qs}`, init, makeEnv({}, d));

  it('returns only declared columns, with next_cursor from the last row of a full page', async () => {
    dataWorker(Array.from({ length: 50 }, (_, i) => member(i + 1)));
    const { d, audit } = db({ action: 'op_list_users' });
    const res = await list('stash', 'members', d);
    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe('private, no-store');
    const body = (await res.json()) as { rows: Record<string, unknown>[]; next_cursor: string | null };
    expect(body.rows).toHaveLength(50);
    expect(body.rows[0]).toEqual({ display_name: 'Member 1', user_id: 'u001', created_at: 1, suspended: 0 });
    expect(JSON.stringify(body)).not.toMatch(/password_hash|secret|email/);
    expect(body.next_cursor).toBe('u050');
    expect(dataCalls[0]!.url).toContain('pas-data-stash.');
    // Role-granted success is audited like the actions route.
    expect(audit.bind).toHaveBeenCalledWith('stash', 'op_list_users', 'gh:1', 'operator', 200, expect.any(Number), 'read:members', null);
  });

  it('passes search text and cursor to the declared params; a short page ends paging', async () => {
    dataWorker([member(51)]);
    const res = await list('stash', 'members?q=%20Ada%20&cursor=u050', db({ action: 'op_list_users' }).d);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { next_cursor: unknown }).next_cursor).toBeNull();
    expect(dataCalls[0]!.body.params).toEqual(expect.arrayContaining(['Ada', 'u050']));
  });

  it('refuses search/cursor a resource does not declare, and oversized input', async () => {
    for (const [qs, error] of [
      ['moderation?q=x', 'resource is not searchable'],
      ['moderation?cursor=x', 'resource is not paged'],
      [`members?q=${'a'.repeat(101)}`, 'q is too long'],
      [`members?cursor=${'a'.repeat(201)}`, 'cursor is too long'],
    ] as const) {
      dataWorker([]);
      const res = await list('stash', qs, db({ action: 'op_list_users' }).d);
      expect(res.status, qs).toBe(400);
      expect(await res.text(), qs).toContain(error);
      expect(dataCalls).toHaveLength(0);
    }
  });

  it('refuses a signed-out caller, another owner and a lesser team role before reading the contract', async () => {
    dataWorker([member(1)]);
    const anon = mockD1();
    expect((await list('stash', 'members', anon, {})).status).toBe(401);
    expect(anon.prepare).not.toHaveBeenCalled();
    const other = mockD1(mockStmt({ first: { creator_id: 'gh:9' } }), mockStmt({ first: null }));
    expect((await list('stash', 'members', other)).status).toBe(403);
    const admin = mockD1(mockStmt({ first: { creator_id: 'gh:9' } }), mockStmt({ first: { role: 'admin' } }));
    expect((await app.request('/v1/apps/stash/operator/resources/members/records/u001', auth(OWNER), makeEnv({}, admin))).status).toBe(403);
    for (const d of [other, admin]) expect(readsAppData(d)).toBe(false);
    expect(dataCalls).toHaveLength(0);
  });

  it("enforces the app's declared role: an owner without it is refused, unaudited, before the data worker", async () => {
    dataWorker([member(1)]);
    const { d, audit } = db({ action: 'op_list_users', roles: [] });
    const res = await list('stash', 'members', d);
    expect(res.status).toBe(403);
    expect(await res.text()).toContain('requires app role');
    expect(dataCalls).toHaveLength(0);
    expect(audit.bind).not.toHaveBeenCalled();
  });

  it('keeps the baseline and isolates apps: no contract, undeclared or other-app resources are 404', async () => {
    dataWorker([]);
    const none = mockD1(mockStmt({ first: { creator_id: 'gh:1' } }), mockStmt({ first: null }));
    expect((await list('stash', 'members', none)).status).toBe(404);
    // `members` is Stash's resource; Parents Clubs' contract does not declare it.
    const cross = mockD1(mockStmt({ first: { creator_id: 'gh:1' } }), mockStmt({ first: { contract: JSON.stringify(contractOf(PARENTS_CLUBS)) } }));
    expect((await list('parents-clubs', 'members', cross)).status).toBe(404);
    expect(dataCalls).toHaveLength(0);
  });

  it('a failing data worker is a 502, not a pass-through of its body', async () => {
    dataWorker(() => new Response('boom: SELECT * FROM members', { status: 500 }));
    const res = await list('stash', 'members', db({ action: 'op_list_users' }).d);
    expect(res.status).toBe(502);
    expect(await res.text()).not.toContain('SELECT');
  });

  it('detail: hands the key to the declared param and returns only the declared fields', async () => {
    dataWorker([member(7)]);
    const res = await app.request('/v1/apps/stash/operator/resources/members/records/u007', auth(OWNER), makeEnv({}, db({ action: 'op_member_detail' }).d));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { record: Record<string, unknown> };
    expect(Object.keys(body.record)).toEqual(['display_name', 'user_id', 'email', 'pocket_count', 'created_at']);
    expect(body.record.pocket_count).toBeNull(); // declared but absent from the row → null
    expect(JSON.stringify(body)).not.toMatch(/password_hash|secret/);
    expect(dataCalls[0]!.body.params).toEqual(['u007']);
  });

  it('detail: 404 when not found or not declared, and step_up is enforced', async () => {
    dataWorker([]);
    const missing = await app.request('/v1/apps/stash/operator/resources/members/records/nobody', auth(OWNER), makeEnv({}, db({ action: 'op_member_detail' }).d));
    expect(missing.status).toBe(404);
    const noDetail = await app.request('/v1/apps/stash/operator/resources/open_reports/records/r1', auth(OWNER), makeEnv({}, db({ action: 'op_list_reports' }).d));
    expect(noDetail.status).toBe(404);
    // A detail action declaring step_up refuses a session with no recent auth_time — before the data worker.
    dataWorker([member(7)]);
    const stale = await app.request('/v1/apps/stash/operator/resources/members/records/u007', auth(OWNER), makeEnv({}, db({ action: 'op_member_detail', patch: { step_up: true } }).d));
    expect(stale.status).toBe(403);
    expect(await stale.text()).toContain('step_up_required');
    expect(dataCalls).toHaveLength(0);
  });

  it('a second app (Parents Clubs) is served by the same routes with its own shape', async () => {
    dataWorker([{ user_id: 'p1', full_name: 'Grace', club_name: 'Chess', verified: 1, phone: '555' }]);
    const res = await list('parents-clubs', 'parents?q=gra', db({ sample: PARENTS_CLUBS, action: 'op_list_parents' }).d);
    expect(await res.json()).toEqual({ rows: [{ full_name: 'Grace', club_name: 'Chess', verified: 1, user_id: 'p1' }], next_cursor: null });
    expect(dataCalls[0]!.url).toContain('pas-data-parents-clubs.');
    dataWorker([{ user_id: 'p1', full_name: 'Grace', phone: '555', club_name: 'Chess', joined_at: 5 }]);
    const detail = await app.request('/v1/apps/parents-clubs/operator/resources/parents/records/p1', auth(OWNER),
      makeEnv({}, db({ sample: PARENTS_CLUBS, action: 'op_parent_detail' }).d));
    expect(await detail.json()).toEqual({ record: { full_name: 'Grace', club_name: 'Chess', joined_at: 5 } });
  });
});

// #240 reports & suspensions: status filters, related history, and declared row
// actions through POST /operator/actions/:id — owner-only, params from declared
// columns only, transitions checked here and guarded in the app's SQL, the
// action's own roles and step_up, and an audit row naming action and target.
describe('operator reports & suspensions (#240)', () => {
  const stored = (sample: typeof STASH | typeof PARENTS_CLUBS) => {
    const r = validateOperatorView(sample.tools as ToolManifest[], sample.operator_view);
    if (!('contract' in r)) throw new Error(r.error);
    return JSON.stringify(r.contract);
  };
  /** owner check → contract → action manifest → app-role lookup → audit insert. */
  function db(sample: typeof STASH | typeof PARENTS_CLUBS, action: string, opts: { creator?: string; roles?: string[] } = {}) {
    const audit = mockStmt();
    const tool = sample.tools.find((t) => t.name === action)!;
    const d = mockD1(
      mockStmt({ first: { creator_id: opts.creator ?? 'gh:1' } }),
      mockStmt({ first: { contract: stored(sample) } }),
      mockStmt({ first: { manifest: JSON.stringify(tool) } }),
      mockStmt({ all: { results: (opts.roles ?? ['operator']).map((role_name) => ({ role_name })) } }),
      audit,
    );
    return { d, audit };
  }
  let calls: { url: string; body: Record<string, unknown> }[] = [];
  function dataWorker(reply: unknown) {
    calls = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url: String(url), body: JSON.parse(String(init.body)) });
      return Response.json(reply);
    }));
  }
  afterEach(() => vi.unstubAllGlobals());
  const fresh = () => mintSession({ uid: 'gh:1', login: 'owner', roles: ['user'], auth_time: Math.floor(Date.now() / 1000) - 10, auth_method: 'passkey' } as never, TEST_SK);
  const act = (appId: string, id: string, row: unknown, d: ReturnType<typeof mockD1>, token: string = OWNER) =>
    app.request(`/v1/apps/${appId}/operator/actions/${id}`, {
      method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ row }),
    }, makeEnv({}, d));
  const report = { report_id: 'r1', reported_user_id: 'u9', reason: 'spam', status: 'open', created_at: 1, secret: 'never sent' };

  it('runs a transition with params from declared columns only, audited with action and target', async () => {
    dataWorker({ meta: { changes: 1 } });
    const { d, audit } = db(STASH, 'op_resolve_report');
    const res = await act('stash', 'resolve', report, d);
    expect(res.status, await res.clone().text()).toBe(200);
    expect(await res.json()).toEqual({ ok: true, changes: 1 });
    expect(calls[0]!.url).toContain('pas-data-stash.');
    expect(calls[0]!.url).toContain('/execute');
    expect(JSON.stringify(calls[0]!.body.params)).not.toContain('never sent');
    expect(calls[0]!.body.params).toEqual(expect.arrayContaining(['r1', 'open']));
    expect(audit.bind).toHaveBeenCalledWith('stash', 'op_resolve_report', 'gh:1', 'operator', 200, expect.any(Number), 'resolve', 'r1');
  });

  it('refuses a transition the row status does not allow, before the data worker', async () => {
    dataWorker({ meta: { changes: 1 } });
    const res = await act('stash', 'review', { ...report, status: 'resolved' }, db(STASH, 'op_review_report').d);
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toBe('"Start review" is not available from status "resolved"');
    expect(calls).toHaveLength(0);
  });

  it("a transition the app's SQL guard matched to nothing is a 409, audited as such", async () => {
    dataWorker({ meta: { changes: 0 } });
    const { d, audit } = db(STASH, 'op_resolve_report');
    const res = await act('stash', 'resolve', report, d);
    expect(res.status).toBe(409);
    expect(await res.text()).toContain('the record changed since it was loaded');
    expect(audit.bind).toHaveBeenCalledWith('stash', 'op_resolve_report', 'gh:1', 'operator', 409, expect.any(Number), 'resolve', 'r1');
  });

  it('a destructive action needs a recent sign-in: a stale session is refused before the data worker', async () => {
    dataWorker({ results: [{ meta: { changes: 1 } }, { meta: { changes: 1 } }] });
    const stale = await act('stash', 'suspend_member', { user_id: 'u9', display_name: 'X' }, db(STASH, 'op_suspend_user').d);
    expect(stale.status).toBe(403);
    expect(await stale.text()).toContain('step_up_required');
    expect(calls).toHaveLength(0);
    const { d, audit } = db(STASH, 'op_suspend_user');
    const ok = await act('stash', 'suspend_member', { user_id: 'u9', display_name: 'X' }, d, await fresh());
    expect(ok.status, await ok.clone().text()).toBe(200);
    expect(await ok.json()).toEqual({ ok: true, changes: 2 });
    expect(calls[0]!.url).toContain('/batch');
    expect(audit.bind).toHaveBeenCalledWith('stash', 'op_suspend_user', 'gh:1', 'operator', 200, expect.any(Number), 'suspend_member', 'u9');
  });

  it('refuses callers and inputs that are not allowed', async () => {
    dataWorker({ meta: { changes: 1 } });
    const anon = mockD1();
    expect((await app.request('/v1/apps/stash/operator/actions/resolve', { method: 'POST', body: '{}' }, makeEnv({}, anon))).status).toBe(401);
    expect(anon.prepare).not.toHaveBeenCalled();
    const other = mockD1(mockStmt({ first: { creator_id: 'gh:9' } }), mockStmt({ first: null }));
    expect((await act('stash', 'resolve', report, other)).status).toBe(403);
    expect(readsAppData(other)).toBe(false);
    const noRole = db(STASH, 'op_resolve_report', { roles: [] });
    const refused = await act('stash', 'resolve', report, noRole.d);
    expect(refused.status).toBe(403);
    expect(await refused.text()).toContain('requires app role');
    expect(noRole.audit.bind).not.toHaveBeenCalled();
    expect((await act('stash', 'drop_tables', report, db(STASH, 'op_resolve_report').d)).status).toBe(404);
    const baseline = mockD1(mockStmt({ first: { creator_id: 'gh:1' } }), mockStmt({ first: null }));
    expect((await act('stash', 'resolve', report, baseline)).status).toBe(404);
    const missing = await act('stash', 'resolve', { status: 'open' }, db(STASH, 'op_resolve_report').d);
    expect(missing.status).toBe(400);
    expect(await missing.text()).toContain('row.report_id is required');
    const object = await act('stash', 'resolve', { ...report, report_id: { $ne: 1 } }, db(STASH, 'op_resolve_report').d);
    expect(object.status).toBe(400);
    expect((await act('stash', 'resolve', 'r1', db(STASH, 'op_resolve_report').d)).status).toBe(400);
    expect(calls).toHaveLength(0);
  });

  it('filters by a declared status and lists history per record, refusing undeclared filters', async () => {
    const list = (qs: string, d: ReturnType<typeof mockD1>) => app.request(`/v1/apps/stash/operator/resources/${qs}`, auth(OWNER), makeEnv({}, d));
    dataWorker({ rows: [report] });
    const byStatus = await list('open_reports?status=reviewing', db(STASH, 'op_list_reports').d);
    expect(byStatus.status).toBe(200);
    expect(calls[0]!.body.params).toEqual(expect.arrayContaining(['reviewing']));
    expect(JSON.stringify(await byStatus.json())).not.toContain('never sent');
    dataWorker({ rows: [] });
    expect((await list('open_reports?status=archived', db(STASH, 'op_list_reports').d)).status).toBe(400);
    expect((await list('members?status=open', db(STASH, 'op_list_users').d)).status).toBe(400);
    expect((await list('open_reports?related=u9', db(STASH, 'op_list_reports').d)).status).toBe(400);
    expect(calls).toHaveLength(0);

    dataWorker({ rows: [{ suspension_id: 's1', user_id: 'u9', reason: 'spam', status: 'active', created_at: 1, lifted_at: null }] });
    const { d, audit } = db(STASH, 'op_list_suspensions');
    const history = await list('suspension_history?related=u9', d);
    expect(history.status).toBe(200);
    expect(calls[0]!.body.params).toEqual(expect.arrayContaining(['u9']));
    expect(audit.bind).toHaveBeenCalledWith('stash', 'op_list_suspensions', 'gh:1', 'operator', 200, expect.any(Number), 'read:suspension_history', 'u9');
  });

  it('a second app (Parents Clubs) runs its own workflow through the same route and roles', async () => {
    dataWorker({ meta: { changes: 1 } });
    const flag = { flag_id: 'f1', post_title: 'Hi', flagged_by: 'p2', state: 'new', flagged_at: 1 };
    const { d, audit } = db(PARENTS_CLUBS, 'op_uphold_flag', { roles: ['moderator'] });
    const res = await act('parents-clubs', 'uphold', flag, d);
    expect(res.status, await res.clone().text()).toBe(200);
    expect(calls[0]!.url).toContain('pas-data-parents-clubs.');
    expect(calls[0]!.body.params).toEqual(expect.arrayContaining(['f1', 'new']));
    expect(audit.bind).toHaveBeenCalledWith('parents-clubs', 'op_uphold_flag', 'gh:1', 'moderator', 200, expect.any(Number), 'uphold', 'f1');
    // Stash's action ids mean nothing on Parents Clubs.
    expect((await act('parents-clubs', 'resolve', report, db(PARENTS_CLUBS, 'op_uphold_flag').d)).status).toBe(404);
  });
});

