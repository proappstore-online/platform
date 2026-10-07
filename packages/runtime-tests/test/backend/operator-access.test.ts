import { SELF, env, fetchMock } from 'cloudflare:test';
import { mintSession } from '@proappstore/build-core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BASE, json, mockNetwork, seedApp, seedUser, session, resetTables } from './helpers';
import { STASH } from '../../../backend/src/__fixtures__/operator-view';

// #240 / #293 regression, on real D1: every console operator route refuses every
// caller who is neither the app's owner nor a holder of a declared admin role,
// against an app that HAS a registered contract. Nothing is served and nothing
// joins the app's audit trail.

const ROUTES: { method: 'GET' | 'POST'; path: string; body?: unknown }[] = [
  { method: 'GET', path: '/v1/apps/stash/operator' },
  { method: 'GET', path: '/v1/apps/stash/operator/resources/members' },
  { method: 'GET', path: '/v1/apps/stash/operator/resources/members/records/u001' },
  { method: 'GET', path: '/v1/apps/stash/operator/resources/kyc/records/k1/evidence/document_path' },
  { method: 'POST', path: '/v1/apps/stash/operator/actions/suspend_member', body: { row: { user_id: 'u001' } } },
  { method: 'GET', path: '/v1/apps/stash/operator/metrics/growth' },
  { method: 'POST', path: '/v1/apps/stash/operator/entries', body: { visit: 'visit-0001' } },
  { method: 'GET', path: '/v1/apps/stash/operator/audit' },
  { method: 'GET', path: '/v1/apps/stash/operator/users' },
];

afterEach(() => fetchMock.assertNoPendingInterceptors());
beforeEach(async () => {
  mockNetwork();
  await resetTables();
  for (const t of ['app_operator_view', 'app_action_audit']) await env.DB.prepare(`DELETE FROM ${t}`).run();
  await seedUser('gh:1', 'owner');
  await seedUser('gh:2', 'other-owner');
  await seedUser('gh:3', 'teammate');
  await seedApp('stash', 'gh:1');
  await seedApp('bingo', 'gh:2');
  // Every role the contract's actions ask for, held by every caller: the ownership check alone must refuse.
  for (const uid of ['gh:1', 'gh:2', 'gh:3']) {
    await env.DB.prepare("INSERT INTO app_roles (app_id, user_id, role_name) VALUES ('stash', ?1, 'operator'), ('stash', ?1, 'reviewer')").bind(uid).run();
  }
  fetchMock.get(`https://pas-data-stash.${env.DATA_WORKER_HOST}`).intercept({ path: '/validate', method: 'POST' })
    .reply(200, (req) => ({ results: (JSON.parse(String(req.body)) as { statements: { id: string }[] }).statements.map((st) => ({ id: st.id, ok: true })) }));
  const put = await SELF.fetch(`${BASE}/v1/apps/stash/tools`, json('PUT', STASH, await session('gh:1')));
  expect(put.status, await put.clone().text()).toBe(200);
});

async function expectRefusedEverywhere(token: string | undefined, status: 401 | 403) {
  for (const route of ROUTES) {
    const res = await SELF.fetch(`${BASE}${route.path}`, json(route.method, route.body, token));
    const text = await res.text();
    expect(res.status, `${route.method} ${route.path}: ${text}`).toBe(status);
    expect(text, route.path).not.toMatch(/usersWithRoles|"contract"|"rows"|"record"|"series"|"users"/);
  }
  const trail = await env.DB.prepare("SELECT COUNT(*) AS n FROM app_action_audit WHERE app_id = 'stash'").first<{ n: number }>();
  expect(trail?.n).toBe(0);
}

describe('operator routes refuse every non-owner (#240 regression matrix)', () => {
  it('signed out → 401', async () => {
    await expectRefusedEverywhere(undefined, 401);
  });

  it('forged, expired and wrongly signed sessions → 401', async () => {
    const claims = { uid: 'gh:1', login: 'owner', avatarUrl: null, roles: ['user'] };
    for (const token of [
      'not-a-session',
      await mintSession(claims, env.SESSION_SIGNING_KEY, -60),
      await mintSession(claims, 'not-the-signing-key'),
    ]) await expectRefusedEverywhere(token, 401);
  });

  it("another app's owner → 403, even holding the app's roles", async () => {
    await expectRefusedEverywhere(await session('gh:2'), 403);
  });

  it('every team role below owner → 403, even holding the app roles', async () => {
    await env.DB.prepare("INSERT INTO team_members (app_id, user_id, role, created_at) VALUES ('stash', 'gh:3', 'viewer', 0)").run();
    for (const role of ['viewer', 'po', 'developer', 'admin']) {
      await env.DB.prepare("UPDATE team_members SET role = ?1 WHERE app_id = 'stash' AND user_id = 'gh:3'").bind(role).run();
      await expectRefusedEverywhere(await session('gh:3'), 403);
    }
  });

  it('the owner gets through the same routes (the matrix is not refusing everyone)', async () => {
    const res = await SELF.fetch(`${BASE}/v1/apps/stash/operator`, json('GET', undefined, await session('gh:1')));
    expect(res.status).toBe(200);
    expect(((await res.json()) as { contract: unknown }).contract).not.toBeNull();
    const entry = await SELF.fetch(`${BASE}/v1/apps/stash/operator/entries`, json('POST', { visit: 'visit-0001' }, await session('gh:1')));
    expect(entry.status).toBe(200);
  });
});

// #293: the admin role gate, on real D1. The contract declares
// admin_access.roles = ['support']; the actions themselves still need 'operator'
// (and op_suspend_user a passkey step-up). Every caller from the top-level
// beforeEach (gh:1-3) holds 'operator' and 'reviewer' but not 'support'.
describe('admin role gate (#293)', () => {
  const worker = () => fetchMock.get(`https://pas-data-stash.${env.DATA_WORKER_HOST}`);
  const audit = () => env.DB.prepare(
    "SELECT action_name, actor_id, role_name, status, operator_action FROM app_action_audit WHERE app_id = 'stash' ORDER BY id",
  ).all();
  const grant = (uid: string, ...roles: string[]) => env.DB.batch(roles.map((r) =>
    env.DB.prepare("INSERT INTO app_roles (app_id, user_id, role_name) VALUES ('stash', ?1, ?2)").bind(uid, r)));
  const get = async (path: string, token: string) => SELF.fetch(`${BASE}/v1/apps/stash/operator${path}`, json('GET', undefined, token));
  const fresh = (uid: string, login: string) => mintSession(
    { uid, login, avatarUrl: null, roles: ['user'], auth_time: Math.floor(Date.now() / 1000) - 5, auth_method: 'passkey' } as never, env.SESSION_SIGNING_KEY);

  beforeEach(async () => {
    await seedUser('gh:4', 'admina');
    await seedUser('gh:5', 'supporter');
    worker().intercept({ path: '/validate', method: 'POST' })
      .reply(200, (req) => ({ results: (JSON.parse(String(req.body)) as { statements: { id: string }[] }).statements.map((st) => ({ id: st.id, ok: true })) }));
    const withAccess = { ...STASH, operator_view: { ...STASH.operator_view, admin_access: { roles: ['support'] } } };
    const put = await SELF.fetch(`${BASE}/v1/apps/stash/tools`, json('PUT', withAccess, await session('gh:1')));
    expect(put.status, await put.clone().text()).toBe(200);
  });

  it("refuses undeclared roles (even the actions' own), lesser team roles, another app's owner and signed-out callers everywhere", async () => {
    await expectRefusedEverywhere(await session('gh:3'), 403);
    await env.DB.prepare("INSERT INTO team_members (app_id, user_id, role, created_at) VALUES ('stash', 'gh:3', 'admin', 0)").run();
    await expectRefusedEverywhere(await session('gh:3'), 403);
    await expectRefusedEverywhere(await session('gh:2'), 403);
    await expectRefusedEverywhere(undefined, 401);
  });

  it('admits a holder of a declared admin role to the context, resources, records, metrics and entries — not the audit trail or the users list', async () => {
    await grant('gh:4', 'support', 'operator');
    const token = await session('gh:4', { login: 'admina' });
    const context = await get('', token);
    expect(context.status, await context.clone().text()).toBe(200);
    expect(await context.json()).toMatchObject({ operator: { userId: 'gh:4' }, contract: { admin_access: { roles: ['support'] } } });

    worker().intercept({ path: '/query', method: 'POST' }).reply(200, { rows: [{ user_id: 'u001', display_name: 'Ada', created_at: 1, suspended: 0, password_hash: 'h' }], meta: {} });
    const rows = await get('/resources/members', token);
    const text = await rows.text();
    expect(rows.status, text).toBe(200);
    expect(text).toContain('Ada');
    expect(text).not.toContain('password_hash');
    worker().intercept({ path: '/query', method: 'POST' }).reply(200, { rows: [{ user_id: 'u001', display_name: 'Ada' }], meta: {} });
    expect((await get('/resources/members/records/u001', token)).status).toBe(200);
    worker().intercept({ path: '/query', method: 'POST' }).reply(200, { rows: [], meta: {} });
    expect((await get('/metrics/growth', token)).status).toBe(200);
    expect((await SELF.fetch(`${BASE}/v1/apps/stash/operator/entries`, json('POST', { visit: 'visit-admin-1' }, token))).status).toBe(200);

    expect((await get('/audit', token)).status).toBe(403);
    expect((await get('/users', token)).status).toBe(403);

    // Every admitted read is audited under the admin's own id; the owner-only refusals are not (never past their gate).
    expect((await audit()).results).toEqual([
      expect.objectContaining({ action_name: 'op_list_users', actor_id: 'gh:4', role_name: 'operator', status: 200, operator_action: 'read:members' }),
      expect.objectContaining({ action_name: 'op_member_detail', actor_id: 'gh:4', status: 200, operator_action: 'detail:members' }),
      expect.objectContaining({ action_name: 'op_daily_signups', actor_id: 'gh:4', status: 200, operator_action: 'series:growth' }),
      expect.objectContaining({ actor_id: 'gh:4', status: 200, operator_action: 'enter' }),
    ]);
  });

  it("grants no action by itself: each read needs the action's own role, each write its step-up, and the refusals are audited", async () => {
    await grant('gh:5', 'support');
    const token = await session('gh:5', { login: 'supporter' });
    expect((await get('', token)).status).toBe(200);
    const refused = await get('/resources/members', token);
    expect(refused.status).toBe(403);
    expect(await refused.text()).toContain('requires app role');

    await grant('gh:4', 'support', 'operator');
    const stale = await SELF.fetch(`${BASE}/v1/apps/stash/operator/actions/suspend_member`, json('POST', { row: { user_id: 'u001' } }, await session('gh:4', { login: 'admina' })));
    expect(stale.status).toBe(403);
    expect(await stale.text()).toContain('step_up_required');

    expect((await audit()).results).toEqual([
      expect.objectContaining({ actor_id: 'gh:5', status: 403, operator_action: 'read:members' }),
      expect.objectContaining({ actor_id: 'gh:4', status: 403, operator_action: 'suspend_member' }),
    ]);
  });

  it("audits an admitted admin's mutation with their own actor id", async () => {
    await grant('gh:4', 'support', 'operator');
    worker().intercept({ path: '/batch', method: 'POST' }).reply(200, { results: [{ meta: { changes: 1 } }, { meta: { changes: 1 } }] });
    const ok = await SELF.fetch(`${BASE}/v1/apps/stash/operator/actions/suspend_member`, json('POST', { row: { user_id: 'u001' } }, await fresh('gh:4', 'admina')));
    expect(ok.status, await ok.clone().text()).toBe(200);
    expect((await audit()).results).toEqual([
      { action_name: 'op_suspend_user', actor_id: 'gh:4', role_name: 'operator', status: 200, operator_action: 'suspend_member' },
    ]);
  });

  it('refuses a credential or Google account whose login equals an admin\'s GitHub login or id (#272)', async () => {
    // A legacy grant keyed by GitHub login: it admits the GitHub session with that login only.
    await env.DB.prepare("INSERT INTO app_roles (app_id, user_id, role_name) VALUES ('stash', 'admina', 'support'), ('stash', 'gh:4', 'support')").run();
    expect((await get('', await session('gh:4', { login: 'admina' }))).status).toBe(200);
    await expectRefusedEverywhere(await session('cred:squat', { login: 'admina' }), 403);
    await expectRefusedEverywhere(await session('google:squat', { login: 'gh:4' }), 403);
  });

  it('reads the role per request: revoking it, or dropping admin_access, refuses the next request', async () => {
    await grant('gh:4', 'support');
    const token = await session('gh:4', { login: 'admina' });
    expect((await get('', token)).status).toBe(200);
    await env.DB.prepare("DELETE FROM app_roles WHERE app_id = 'stash' AND user_id = 'gh:4'").run();
    expect((await get('', token)).status).toBe(403);

    await grant('gh:4', 'support');
    expect((await get('', token)).status).toBe(200);
    worker().intercept({ path: '/validate', method: 'POST' })
      .reply(200, (req) => ({ results: (JSON.parse(String(req.body)) as { statements: { id: string }[] }).statements.map((st) => ({ id: st.id, ok: true })) }));
    const put = await SELF.fetch(`${BASE}/v1/apps/stash/tools`, json('PUT', STASH, await session('gh:1')));
    expect(put.status, await put.clone().text()).toBe(200);
    // Without admin_access the console is owner-only again, exactly as before #293.
    await env.DB.prepare("DELETE FROM app_action_audit WHERE app_id = 'stash'").run();
    await expectRefusedEverywhere(token, 403);
  });
});

// #297: the console reaches an app the caller only administers through
// GET /v1/me/administered-apps — never by widening /v1/apps (owner + team).
describe('apps the caller administers (#297)', () => {
  const administered = async (token?: string) => SELF.fetch(`${BASE}/v1/me/administered-apps`, json('GET', undefined, token));
  const ids = async (token: string) => ((await (await administered(token)).json()) as { apps: { id: string }[] }).apps.map((a) => a.id);

  beforeEach(async () => {
    await seedUser('gh:4', 'admina');
    fetchMock.get(`https://pas-data-stash.${env.DATA_WORKER_HOST}`).intercept({ path: '/validate', method: 'POST' })
      .reply(200, (req) => ({ results: (JSON.parse(String(req.body)) as { statements: { id: string }[] }).statements.map((st) => ({ id: st.id, ok: true })) }));
    const withAccess = { ...STASH, operator_view: { ...STASH.operator_view, admin_access: { roles: ['support'] } } };
    const put = await SELF.fetch(`${BASE}/v1/apps/stash/tools`, json('PUT', withAccess, await session('gh:1')));
    expect(put.status, await put.clone().text()).toBe(200);
  });

  it('lists an app where the caller holds a declared admin role, and keeps it out of /v1/apps', async () => {
    await env.DB.prepare("INSERT INTO app_roles (app_id, user_id, role_name) VALUES ('stash', 'gh:4', 'support')").run();
    const token = await session('gh:4', { login: 'admina' });
    const res = await administered(token);
    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe('private, no-store');
    expect(await res.json()).toEqual({ apps: [{ id: 'stash', name: expect.any(String), created_at: expect.any(Number) }] });
    const own = (await (await SELF.fetch(`${BASE}/v1/apps`, json('GET', undefined, token))).json()) as { apps: { id: string }[] };
    expect(own.apps.map((a) => a.id)).not.toContain('stash');
  });

  it('lists nothing for an undeclared role, the owner, a team member, or a squatter of the admin login; 401 signed out', async () => {
    // gh:3 holds operator/reviewer (the actions' roles), not the declared 'support'.
    expect(await ids(await session('gh:3'))).toEqual([]);
    // The owner reaches the app through /v1/apps.
    await env.DB.prepare("INSERT INTO app_roles (app_id, user_id, role_name) VALUES ('stash', 'gh:1', 'support'), ('stash', 'admina', 'support')").run();
    expect(await ids(await session('gh:1'))).toEqual([]);
    // A legacy login-keyed grant admits the GitHub session with that login, never a credential account named the same (#272).
    expect(await ids(await session('gh:4', { login: 'admina' }))).toEqual(['stash']);
    expect(await ids(await session('cred:squat', { login: 'admina' }))).toEqual([]);
    // A team member already gets the app from /v1/apps.
    await env.DB.prepare("INSERT INTO team_members (app_id, user_id, role, created_at) VALUES ('stash', 'gh:4', 'viewer', 0)").run();
    expect(await ids(await session('gh:4', { login: 'admina' }))).toEqual([]);
    expect((await administered()).status).toBe(401);
  });

  it('drops the app when admin_access no longer declares the role', async () => {
    await env.DB.prepare("INSERT INTO app_roles (app_id, user_id, role_name) VALUES ('stash', 'gh:4', 'support')").run();
    const token = await session('gh:4', { login: 'admina' });
    expect(await ids(token)).toEqual(['stash']);
    fetchMock.get(`https://pas-data-stash.${env.DATA_WORKER_HOST}`).intercept({ path: '/validate', method: 'POST' })
      .reply(200, (req) => ({ results: (JSON.parse(String(req.body)) as { statements: { id: string }[] }).statements.map((st) => ({ id: st.id, ok: true })) }));
    await SELF.fetch(`${BASE}/v1/apps/stash/tools`, json('PUT', STASH, await session('gh:1')));
    expect(await ids(token)).toEqual([]);
  });
});
