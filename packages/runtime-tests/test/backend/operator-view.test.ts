import { SELF, env, fetchMock } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BASE, json, mockNetwork, seedApp, seedUser, session, resetTables } from './helpers';
import { PARENTS_CLUBS, STASH } from '../../../backend/src/__fixtures__/operator-view';

// #240: the console operator view is owner-only, on real D1 with the root
// migrations — the baseline queries must run against the real schema, and
// nobody but the app's owner may enter or read it.

afterEach(() => fetchMock.assertNoPendingInterceptors());
beforeEach(async () => {
  mockNetwork();
  await resetTables();
  for (const t of ['usage_daily', 'app_operator_view', 'app_action_audit']) await env.DB.prepare(`DELETE FROM ${t}`).run();
  await seedUser('gh:1', 'owner');
  await seedUser('gh:2', 'other-owner');
  await seedUser('gh:3', 'teammate');
  await seedApp('stash', 'gh:1');
  await seedApp('bingo', 'gh:2');
  const today = new Date().toISOString().slice(0, 10);
  await env.DB.prepare(
    "INSERT INTO usage_daily (app_id, user_id, day, session_seconds, api_calls, last_seen) VALUES ('stash', 'gh:10', ?1, 60, 5, 0), ('stash', 'gh:11', ?1, 30, 2, 0), ('bingo', 'gh:12', ?1, 999, 999, 0)",
  ).bind(today).run();
  await env.DB.prepare(
    "INSERT INTO app_roles (app_id, user_id, role_name) VALUES ('stash', 'gh:10', 'member'), ('stash', 'gh:10', 'moderator'), ('bingo', 'gh:12', 'member')",
  ).run();
});

const view = (appId: string, token?: string) => SELF.fetch(`${BASE}/v1/apps/${appId}/operator`, json('GET', undefined, token));

describe('console operator view (#240)', () => {
  it("gives the owner their app's baseline, counting only that app", async () => {
    const res = await view('stash', await session('gh:1'));
    expect(res.status, await res.clone().text()).toBe(200);
    expect(await res.json()).toMatchObject({
      app: { id: 'stash' },
      operator: { userId: 'gh:1' },
      baseline: { usersWithRoles: 1, activity: { days: 30, activeUsers: 2, sessionSeconds: 90, apiCalls: 7 } },
    });
  });

  it('refuses a signed-out caller', async () => {
    const res = await view('stash');
    expect(res.status).toBe(401);
    expect(await res.text()).not.toContain('usersWithRoles');
  });

  it("refuses another app's owner", async () => {
    const res = await view('stash', await session('gh:2'));
    expect(res.status).toBe(403);
    expect(await res.text()).not.toContain('usersWithRoles');
  });

  it('refuses a team member below owner, and admits a team owner', async () => {
    await env.DB.prepare("INSERT INTO team_members (app_id, user_id, role, created_at) VALUES ('stash', 'gh:3', 'admin', 0)").run();
    expect((await view('stash', await session('gh:3'))).status).toBe(403);
    await env.DB.prepare("UPDATE team_members SET role = 'owner' WHERE app_id = 'stash' AND user_id = 'gh:3'").run();
    expect((await view('stash', await session('gh:3'))).status).toBe(200);
  });
});

// #240 child 2: the operator-view contract, registered through the real PUT on
// real D1 (migration 0063), served only to the owner, and granting nothing.
describe('operator-view contract (#240)', () => {
  const validates = (appId: string) =>
    fetchMock.get(`https://pas-data-${appId}.${env.DATA_WORKER_HOST}`).intercept({ path: '/validate', method: 'POST' })
      .reply(200, (req) => ({ results: (JSON.parse(String(req.body)) as { statements: { id: string }[] }).statements.map((st) => ({ id: st.id, ok: true })) }));
  const register = async (appId: string, body: unknown, uid = 'gh:1') => {
    validates(appId);
    return SELF.fetch(`${BASE}/v1/apps/${appId}/tools`, json('PUT', body, await session(uid)));
  };

  beforeEach(async () => { await seedApp('parents-clubs', 'gh:1'); });

  it('two different apps register through the same path; each owner reads back only their own contract', async () => {
    for (const [appId, sample] of [['stash', STASH], ['parents-clubs', PARENTS_CLUBS]] as const) {
      const reg = await register(appId, sample);
      expect(reg.status, await reg.clone().text()).toBe(200);
      const res = await view(appId, await session('gh:1'));
      const body = (await res.json()) as { contract: { version: number; resources: { id: string; kind: string }[]; actions: { id: string }[] } };
      expect(body.contract.version).toBe(1);
      expect(body.contract.resources.map((r) => r.id)).toEqual(sample.operator_view.resources.map((r) => r.id));
    }
    const row = await env.DB.prepare("SELECT version FROM app_operator_view WHERE app_id = 'parents-clubs'").first<{ version: number }>();
    expect(row?.version).toBe(1);
  });

  it('never reaches a signed-out caller, another owner, or the public tool listing MCP discovery reads', async () => {
    expect((await register('stash', STASH)).status).toBe(200);
    expect((await view('stash')).status).toBe(401);
    const other = await view('stash', await session('gh:2'));
    expect(other.status).toBe(403);
    expect(await other.text()).not.toContain('open_reports');
    // Another owner cannot register one on an app they do not own.
    const hijack = await SELF.fetch(`${BASE}/v1/apps/stash/tools`, json('PUT', STASH, await session('gh:2')));
    expect(hijack.status).toBe(403);
    // Discovery is unchanged: the anonymous listing still names the tools, and carries no contract or SQL.
    const listing = await SELF.fetch(`${BASE}/v1/apps/stash/tools`);
    const text = await listing.text();
    expect(listing.status).toBe(200);
    expect(JSON.parse(text).tools.map((t: { name: string }) => t.name)).toContain('op_suspend_user');
    expect(text).not.toContain('operator_view');
    expect(text).not.toContain('UPDATE members');
  });

  it('an invalid contract is refused and leaves the previous one in place', async () => {
    expect((await register('stash', STASH)).status).toBe(200);
    const bad = await SELF.fetch(`${BASE}/v1/apps/stash/tools`, json('PUT', { ...STASH, operator_view: { ...STASH.operator_view, version: 2 } }, await session('gh:1')));
    expect(bad.status).toBe(400);
    const row = await env.DB.prepare("SELECT contract FROM app_operator_view WHERE app_id = 'stash'").first<{ contract: string }>();
    expect(JSON.parse(row!.contract).version).toBe(1);
  });

  it('declaring nothing clears it back to the baseline', async () => {
    expect((await register('stash', STASH)).status).toBe(200);
    expect((await register('stash', { tools: STASH.tools })).status).toBe(200);
    expect(((await (await view('stash', await session('gh:1'))).json()) as { contract: unknown }).contract).toBeNull();
  });

  it('grants nothing: the owner runs its actions under the ordinary role check, audited once granted', async () => {
    expect((await register('stash', STASH)).status).toBe(200);
    const run = async () => SELF.fetch(`${BASE}/v1/apps/stash/actions/op_suspend_user`, json('POST', { params: { user_id: 'gh:10' } }, await session('gh:1')));
    const denied = await run();
    expect(denied.status).toBe(403);
    expect(await denied.text()).toContain('requires app role');

    await env.DB.prepare("INSERT INTO app_roles (app_id, user_id, role_name) VALUES ('stash', 'gh:1', 'operator')").run();
    fetchMock.get(`https://pas-data-stash.${env.DATA_WORKER_HOST}`).intercept({ path: '/execute', method: 'POST' }).reply(200, { meta: { changes: 1 } });
    const granted = await run();
    expect(granted.status, await granted.clone().text()).toBe(200);
    const audit = await env.DB.prepare("SELECT actor_id, role_name FROM app_action_audit WHERE app_id = 'stash' AND action_name = 'op_suspend_user'").all();
    expect(audit.results).toEqual([{ actor_id: 'gh:1', role_name: 'operator' }]);
  });
});

// #240 slice 3: the users view on real D1 — registered through the real PUT,
// the real app_roles gate and app_action_audit, the data worker intercepted.
describe('operator users view (#240 slice 3)', () => {
  const validates = (appId: string) =>
    fetchMock.get(`https://pas-data-${appId}.${env.DATA_WORKER_HOST}`).intercept({ path: '/validate', method: 'POST' })
      .reply(200, (req) => ({ results: (JSON.parse(String(req.body)) as { statements: { id: string }[] }).statements.map((st) => ({ id: st.id, ok: true })) }));
  let queried: { app: string; params: unknown[] }[] = [];
  const answers = (appId: string, rows: Record<string, unknown>[]) =>
    fetchMock.get(`https://pas-data-${appId}.${env.DATA_WORKER_HOST}`).intercept({ path: '/query', method: 'POST' })
      .reply(200, (req) => { queried.push({ app: appId, params: (JSON.parse(String(req.body)) as { params: unknown[] }).params }); return { rows, meta: {} }; });
  const get = async (path: string, uid: string | null = 'gh:1') =>
    SELF.fetch(`${BASE}/v1/apps/${path}`, json('GET', undefined, uid ? await session(uid) : undefined));
  const grant = (appId: string) => env.DB.prepare("INSERT INTO app_roles (app_id, user_id, role_name) VALUES (?, 'gh:1', 'operator')").bind(appId).run();

  beforeEach(async () => {
    queried = [];
    await seedApp('parents-clubs', 'gh:1');
    for (const [appId, sample] of [['stash', STASH], ['parents-clubs', PARENTS_CLUBS]] as const) {
      validates(appId);
      const res = await SELF.fetch(`${BASE}/v1/apps/${appId}/tools`, json('PUT', sample, await session('gh:1')));
      expect(res.status, await res.clone().text()).toBe(200);
    }
  });

  it('pages and searches with only declared columns; every granted read is audited', async () => {
    await grant('stash');
    answers('stash', Array.from({ length: 50 }, (_, i) => ({ user_id: `u${i + 10}`, display_name: `M${i}`, created_at: 1, suspended: 0, email: 'x@y', password_hash: 'h' })));
    const first = await get('stash/operator/resources/members?q=M');
    expect(first.status, await first.clone().text()).toBe(200);
    const page1 = (await first.json()) as { rows: Record<string, unknown>[]; next_cursor: string };
    expect(page1.next_cursor).toBe('u59');
    expect(Object.keys(page1.rows[0]!)).toEqual(['display_name', 'user_id', 'created_at', 'suspended']);

    answers('stash', [{ user_id: 'u60', display_name: 'Last', created_at: 1, suspended: 1, password_hash: 'h' }]);
    const page2 = (await (await get(`stash/operator/resources/members?q=M&cursor=${page1.next_cursor}`)).json()) as { rows: unknown[]; next_cursor: unknown };
    expect(page2).toEqual({ rows: [{ display_name: 'Last', user_id: 'u60', created_at: 1, suspended: 1 }], next_cursor: null });
    expect(queried.map((q) => q.params)).toEqual([expect.arrayContaining(['M']), expect.arrayContaining(['M', 'u59'])]);

    const audit = await env.DB.prepare("SELECT action_name, actor_id, role_name FROM app_action_audit WHERE app_id = 'stash'").all();
    expect(audit.results).toEqual([
      { action_name: 'op_list_users', actor_id: 'gh:1', role_name: 'operator' },
      { action_name: 'op_list_users', actor_id: 'gh:1', role_name: 'operator' },
    ]);
  });

  it('detail returns the declared fields only', async () => {
    await grant('stash');
    answers('stash', [{ user_id: 'u10', display_name: 'Ada', email: 'ada@x', pocket_count: 3, created_at: 1, password_hash: 'h' }]);
    const res = await get('stash/operator/resources/members/records/u10');
    expect(await res.json()).toEqual({ record: { display_name: 'Ada', user_id: 'u10', email: 'ada@x', pocket_count: 3, created_at: 1 } });
    expect(queried[0]!.params).toEqual(['u10']);
  });

  it('refuses signed-out callers, other owners, and the owner until they hold the declared role', async () => {
    expect((await get('stash/operator/resources/members', null)).status).toBe(401);
    expect((await get('stash/operator/resources/members', 'gh:2')).status).toBe(403);
    expect((await get('stash/operator/resources/members/records/u10', 'gh:2')).status).toBe(403);
    const noRole = await get('stash/operator/resources/members');
    expect(noRole.status).toBe(403);
    expect(await noRole.text()).toContain('requires app role');
    expect(queried).toHaveLength(0);
    expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM app_action_audit').first<{ n: number }>())!.n).toBe(0);
  });

  it('isolates apps and keeps the baseline: other-app, undeclared and contract-less resources are 404', async () => {
    await grant('parents-clubs');
    expect((await get('parents-clubs/operator/resources/members')).status).toBe(404); // Stash's resource id
    expect((await get('bingo/operator/resources/members', 'gh:2')).status).toBe(404); // bingo declares nothing
    answers('parents-clubs', [{ user_id: 'p1', full_name: 'Grace', club_name: 'Chess', verified: 1, phone: '555' }]);
    const parents = await get('parents-clubs/operator/resources/parents?q=gra');
    expect(await parents.json()).toEqual({ rows: [{ full_name: 'Grace', club_name: 'Chess', verified: 1, user_id: 'p1' }], next_cursor: null });
    expect(queried).toEqual([{ app: 'parents-clubs', params: expect.arrayContaining(['gra']) }]);
  });
});

