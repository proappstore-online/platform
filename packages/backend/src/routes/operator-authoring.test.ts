import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { app } from '../index.js';
import { makeEnv, mockD1, mockStmt, testToken } from '../test-helpers.js';
import { validateOperatorView } from '../lib/operator-contract.js';
import type { ToolManifest } from '../lib/action-sql.js';
import { STASH } from '../__fixtures__/operator-view.js';

// #295: the admin-authoring routes behind the MCP tools — owner-only (capabilities:
// any signed-in user), read-only, and never a data-worker call, so no field value
// can reach a response.

const OWNER = await testToken('gh:1');
const STRANGER = await testToken('gh:2');
const stored = (() => {
  const r = validateOperatorView(STASH.tools as ToolManifest[], STASH.operator_view);
  if (!('contract' in r)) throw new Error(r.error);
  return r.contract;
})();
const toolRows = STASH.tools.map((t) => ({ manifest: JSON.stringify(t) }));

const req = (method: string, path: string, token: string | null, db: ReturnType<typeof mockD1>, body?: unknown) =>
  app.request(path, {
    method,
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  }, makeEnv({}, db));

/** Owner check (creator gh:1) → the contract → the app's tools. */
const ownerDb = (contract: unknown = stored, rows = toolRows) => mockD1(
  mockStmt({ first: { creator_id: 'gh:1' } }),
  mockStmt({ first: contract === null ? null : { contract: JSON.stringify(contract) } }),
  mockStmt({ all: { results: rows } }),
);
const strangerDb = () => mockD1(mockStmt({ first: { creator_id: 'gh:1' } }), mockStmt({ first: null }));

let fetches: string[];
beforeEach(() => {
  fetches = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string) => { fetches.push(String(url)); return Response.json({ rows: [{ password_hash: 'pbkdf2$leak' }] }); }));
});
afterEach(() => vi.unstubAllGlobals());

describe('admin-authoring routes (#295)', () => {
  it('GET /v1/operator-view/capabilities: any signed-in user; signed out → 401', async () => {
    expect((await req('GET', '/v1/operator-view/capabilities', null, mockD1())).status).toBe(401);
    const res = await req('GET', '/v1/operator-view/capabilities', STRANGER, mockD1());
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ limits: { resources: 20, actions: 20 }, schema: { title: 'operator_view' } });
  });

  for (const [method, path, body] of [
    ['GET', '/v1/apps/stash/operator-view/inspect', undefined],
    ['POST', '/v1/apps/stash/operator-view/preview', { operator_view: STASH.operator_view }],
    ['POST', '/v1/apps/stash/operator-view/propose', { operator_view: STASH.operator_view }],
    ['POST', '/v1/apps/stash/operator-view/security', { operator_view: STASH.operator_view }],
  ] as const) {
    it(`${method} ${path}: refuses a non-owner (403) and a signed-out caller (401), reading nothing else`, async () => {
      const db = strangerDb();
      expect((await req(method, path, STRANGER, db, body)).status).toBe(403);
      expect(db.prepare.mock.calls.some(([s]) => /app_operator_view|app_tools/.test(String(s)))).toBe(false);
      expect((await req(method, path, null, mockD1(), body)).status).toBe(401);
    });
  }

  it('inspect: the stored contract, its actions and gaps against the registered tools', async () => {
    const res = await req('GET', '/v1/apps/stash/operator-view/inspect', OWNER, ownerDb(stored, toolRows.filter((r) => !r.manifest.includes('"op_list_users"'))));
    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe('private, no-store');
    const body = (await res.json()) as { app_id: string; gaps: { code: string }[]; contract: unknown };
    expect(body.app_id).toBe('stash');
    expect(body.contract).toEqual(stored);
    expect(body.gaps).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'action_missing' })]));
    expect(fetches).toEqual([]);
  });

  it('preview: validates against the registered tools by default, stores nothing, calls no data worker', async () => {
    const db = ownerDb();
    // The preview never loads the stored contract: owner check, then the tools.
    const previewDb = mockD1(mockStmt({ first: { creator_id: 'gh:1' } }), mockStmt({ all: { results: toolRows } }));
    const res = await req('POST', '/v1/apps/stash/operator-view/preview', OWNER, previewDb, { operator_view: STASH.operator_view });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(JSON.parse(text)).toMatchObject({ app_id: 'stash', valid: true, blocked_fields: [] });
    expect(text).not.toContain('pbkdf2$leak');
    expect(previewDb.prepare.mock.calls.some(([s]) => /INSERT|UPDATE|DELETE/.test(String(s)))).toBe(false);
    expect(fetches).toEqual([]);
    expect(db.prepare).not.toHaveBeenCalled();
  });

  it('preview: a proposed tools array is checked like a deploy, then used instead of the registered tools', async () => {
    const tools = STASH.tools.filter((t) => t.name !== 'op_list_users');
    const res = await req('POST', '/v1/apps/stash/operator-view/preview', OWNER, mockD1(mockStmt({ first: { creator_id: 'gh:1' } })), { operator_view: STASH.operator_view, tools });
    expect(await res.json()).toMatchObject({ valid: false, error: expect.stringContaining('"op_list_users" is not a tool in this manifest') });
    const badTools = await req('POST', '/v1/apps/stash/operator-view/preview', OWNER, mockD1(mockStmt({ first: { creator_id: 'gh:1' } })), { operator_view: STASH.operator_view, tools: [{ name: 'Bad Name' }] });
    expect(await badTools.json()).toMatchObject({ valid: false, error: expect.stringMatching(/^tools: /) });
    expect(fetches).toEqual([]);
  });

  it('preview: a malformed body is a 400', async () => {
    const res = await req('POST', '/v1/apps/stash/operator-view/preview', OWNER, mockD1(mockStmt({ first: { creator_id: 'gh:1' } })), { tools: 'nope' });
    expect(res.status).toBe(400);
  });

  it('propose (#296): the validator verdict plus errors, missing requirements and security issues, using the role context', async () => {
    const db = mockD1(
      mockStmt({ first: { creator_id: 'gh:1' } }),
      mockStmt({ all: { results: toolRows } }),
      mockStmt({ all: { results: [{ role_name: 'operator', owner_holds: 1 }] } }),
    );
    const view = { ...STASH.operator_view, admin_access: { roles: ['helpdesk'] } };
    const res = await req('POST', '/v1/apps/stash/operator-view/propose', OWNER, db, { operator_view: view });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { valid: boolean; passes_security_gates: boolean; security_issues: { code: string }[] };
    expect(body).toMatchObject({ app_id: 'stash', valid: true, passes_security_gates: true, errors: [], missing_requirements: [] });
    expect(body.security_issues.map((i) => i.code)).toEqual(expect.arrayContaining(['undefined_role', 'admin_role_grants_nothing']));
    expect(db.prepare.mock.calls.some(([s]) => /FROM app_roles r JOIN apps a/.test(String(s)))).toBe(true);
    expect(fetches).toEqual([]);
  });

  it('security (#296): flags a declared secret column against a proposed tools array', async () => {
    const view = JSON.parse(JSON.stringify(STASH.operator_view));
    view.resources[0].columns.push({ key: 'password_hash', label: 'Hash' });
    const db = mockD1(mockStmt({ first: { creator_id: 'gh:1' } }), mockStmt({ all: { results: [] } }));
    const res = await req('POST', '/v1/apps/stash/operator-view/security', OWNER, db, { operator_view: view, tools: STASH.tools });
    expect(await res.json()).toMatchObject({ passes_security_gates: false, issues: expect.arrayContaining([expect.objectContaining({ code: 'secret_exposure' })]) });
  });
});

