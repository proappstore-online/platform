import { SELF, env, fetchMock } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BASE, goLive, json, mockNetwork, resetTables, seedApp, seedUser, session } from './helpers';
import { PARENTS_CLUBS } from '../../../backend/src/__fixtures__/operator-view';

/**
 * #695: an app declares its roles in mcp.json `roles`; the app's owner holds
 * every declared role; a declared role's `requires` is granted and revoked with
 * it. Real registration (PUT /tools), real app_roles / app_declared_roles /
 * app_action_audit on D1; the data worker is intercepted.
 */
afterEach(() => fetchMock.assertNoPendingInterceptors());
beforeEach(async () => {
  mockNetwork();
  await resetTables();
  for (const t of ['app_operator_view', 'app_action_audit', 'app_declared_roles']) await env.DB.prepare(`DELETE FROM ${t}`).run();
  await seedUser('gh:1', 'owner');
  await seedUser('gh:2', 'driver');
  await seedUser('gh:3', 'teammate');
  await seedApp('parents-clubs', 'gh:1');
});

const ROLES = [
  { id: 'operator', label: 'Operator', description: 'Runs the club operations' },
  { id: 'moderator', label: 'Moderator' },
  { id: 'operator_pii', label: 'Operator PII', description: 'Sees parents’ phone numbers', requires: ['operator'] },
];
const dataWorker = () => fetchMock.get(`https://pas-data-parents-clubs.${env.DATA_WORKER_HOST}`);
const validates = () => dataWorker().intercept({ path: '/validate', method: 'POST' })
  .reply(200, (req) => ({ results: (JSON.parse(String(req.body)) as { statements: { id: string }[] }).statements.map((st) => ({ id: st.id, ok: true })) }));
const register = async (body: unknown) => {
  validates();
  const res = await SELF.fetch(`${BASE}/v1/apps/parents-clubs/tools`, json('PUT', body, await session('gh:1')));
  await goLive('parents-clubs');
  return res;
};
const get = async (path: string, uid: string | null = 'gh:1', roles?: string[]) =>
  SELF.fetch(`${BASE}/v1/apps/parents-clubs/${path}`, json('GET', undefined, uid ? await session(uid, roles ? { roles } : {}) : undefined));
const rolesMe = async (uid: string, roles?: string[]) => ((await (await get('roles/me', uid, roles)).json()) as { roles: string[] }).roles.sort();
const has = async (uid: string, role: string) => ((await (await get(`roles/check/${role}`, uid)).json()) as { has: boolean }).has;
const audit = async () =>
  (await env.DB.prepare("SELECT actor_id, action_name, role_name, role_via_owner, operator_action FROM app_action_audit WHERE app_id = 'parents-clubs' ORDER BY id").all()).results;

describe('declared app roles: registration (#695)', () => {
  it('stores the declared roles with the manifest and serves them to the team', async () => {
    const reg = await register({ ...PARENTS_CLUBS, roles: ROLES });
    expect(reg.status, await reg.clone().text()).toBe(200);
    expect(await reg.json()).toMatchObject({ roles: ['operator', 'moderator', 'operator_pii'] });

    await env.DB.prepare("INSERT INTO team_members (app_id, user_id, role, created_at) VALUES ('parents-clubs', 'gh:3', 'viewer', 0)").run();
    const declared = await get('roles/declared', 'gh:3');
    expect(declared.status).toBe(200);
    expect(await declared.json()).toEqual({
      roles: [
        { id: 'operator', label: 'Operator', description: 'Runs the club operations', requires: [] },
        { id: 'moderator', label: 'Moderator', description: null, requires: [] },
        { id: 'operator_pii', label: 'Operator PII', description: 'Sees parents’ phone numbers', requires: ['operator'] },
      ],
    });
    expect((await get('roles/declared', 'gh:2')).status).toBe(403);
    expect((await get('roles/declared', null)).status).toBe(401);
  });

  it('refuses a manifest whose gates name an undeclared role, and keeps the previous declaration', async () => {
    expect((await register({ ...PARENTS_CLUBS, roles: ROLES })).status).toBe(200);
    validates();
    const typo = await SELF.fetch(`${BASE}/v1/apps/parents-clubs/tools`, json('PUT', { ...PARENTS_CLUBS, roles: [ROLES[0]] }, await session('gh:1')));
    expect(typo.status).toBe(400);
    expect(await typo.json()).toEqual({ error: 'action "op_uphold_flag" auth.app_roles: role "moderator" is not declared in roles' });
    expect(((await (await get('roles/declared')).json()) as { roles: unknown[] }).roles).toHaveLength(3);
  });

  it('a manifest without roles clears the declaration, and the owner holds only grants again', async () => {
    expect((await register({ ...PARENTS_CLUBS, roles: ROLES })).status).toBe(200);
    expect(await has('gh:1', 'operator')).toBe(true);
    expect((await register(PARENTS_CLUBS)).status).toBe(200);
    expect(await get('roles/declared').then((r) => r.json())).toEqual({ roles: [] });
    expect(await has('gh:1', 'operator')).toBe(false);
    expect(await rolesMe('gh:1')).toEqual([]);
  });
});

describe('the owner holds every declared role (#695)', () => {
  it('roles/me and roles/check: the owner and a team owner hold the declared roles; nobody else does', async () => {
    expect((await register({ ...PARENTS_CLUBS, roles: ROLES })).status).toBe(200);
    await env.DB.prepare("INSERT INTO app_roles (app_id, user_id, role_name) VALUES ('parents-clubs', 'gh:1', 'member')").run();
    expect(await rolesMe('gh:1')).toEqual(['member', 'moderator', 'operator', 'operator_pii']);
    expect(await has('gh:1', 'operator_pii')).toBe(true);
    // Only declared roles: an undeclared name is not implied.
    expect(await has('gh:1', 'editor')).toBe(false);

    expect(await rolesMe('gh:2')).toEqual([]);
    expect(await has('gh:2', 'operator')).toBe(false);
    // A platform admin is not the app's owner.
    expect(await rolesMe('gh:9', ['user', 'admin'])).toEqual([]);

    await env.DB.prepare("INSERT INTO team_members (app_id, user_id, role, created_at) VALUES ('parents-clubs', 'gh:3', 'admin', 0)").run();
    expect(await rolesMe('gh:3')).toEqual([]);
    await env.DB.prepare("UPDATE team_members SET role = 'owner' WHERE app_id = 'parents-clubs' AND user_id = 'gh:3'").run();
    expect(await rolesMe('gh:3')).toEqual(['moderator', 'operator', 'operator_pii']);
  });

  it('an app with no roles block keeps today’s behaviour: the owner holds only what was granted', async () => {
    expect((await register(PARENTS_CLUBS)).status).toBe(200);
    expect(await has('gh:1', 'operator')).toBe(false);
    const res = await get('operator/resources/parents');
    expect(res.status).toBe(403);
    expect(await res.text()).toContain('requires app role');
  });

  it('an action gated by a declared role runs for the owner, audited as owner-held; a grant is audited as a grant', async () => {
    expect((await register({ ...PARENTS_CLUBS, roles: ROLES })).status).toBe(200);
    const run = async (uid: string) => SELF.fetch(`${BASE}/v1/apps/parents-clubs/actions/op_list_parents`, json('POST', { params: {} }, await session(uid)));

    const refused = await run('gh:2');
    expect(refused.status).toBe(403);
    expect(await refused.json()).toMatchObject({ error: 'requires app role' });

    dataWorker().intercept({ path: '/query', method: 'POST' }).reply(200, { rows: [], meta: {} });
    const owner = await run('gh:1');
    expect(owner.status, await owner.clone().text()).toBe(200);

    await env.DB.prepare("INSERT INTO app_roles (app_id, user_id, role_name) VALUES ('parents-clubs', 'gh:2', 'operator')").run();
    dataWorker().intercept({ path: '/query', method: 'POST' }).reply(200, { rows: [], meta: {} });
    expect((await run('gh:2')).status).toBe(200);

    expect(await audit()).toEqual([
      { actor_id: 'gh:1', action_name: 'op_list_parents', role_name: 'operator', role_via_owner: 1, operator_action: null },
      { actor_id: 'gh:2', action_name: 'op_list_parents', role_name: 'operator', role_via_owner: 0, operator_action: null },
    ]);
  });

  it('the owner’s granted role is audited as the grant, not as ownership', async () => {
    expect((await register({ ...PARENTS_CLUBS, roles: ROLES })).status).toBe(200);
    await env.DB.prepare("INSERT INTO app_roles (app_id, user_id, role_name) VALUES ('parents-clubs', 'gh:1', 'operator')").run();
    dataWorker().intercept({ path: '/query', method: 'POST' }).reply(200, { rows: [], meta: {} });
    const res = await SELF.fetch(`${BASE}/v1/apps/parents-clubs/actions/op_list_parents`, json('POST', { params: {} }, await session('gh:1')));
    expect(res.status).toBe(200);
    expect(await audit()).toEqual([{ actor_id: 'gh:1', action_name: 'op_list_parents', role_name: 'operator', role_via_owner: 0, operator_action: null }]);
  });

  it('the operator view and its audit trail admit the owner under the declared roles, and the trail says so', async () => {
    expect((await register({ ...PARENTS_CLUBS, roles: ROLES })).status).toBe(200);
    dataWorker().intercept({ path: '/query', method: 'POST' }).reply(200, { rows: [], meta: {} });
    const read = await get('operator/resources/parents');
    expect(read.status, await read.clone().text()).toBe(200);

    const trail = await get('operator/audit');
    expect(trail.status, await trail.clone().text()).toBe(200);
    const body = (await trail.json()) as { rows: { kind: string; role: string | null; role_via_owner: boolean }[] };
    expect(body.rows.map((r) => [r.kind, r.role, r.role_via_owner])).toEqual([['read', 'operator', true]]);
    // Reading the trail is itself recorded, under the owner-held audit role.
    expect(await audit()).toEqual([
      { actor_id: 'gh:1', action_name: 'op_list_parents', role_name: 'operator', role_via_owner: 1, operator_action: 'read:parents' },
      { actor_id: 'gh:1', action_name: '', role_name: 'operator', role_via_owner: 1, operator_action: 'audit' },
    ]);
  });
});

describe('requires: granted and revoked together (#695)', () => {
  const roles = async (uid: string) =>
    ((await env.DB.prepare("SELECT role_name FROM app_roles WHERE app_id = 'parents-clubs' AND user_id = ? ORDER BY role_name").bind(uid).all<{ role_name: string }>()).results ?? []).map((r) => r.role_name);
  const change = async (method: 'POST' | 'DELETE', role: string) =>
    SELF.fetch(`${BASE}/v1/apps/parents-clubs/roles`, json(method, { userId: 'gh:2', role }, await session('gh:1')));

  beforeEach(async () => { expect((await register({ ...PARENTS_CLUBS, roles: ROLES })).status).toBe(200); });

  it('granting a role grants what it requires; revoking a required role revokes what requires it', async () => {
    const granted = await change('POST', 'operator_pii');
    expect(granted.status).toBe(200);
    expect(await granted.json()).toMatchObject({ role: 'operator_pii', requiredRoles: ['operator'] });
    expect(await roles('gh:2')).toEqual(['operator', 'operator_pii']);

    const revoked = await change('DELETE', 'operator');
    expect(await revoked.json()).toMatchObject({ revoked: true, role: 'operator', dependentRoles: ['operator_pii'] });
    expect(await roles('gh:2')).toEqual([]);
  });

  it('revoking the dependent role leaves the one it requires', async () => {
    await change('POST', 'operator_pii');
    expect(await (await change('DELETE', 'operator_pii')).json()).toMatchObject({ revoked: true, dependentRoles: [] });
    expect(await roles('gh:2')).toEqual(['operator']);
  });

  it('an undeclared role is granted alone, as before', async () => {
    expect(await (await change('POST', 'editor')).json()).toMatchObject({ role: 'editor', requiredRoles: [] });
    expect(await roles('gh:2')).toEqual(['editor']);
  });
});
