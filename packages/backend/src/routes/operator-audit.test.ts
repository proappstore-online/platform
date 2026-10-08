import { afterEach, describe, expect, it, vi } from 'vitest';
import { mintSession } from '@proappstore/build-core';
import { app } from '../index.js';
import { TEST_SK, makeEnv, mockD1, mockStmt, testToken } from '../test-helpers.js';
import { validateOperatorView } from '../lib/operator-contract.js';
import type { ToolManifest } from '../lib/action-sql.js';
import { PARENTS_CLUBS, STASH } from '../__fixtures__/operator-view.js';
import { parseOperatorAction } from './operator-audit.js';

// #240 operator audit trail: entry once per visit, refusals recorded once for
// owners only, and an owner-only, paged, filtered, redacted trail.

const OWNER = await testToken('gh:1');
const fresh = () => mintSession({ uid: 'gh:1', login: 'owner', roles: ['user'], auth_time: Math.floor(Date.now() / 1000) - 10, auth_method: 'passkey', step_up_rp_id: 'console.proappstore.online' } as never, TEST_SK);
const stored = (sample: typeof STASH | typeof PARENTS_CLUBS) => {
  const r = validateOperatorView(sample.tools as ToolManifest[], sample.operator_view);
  if (!('contract' in r)) throw new Error(r.error);
  return JSON.stringify(r.contract);
};
const sqls = (d: ReturnType<typeof mockD1>) => d.prepare.mock.calls.map(([q]) => String(q));
const inserts = (d: ReturnType<typeof mockD1>) => sqls(d).filter((q) => q.includes('INSERT INTO app_action_audit'));
const req = (path: string, d: ReturnType<typeof mockD1>, init: RequestInit & { token?: string | null } = {}) => {
  const { token = OWNER, ...rest } = init;
  return app.request(`/v1/apps/${path}`, { ...rest, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), 'Content-Type': 'application/json' } }, makeEnv({}, d));
};
afterEach(() => vi.unstubAllGlobals());

describe('parseOperatorAction', () => {
  it('names the kind, resource and field of every operator_action', () => {
    expect(parseOperatorAction('enter')).toEqual({ kind: 'enter', resource: null, field: null });
    expect(parseOperatorAction('audit')).toEqual({ kind: 'audit', resource: null, field: null });
    expect(parseOperatorAction('read:members')).toEqual({ kind: 'read', resource: 'members', field: null });
    expect(parseOperatorAction('detail:kyc')).toEqual({ kind: 'detail', resource: 'kyc', field: null });
    expect(parseOperatorAction('evidence:kyc.document_path')).toEqual({ kind: 'evidence', resource: 'kyc', field: 'document_path' });
    expect(parseOperatorAction('series:growth')).toEqual({ kind: 'series', resource: 'growth', field: null });
    expect(parseOperatorAction('suspend_member')).toEqual({ kind: 'action', resource: null, field: null });
  });
});

describe('POST /v1/apps/:appId/operator/entries', () => {
  const entry = (visit: unknown, d: ReturnType<typeof mockD1>, token?: string | null) =>
    req('stash/operator/entries', d, { method: 'POST', body: JSON.stringify({ visit }), token });

  it('records entry for the owner with a guarded insert, so a repeated visit writes nothing', async () => {
    const insert = mockStmt({ run: { meta: { changes: 1 } } });
    const d = mockD1(mockStmt({ first: { creator_id: 'gh:1' } }), insert);
    const res = await entry('visit-0123456789', d);
    expect(await res.json()).toEqual({ recorded: true });
    expect(sqls(d)[1]).toContain('WHERE NOT EXISTS (SELECT 1 FROM app_action_audit WHERE app_id = ?1 AND actor_id = ?2 AND operator_action = \'enter\' AND target = ?4)');
    expect(insert.bind).toHaveBeenCalledWith('stash', 'gh:1', expect.any(Number), 'visit-0123456789');
    const again = mockD1(mockStmt({ first: { creator_id: 'gh:1' } }), mockStmt({ run: { meta: { changes: 0 } } }));
    expect(await (await entry('visit-0123456789', again)).json()).toEqual({ recorded: false });
    expect(inserts(again)).toHaveLength(1); // the guarded insert only — no refusal row on top
  });

  it('refuses a signed-out caller and a non-owner without writing; a malformed visit is a recorded refusal', async () => {
    const anon = mockD1();
    expect((await entry('visit-0123456789', anon, null)).status).toBe(401);
    expect(anon.prepare).not.toHaveBeenCalled();
    const other = mockD1(mockStmt({ first: { creator_id: 'gh:9' } }), mockStmt({ first: null }));
    expect((await entry('visit-0123456789', other)).status).toBe(403);
    expect(inserts(other)).toHaveLength(0);
    for (const visit of ['short', 'x'.repeat(65), 'has spaces here', 42, null]) {
      const refusal = mockStmt();
      const d = mockD1(mockStmt({ first: { creator_id: 'gh:1' } }), refusal);
      expect((await entry(visit, d)).status, String(visit)).toBe(400);
      expect(refusal.bind).toHaveBeenCalledWith('stash', '', 'gh:1', '', 400, expect.any(Number), 'enter', null);
    }
  });
});

describe('GET /v1/apps/:appId/operator/audit', () => {
  const row = (id: number, op: string, target: string | null, status = 200, actor = 'gh:1') =>
    ({ id, created_at: 1_700_000_000_000 + id, actor_id: actor, actor_login: 'owner', role_name: 'operator', action_name: 'op_x', operator_action: op, target, status, secret: 'x' });
  const trail = [
    row(9, 'evidence:kyc.document_path', 'k1'),
    row(8, 'detail:kyc', 'k1'),
    row(7, 'detail:members', 'u1'),
    row(6, 'approve_kyc', 'k1', 409),
    row(5, 'enter', 'visit-0123456789'),
  ];
  /** owner → contract → trail query → the trail read's own audit row. */
  function db(results: unknown[], sample: typeof STASH | typeof PARENTS_CLUBS = STASH, extra: ReturnType<typeof mockStmt>[] = []) {
    const query = mockStmt({ all: { results } });
    const own = mockStmt();
    const d = mockD1(mockStmt({ first: { creator_id: 'gh:1' } }), mockStmt({ first: { contract: stored(sample) } }), ...extra, query, own);
    return { d, query, own };
  }
  type Body = { rows: Record<string, unknown>[]; next_cursor: string | null; targets_hidden: boolean };

  it('shows who did what to which record, hiding identity-verification targets until a recent sign-in', async () => {
    const { d, own } = db(trail);
    const res = await req('stash/operator/audit', d);
    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe('private, no-store');
    const body = await res.json() as Body;
    expect(body.rows.map((r) => [r.kind, r.resource, r.target, r.target_hidden, r.outcome])).toEqual([
      ['evidence', 'kyc', null, true, 'success'],
      ['detail', 'kyc', null, true, 'success'],
      ['detail', 'members', 'u1', false, 'success'],
      ['action', null, 'k1', false, 'refused'],
      ['enter', null, 'visit-0123456789', false, 'success'],
    ]);
    expect(body.rows[0]).toMatchObject({ actor: { id: 'gh:1', login: 'owner' }, role: 'operator', operation: 'evidence:kyc.document_path', field: 'document_path', action: 'op_x', status: 200 });
    expect(body.targets_hidden).toBe(true);
    expect(JSON.stringify(body)).not.toMatch(/secret|_review|Bearer/);
    // Reading the trail is itself on the trail.
    expect(own.bind).toHaveBeenCalledWith('stash', '', 'gh:1', '', 200, expect.any(Number), 'audit', null);
    expect(inserts(d)).toHaveLength(1);

    const revealed = await (await req('stash/operator/audit', db(trail).d, { token: await fresh() })).json() as Body;
    expect(revealed.rows.slice(0, 2).map((r) => r.target)).toEqual(['k1', 'k1']);
    expect(revealed.targets_hidden).toBe(false);
  });

  it('pages newest-first by id: 50 rows, a cursor to continue, bounded by the cursor', async () => {
    const many = Array.from({ length: 51 }, (_, i) => row(200 - i, 'read:members', null));
    const first = db(many);
    const body = await (await req('stash/operator/audit', first.d)).json() as Body;
    expect(body.rows).toHaveLength(50);
    expect(body.next_cursor).toBe('151');
    expect(sqls(first.d)[2]).toContain('ORDER BY a.id DESC LIMIT ?');
    expect(first.query.bind).toHaveBeenCalledWith('stash', 51);
    const next = db([]);
    await req('stash/operator/audit?cursor=151', next.d);
    expect(sqls(next.d)[2]).toContain('AND a.id < ?');
    expect(next.query.bind).toHaveBeenCalledWith('stash', 151, 51);
  });

  it('binds every filter, never splicing a value into the SQL', async () => {
    for (const [qs, clause, binds] of [
      ['kind=read', 'substr(a.operator_action, 1, ?) = ?', [5, 'read:']],
      ['kind=evidence', 'substr(a.operator_action, 1, ?) = ?', [9, 'evidence:']],
      ['kind=enter', 'a.operator_action = ?', ['enter']],
      ['kind=action', "instr(a.operator_action, ':') = 0", []],
      ['outcome=refused', 'a.status >= 400', []],
      ['outcome=success', 'a.status < 400', []],
      ["actor=gh%3A1'%20OR%201%3D1", 'a.actor_id = ?', ["gh:1' OR 1=1"]],
      ['target=k1', 'a.target = ?', ['k1']],
      ['from=2026-09-01&to=2026-09-02', 'a.created_at >= ? AND a.created_at < ?', [Date.parse('2026-09-01T00:00:00Z'), Date.parse('2026-09-03T00:00:00Z')]],
    ] as const) {
      const { d, query } = db([]);
      expect((await req(`stash/operator/audit?${qs}`, d)).status, qs).toBe(200);
      expect(sqls(d)[2], qs).toContain(clause);
      expect(sqls(d)[2], qs).not.toContain('OR 1=1');
      expect(query.bind, qs).toHaveBeenCalledWith('stash', ...binds, 51);
    }
  });

  it('refuses malformed filters before querying', async () => {
    for (const [qs, error] of [
      ['kind=everything', 'kind must be one of'],
      ['outcome=maybe', 'outcome must be success or refused'],
      ['cursor=0', 'cursor is invalid'],
      ['cursor=1;DROP', 'cursor is invalid'],
      ['from=2026-02-30', 'must be dates'],
      ['from=2026-09-10&to=2026-09-01', 'from must not be after to'],
      ['from=2024-01-01&to=2026-09-01', 'at most 366 days'],
      [`target=${'x'.repeat(201)}`, 'target is too long'],
    ] as const) {
      const { d } = db([]);
      const res = await req(`stash/operator/audit?${qs}`, d);
      expect(res.status, qs).toBe(400);
      expect(await res.text(), qs).toContain(error);
      expect(sqls(d).some((q) => q.includes('FROM app_action_audit a')), qs).toBe(false);
    }
  });

  it('is owner-only; a declared audit role (Parents Clubs) is required on top', async () => {
    const anon = mockD1();
    expect((await req('stash/operator/audit', anon, { token: null })).status).toBe(401);
    expect(anon.prepare).not.toHaveBeenCalled();
    const other = mockD1(mockStmt({ first: { creator_id: 'gh:9' } }), mockStmt({ first: null }));
    expect((await req('stash/operator/audit', other)).status).toBe(403);
    expect(inserts(other)).toHaveLength(0); // a stranger's attempt is not written into the trail
    const noRole = db([], PARENTS_CLUBS, [mockStmt({ first: null })]);
    const refused = await req('parents-clubs/operator/audit', noRole.d);
    expect(refused.status).toBe(403);
    expect(await refused.text()).toContain('requires app role');
    expect(sqls(noRole.d).some((q) => q.includes('FROM app_action_audit a'))).toBe(false);
    const withRole = db([], PARENTS_CLUBS, [mockStmt({ first: { role_name: 'operator' } })]);
    expect((await req('parents-clubs/operator/audit', withRole.d)).status).toBe(200);
    expect(withRole.own.bind).toHaveBeenCalledWith('parents-clubs', '', 'gh:1', 'operator', 200, expect.any(Number), 'audit', null);
  });
});

describe('refused operator requests join the trail exactly once', () => {
  let calls = 0;
  function dataWorker(reply: unknown) {
    calls = 0;
    vi.stubGlobal('fetch', vi.fn(async () => { calls++; return Response.json(reply); }));
  }
  function db(sample: typeof STASH | typeof PARENTS_CLUBS, action: string, roles = ['operator']) {
    return mockD1(
      mockStmt({ first: { creator_id: 'gh:1' } }),
      mockStmt({ first: { contract: stored(sample) } }),
      mockStmt({ first: { manifest: JSON.stringify(sample.tools.find((t) => t.name === action)) } }),
      mockStmt({ all: { results: roles.map((role_name) => ({ role_name })) } }),
    );
  }
  const auditBinds = (d: ReturnType<typeof mockD1>) => d.prepare.mock.calls
    .map(([q], i) => [String(q), d.prepare.mock.results[i]!.value.bind.mock.calls[0] as unknown[]] as const)
    .filter(([q]) => q.includes('INSERT INTO app_action_audit'))
    .map(([, b]) => b);

  it('a guarded transition that changed nothing is written once, by the executor', async () => {
    dataWorker({ meta: { changes: 0 } });
    const d = db(STASH, 'op_resolve_report');
    d.prepare.mockImplementation(() => mockStmt());
    const res = await req('stash/operator/actions/resolve', d, { method: 'POST', body: JSON.stringify({ row: { report_id: 'r1', status: 'open' } }) });
    expect(res.status).toBe(409);
    expect(auditBinds(d)).toEqual([['stash', 'op_resolve_report', 'gh:1', 'operator', 409, expect.any(Number), 'resolve', 'r1']]);
  });

  it('a step-up refusal on a document is written once, with the record it was for', async () => {
    dataWorker({ rows: [] });
    const d = mockD1(
      mockStmt({ first: { creator_id: 'gh:1' } }),
      mockStmt({ first: { contract: stored(STASH) } }),
      mockStmt({ first: { review_roles: '["operator"]' } }),
      mockStmt({ first: { 1: 1 } }),
      mockStmt({ first: { manifest: JSON.stringify(STASH.tools.find((t) => t.name === 'op_kyc_detail')) } }),
      mockStmt({ all: { results: [{ role_name: 'operator' }] } }),
    );
    d.prepare.mockImplementation(() => mockStmt());
    const res = await app.request('/v1/apps/stash/operator/resources/kyc/records/k1/evidence/document_path', { headers: { Authorization: `Bearer ${OWNER}` } }, makeEnv({ STORAGE: { get: vi.fn() } }, d));
    expect(res.status).toBe(403);
    expect(calls).toBe(0);
    expect(auditBinds(d)).toEqual([['stash', '', 'gh:1', '', 403, expect.any(Number), 'evidence:kyc.document_path', 'k1']]);
  });

  it('a success is written once (no refusal row), and a signed-out caller is never written', async () => {
    dataWorker({ rows: [] });
    const d = db(PARENTS_CLUBS, 'op_list_parents');
    d.prepare.mockImplementation(() => mockStmt());
    expect((await req('parents-clubs/operator/resources/parents', d)).status).toBe(200);
    expect(auditBinds(d)).toEqual([['parents-clubs', 'op_list_parents', 'gh:1', 'operator', 200, expect.any(Number), 'read:parents', null]]);
    const anon = mockD1();
    expect((await req('parents-clubs/operator/resources/parents', anon, { token: null })).status).toBe(401);
    expect(anon.prepare).not.toHaveBeenCalled();
  });
});
