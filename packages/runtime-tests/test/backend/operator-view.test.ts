import { SELF, env, fetchMock } from 'cloudflare:test';
import { mintSession } from '@proappstore/build-core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BASE, json, mockNetwork, seedApp, seedUser, session, resetTables } from './helpers';
import { Authenticator } from './webauthn';
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
    const run = async () => SELF.fetch(`${BASE}/v1/apps/stash/actions/op_resolve_report`, json('POST', { params: { report_id: 'r1', from_status: 'open' } }, await session('gh:1')));
    const denied = await run();
    expect(denied.status).toBe(403);
    expect(await denied.text()).toContain('requires app role');

    await env.DB.prepare("INSERT INTO app_roles (app_id, user_id, role_name) VALUES ('stash', 'gh:1', 'operator')").run();
    fetchMock.get(`https://pas-data-stash.${env.DATA_WORKER_HOST}`).intercept({ path: '/execute', method: 'POST' }).reply(200, { meta: { changes: 1 } });
    const granted = await run();
    expect(granted.status, await granted.clone().text()).toBe(200);
    const audit = await env.DB.prepare("SELECT actor_id, role_name FROM app_action_audit WHERE app_id = 'stash' AND action_name = 'op_resolve_report'").all();
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
    // Only the owner's own refused attempt is on the trail — never a success, never the stranger's.
    expect((await env.DB.prepare('SELECT actor_id, role_name, status, operator_action FROM app_action_audit').all()).results)
      .toEqual([{ actor_id: 'gh:1', role_name: '', status: 403, operator_action: 'read:members' }]);
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

// #240 reports & suspensions on real D1: migration 0064's audit columns, the
// real app_roles gate, transitions guarded by the app's SQL (data worker
// intercepted), step-up on destructive actions, related history, two apps.
describe('operator reports & suspensions (#240)', () => {
  const worker = (appId: string) => fetchMock.get(`https://pas-data-${appId}.${env.DATA_WORKER_HOST}`);
  let sent: { app: string; path: string; params: unknown }[] = [];
  const answer = (appId: string, path: string, reply: unknown) => worker(appId).intercept({ path, method: 'POST' })
    .reply(200, (req) => {
      const body = JSON.parse(String(req.body)) as { params?: unknown; statements?: { params: unknown }[] };
      sent.push({ app: appId, path, params: body.params ?? body.statements?.map((s) => s.params) });
      return reply;
    });
  const fresh = () => mintSession({ uid: 'gh:1', login: 'owner', avatarUrl: null, roles: ['user'], auth_time: Math.floor(Date.now() / 1000) - 5, auth_method: 'passkey', step_up_rp_id: 'console.proappstore.online' } as never, env.SESSION_SIGNING_KEY);
  const act = async (appId: string, id: string, row: unknown, token?: string) =>
    SELF.fetch(`${BASE}/v1/apps/${appId}/operator/actions/${id}`, json('POST', { row }, token ?? await session('gh:1')));
  const audit = (appId: string) => env.DB.prepare('SELECT action_name, actor_id, role_name, status, operator_action, target FROM app_action_audit WHERE app_id = ? ORDER BY id').bind(appId).all();
  const report = { report_id: 'r1', reported_user_id: 'u9', reason: 'spam', status: 'open', created_at: 1 };

  beforeEach(async () => {
    sent = [];
    await seedApp('parents-clubs', 'gh:1');
    for (const [appId, sample] of [['stash', STASH], ['parents-clubs', PARENTS_CLUBS]] as const) {
      worker(appId).intercept({ path: '/validate', method: 'POST' })
        .reply(200, (req) => ({ results: (JSON.parse(String(req.body)) as { statements: { id: string }[] }).statements.map((st) => ({ id: st.id, ok: true })) }));
      const res = await SELF.fetch(`${BASE}/v1/apps/${appId}/tools`, json('PUT', sample, await session('gh:1')));
      expect(res.status, await res.clone().text()).toBe(200);
    }
    await env.DB.prepare("INSERT INTO app_roles (app_id, user_id, role_name) VALUES ('stash', 'gh:1', 'operator'), ('parents-clubs', 'gh:1', 'moderator')").run();
  });

  it('migration 0064 adds the operator audit columns', async () => {
    const cols = (await env.DB.prepare('PRAGMA table_info(app_action_audit)').all<{ name: string; notnull: number }>()).results ?? [];
    expect(cols.filter((c) => ['operator_action', 'target'].includes(c.name))).toEqual([
      expect.objectContaining({ name: 'operator_action', notnull: 0 }), expect.objectContaining({ name: 'target', notnull: 0 }),
    ]);
  });

  it('runs a guarded transition, refuses a stale one, and audits both with action and target', async () => {
    answer('stash', '/execute', { meta: { changes: 1 } });
    const ok = await act('stash', 'resolve', { ...report, extra: 'ignored' });
    expect(ok.status, await ok.clone().text()).toBe(200);
    expect(sent[0]!.params).toEqual(expect.arrayContaining(['r1', 'open']));
    expect(JSON.stringify(sent)).not.toContain('ignored');

    answer('stash', '/execute', { meta: { changes: 0 } });
    expect((await act('stash', 'dismiss', report)).status).toBe(409);
    expect((await act('stash', 'review', { ...report, status: 'dismissed' })).status).toBe(409);
    expect(sent).toHaveLength(2); // the disallowed transition never reached the data worker

    expect((await audit('stash')).results).toEqual([
      { action_name: 'op_resolve_report', actor_id: 'gh:1', role_name: 'operator', status: 200, operator_action: 'resolve', target: 'r1' },
      { action_name: 'op_dismiss_report', actor_id: 'gh:1', role_name: 'operator', status: 409, operator_action: 'dismiss', target: 'r1' },
      // The transition refused before the data worker is a refusal row: no role granted, no target read from the row.
      { action_name: '', actor_id: 'gh:1', role_name: '', status: 409, operator_action: 'review', target: null },
    ]);
  });

  it('a destructive suspension needs a recent sign-in, then runs as one batch and is audited', async () => {
    const stale = await act('stash', 'suspend_reported', report);
    expect(stale.status).toBe(403);
    expect(await stale.text()).toContain('step_up_required');
    answer('stash', '/batch', { results: [{ meta: { changes: 1 } }, { meta: { changes: 1 } }] });
    const ok = await act('stash', 'suspend_reported', report, await fresh());
    expect(ok.status, await ok.clone().text()).toBe(200);
    expect(await ok.json()).toEqual({ ok: true, changes: 2 });
    expect(sent).toHaveLength(1);
    expect((await audit('stash')).results).toEqual([
      { action_name: '', actor_id: 'gh:1', role_name: '', status: 403, operator_action: 'suspend_reported', target: null },
      { action_name: 'op_suspend_user', actor_id: 'gh:1', role_name: 'operator', status: 200, operator_action: 'suspend_reported', target: 'u9' },
    ]);
  });

  it("lists a member's suspension history and filters reports by status", async () => {
    answer('stash', '/query', { rows: [{ suspension_id: 's1', user_id: 'u9', reason: 'spam', status: 'active', created_at: 1, lifted_at: null, internal: 'x' }] });
    const history = await SELF.fetch(`${BASE}/v1/apps/stash/operator/resources/suspension_history?related=u9`, json('GET', undefined, await session('gh:1')));
    expect(await history.json()).toEqual({ rows: [{ user_id: 'u9', reason: 'spam', status: 'active', created_at: 1, lifted_at: null, suspension_id: 's1' }], next_cursor: null });
    answer('stash', '/query', { rows: [] });
    expect((await SELF.fetch(`${BASE}/v1/apps/stash/operator/resources/open_reports?status=reviewing`, json('GET', undefined, await session('gh:1')))).status).toBe(200);
    expect(sent.map((s) => s.params)).toEqual([expect.arrayContaining(['u9']), expect.arrayContaining(['reviewing'])]);
    expect((await audit('stash')).results).toEqual([
      expect.objectContaining({ action_name: 'op_list_suspensions', operator_action: 'read:suspension_history', target: 'u9' }),
      expect.objectContaining({ action_name: 'op_list_reports', operator_action: 'read:open_reports', target: null }),
    ]);
  });

  it('refuses signed-out callers and other owners; Parents Clubs runs its own workflow under its own role', async () => {
    expect((await SELF.fetch(`${BASE}/v1/apps/stash/operator/actions/resolve`, json('POST', { row: report }))).status).toBe(401);
    expect((await act('stash', 'resolve', report, await session('gh:2'))).status).toBe(403);
    expect(sent).toHaveLength(0);
    answer('parents-clubs', '/execute', { meta: { changes: 1 } });
    const ok = await act('parents-clubs', 'uphold', { flag_id: 'f1', post_title: 'Hi', flagged_by: 'p2', state: 'new', flagged_at: 1 });
    expect(ok.status, await ok.clone().text()).toBe(200);
    expect((await audit('parents-clubs')).results).toEqual([
      { action_name: 'op_uphold_flag', actor_id: 'gh:1', role_name: 'moderator', status: 200, operator_action: 'uphold', target: 'f1' },
    ]);
    expect((await act('parents-clubs', 'resolve', report)).status).toBe(404);
  });
});

// #240 ID verification on real D1 + R2: the app's review-role configuration
// (#208), real review objects, and both audit trails (app_action_audit and
// storage_review_access).
describe('operator ID verification (#240)', () => {
  const worker = (appId: string) => fetchMock.get(`https://pas-data-${appId}.${env.DATA_WORKER_HOST}`);
  const rows = (appId: string, reply: Record<string, unknown>[]) => worker(appId).intercept({ path: '/query', method: 'POST' }).reply(200, { rows: reply, meta: {} });
  const fresh = () => mintSession({ uid: 'gh:1', login: 'owner', avatarUrl: null, roles: ['user'], auth_time: Math.floor(Date.now() / 1000) - 5, auth_method: 'passkey', step_up_rp_id: 'console.proappstore.online' } as never, env.SESSION_SIGNING_KEY);
  const get = async (path: string, token?: string) => SELF.fetch(`${BASE}/v1/apps/${path}`, json('GET', undefined, token ?? await fresh()));
  const kyc = { request_id: 'k1', user_id: 'gh:10', full_name: 'Ada', document_type: 'passport', status: 'pending', submitted_at: 1, document_path: '_review/u/gh:10/id.png', selfie_path: null, internal_score: 97 };

  beforeEach(async () => {
    for (const t of ['app_storage_config', 'storage_review_access', 'passkey_credentials', 'passkey_challenges']) await env.DB.prepare(`DELETE FROM ${t}`).run();
    await seedApp('parents-clubs', 'gh:1');
    for (const [appId, sample] of [['stash', STASH], ['parents-clubs', PARENTS_CLUBS]] as const) {
      worker(appId).intercept({ path: '/validate', method: 'POST' })
        .reply(200, (req) => ({ results: (JSON.parse(String(req.body)) as { statements: { id: string }[] }).statements.map((st) => ({ id: st.id, ok: true })) }));
      const res = await SELF.fetch(`${BASE}/v1/apps/${appId}/tools`, json('PUT', sample, await session('gh:1')));
      expect(res.status, await res.clone().text()).toBe(200);
      await env.DB.prepare("INSERT INTO app_roles (app_id, user_id, role_name) VALUES (?, 'gh:1', 'operator')").bind(appId).run();
      // The #208 review roles, set through the real route.
      const cfg = await SELF.fetch(`${BASE}/v1/apps/${appId}/storage-config`, json('PUT', { review_roles: ['operator'] }, await session('gh:1')));
      expect(cfg.status).toBe(200);
    }
    await env.STORAGE.put('stash/_review/u/gh:10/id.png', 'PNGDATA', { httpMetadata: { contentType: 'image/png' } });
    await env.STORAGE.put('parents-clubs/_review/u/p7/licence.pdf', '%PDF-1', { httpMetadata: { contentType: 'application/pdf' } });
  });

  it('the record page needs a recent sign-in and flags documents without their paths', async () => {
    expect((await get('stash/operator/resources/kyc/records/k1', await session('gh:1'))).status).toBe(403);
    rows('stash', [kyc]);
    const res = await get('stash/operator/resources/kyc/records/k1');
    const body = (await res.json()) as { record: Record<string, unknown> };
    expect(body.record).toMatchObject({ document_path: true, selfie_path: false, status: 'pending' });
    expect(JSON.stringify(body)).not.toMatch(/_review|internal_score/);
  });

  it('serves the evidence to a reviewer and writes both audit trails; nothing without the review role', async () => {
    rows('stash', [kyc]);
    const res = await get('stash/operator/resources/kyc/records/k1/evidence/document_path');
    expect(res.status, await res.clone().text()).toBe(200);
    expect(await res.text()).toBe('PNGDATA');
    expect(res.headers.get('cache-control')).toBe('private, no-store');
    expect((await env.DB.prepare("SELECT owner_id, path, actor_id, action FROM storage_review_access WHERE app_id = 'stash'").all()).results)
      .toEqual([{ owner_id: 'gh:10', path: 'id.png', actor_id: 'gh:1', action: 'read' }]);
    expect((await env.DB.prepare("SELECT action_name, operator_action, target FROM app_action_audit WHERE app_id = 'stash'").all()).results)
      .toEqual([{ action_name: 'op_kyc_detail', operator_action: 'evidence:kyc.document_path', target: 'k1' }]);

    await env.DB.prepare("UPDATE app_storage_config SET review_roles = '[\"reviewer\"]' WHERE app_id = 'stash'").run();
    const refused = await get('stash/operator/resources/kyc/records/k1/evidence/document_path');
    expect(refused.status).toBe(403);
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM storage_review_access").first<{ n: number }>())!.n).toBe(1);
  });

  it('a document needs the console passkey step-up (#244): a fresh OAuth sign-in is refused, the step-up token opens it', async () => {
    const githubFresh = await mintSession({ uid: 'gh:1', login: 'owner', avatarUrl: null, roles: ['user'], auth_time: Math.floor(Date.now() / 1000) - 5, auth_method: 'github' } as never, env.SESSION_SIGNING_KEY);
    const refused = await get('stash/operator/resources/kyc/records/k1/evidence/document_path', githubFresh);
    expect(refused.status).toBe(403);
    expect(await refused.json()).toMatchObject({ error: 'step_up_required', method: 'passkey' });
    expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM storage_review_access').first<{ n: number }>())!.n).toBe(0);

    // The console's own ceremony: register a passkey (fresh sign-in), then step up with it.
    const passkey = (path: string, token: string, body: unknown = {}) => SELF.fetch(`${BASE}/v1/auth/passkey/${path}`, {
      method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Origin: 'https://console.proappstore.online', 'Cf-Access-Jwt-Assertion': 'access-assertion' }, body: JSON.stringify(body),
    });
    const auth = await Authenticator.create('console.proappstore.online');
    const reg = (await (await passkey('register/options', githubFresh)).json()) as { challenge: string };
    expect((await passkey('register', githubFresh, await auth.attest(reg.challenge))).status).toBe(200);
    const opts = (await (await passkey('step-up/options', githubFresh)).json()) as { challenge: string };
    const stepped = await passkey('step-up', githubFresh, await auth.assert(opts.challenge));
    expect(stepped.status, await stepped.clone().text()).toBe(200);
    const { token } = (await stepped.json()) as { token: string };

    rows('stash', [kyc]);
    const doc = await get('stash/operator/resources/kyc/records/k1/evidence/document_path', token);
    expect(doc.status, await doc.clone().text()).toBe(200);
    expect(await doc.text()).toBe('PNGDATA');
    // Never cacheable, never sniffed, never scriptable.
    expect(doc.headers.get('cache-control')).toBe('private, no-store');
    expect(doc.headers.get('x-content-type-options')).toBe('nosniff');
    expect(doc.headers.get('content-security-policy')).toBe("default-src 'none'; frame-ancestors 'none'");
    expect(doc.headers.get('etag')).toBeNull();
    expect((await env.DB.prepare("SELECT actor_id, action FROM storage_review_access WHERE app_id = 'stash'").all()).results).toEqual([{ actor_id: 'gh:1', action: 'read' }]);

    // A decision with the same step-up is audited with its target.
    worker('stash').intercept({ path: '/execute', method: 'POST' }).reply(200, { meta: { changes: 1 } });
    const reject = await SELF.fetch(`${BASE}/v1/apps/stash/operator/actions/reject_kyc`, json('POST', { row: { request_id: 'k1', status: 'pending', full_name: 'Ada' } }, token));
    expect(reject.status, await reject.clone().text()).toBe(200);
    expect((await env.DB.prepare("SELECT action_name, status, operator_action, target FROM app_action_audit WHERE app_id = 'stash' ORDER BY id").all()).results).toEqual([
      { action_name: '', status: 403, operator_action: 'evidence:kyc.document_path', target: 'k1' }, // the refused OAuth attempt
      { action_name: 'op_kyc_detail', status: 200, operator_action: 'evidence:kyc.document_path', target: 'k1' },
      { action_name: 'op_reject_kyc', status: 200, operator_action: 'reject_kyc', target: 'k1' },
    ]);
  });

  it('approves with a recent sign-in under the guard, audited; refuses a stale session', async () => {
    const row = { request_id: 'k1', status: 'pending', full_name: 'Ada' };
    expect((await SELF.fetch(`${BASE}/v1/apps/stash/operator/actions/approve_kyc`, json('POST', { row }, await session('gh:1')))).status).toBe(403);
    worker('stash').intercept({ path: '/execute', method: 'POST' }).reply(200, { meta: { changes: 1 } });
    const ok = await SELF.fetch(`${BASE}/v1/apps/stash/operator/actions/approve_kyc`, json('POST', { row }, await fresh()));
    expect(ok.status, await ok.clone().text()).toBe(200);
    expect((await env.DB.prepare("SELECT action_name, status, operator_action, target FROM app_action_audit WHERE app_id = 'stash'").all()).results)
      .toEqual([
        { action_name: '', status: 403, operator_action: 'approve_kyc', target: null }, // the stale attempt
        { action_name: 'op_approve_kyc', status: 200, operator_action: 'approve_kyc', target: 'k1' },
      ]);
  });

  it("a second app (Parents Clubs) serves its licence PDF through the same route; other owners get nothing", async () => {
    rows('parents-clubs', [{ request_id: 'v1', parent_name: 'Grace', state: 'pending', submitted_at: 1, licence_path: '_review/u/p7/licence.pdf' }]);
    const res = await get('parents-clubs/operator/resources/id_checks/records/v1/evidence/licence_path');
    expect(res.status, await res.clone().text()).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/pdf');
    expect(await res.text()).toBe('%PDF-1');
    expect((await get('parents-clubs/operator/resources/id_checks/records/v1/evidence/licence_path', await session('gh:2'))).status).toBe(403);
  });
});

// #240 metric time series on real D1: registered through the real PUT, the
// real app_roles gate, the data worker intercepted; the audit row carries the
// range, never a value.
describe('operator metric time series (#240)', () => {
  const worker = (appId: string) => fetchMock.get(`https://pas-data-${appId}.${env.DATA_WORKER_HOST}`);
  let sent: unknown[] = [];
  const rows = (appId: string, reply: Record<string, unknown>[]) => worker(appId).intercept({ path: '/query', method: 'POST' })
    .reply(200, (req) => { sent.push((JSON.parse(String(req.body)) as { params: unknown }).params); return { rows: reply, meta: {} }; });
  const get = async (path: string, uid: string | null = 'gh:1') => SELF.fetch(`${BASE}/v1/apps/${path}`, json('GET', undefined, uid ? await session(uid) : undefined));

  beforeEach(async () => {
    sent = [];
    await seedApp('parents-clubs', 'gh:1');
    for (const [appId, sample] of [['stash', STASH], ['parents-clubs', PARENTS_CLUBS]] as const) {
      worker(appId).intercept({ path: '/validate', method: 'POST' })
        .reply(200, (req) => ({ results: (JSON.parse(String(req.body)) as { statements: { id: string }[] }).statements.map((st) => ({ id: st.id, ok: true })) }));
      const res = await SELF.fetch(`${BASE}/v1/apps/${appId}/tools`, json('PUT', sample, await session('gh:1')));
      expect(res.status, await res.clone().text()).toBe(200);
      await env.DB.prepare("INSERT INTO app_roles (app_id, user_id, role_name) VALUES (?, 'gh:1', 'operator')").bind(appId).run();
    }
  });

  it('serves a bounded, rolled-up series and audits only the range', async () => {
    rows('stash', [
      { day: '2026-09-01', plan: 'free', signups: 41 },
      { day: '2026-09-01', plan: 'pro', signups: 17 },
      { day: '2026-09-03', plan: 'team', signups: 3 },
      { day: '2026-09-03', plan: 'edu', signups: 2 },
    ]);
    const res = await get('stash/operator/metrics/growth?from=2026-09-01&to=2026-09-03');
    expect(res.status, await res.clone().text()).toBe(200);
    const body = await res.json() as { buckets: string[]; omitted: number; measures: { summary: number; series: { dimension: string; values: unknown[] }[] }[] };
    expect(body.buckets).toEqual(['2026-09-01', '2026-09-02', '2026-09-03']);
    expect(body.measures[0]!.summary).toBe(63);
    expect(body.measures[0]!.series.map((s) => [s.dimension, s.values])).toEqual([['free', [41, null, null]], ['pro', [17, null, null]], ['team', [null, null, 3]]]);
    expect(body.omitted).toBe(1);
    expect(sent).toEqual([expect.arrayContaining(['2026-09-01', '2026-09-03'])]);
    const audit = await env.DB.prepare("SELECT * FROM app_action_audit WHERE app_id = 'stash'").all<Record<string, unknown>>();
    expect(audit.results).toHaveLength(1);
    expect(audit.results![0]).toMatchObject({ action_name: 'op_daily_signups', operator_action: 'series:growth', target: '2026-09-01..2026-09-03/day', status: 200 });
    // No result value anywhere in the row: only who, what, the range and when.
    const { id, created_at: when, ...rest } = audit.results![0]!;
    void id; void when;
    for (const value of [41, 17, 63, 'free', 'pro']) expect(Object.values(rest), String(value)).not.toContain(value);
  });

  it('refuses oversized ranges before the query, other owners, and owners without the role', async () => {
    expect((await get('stash/operator/metrics/growth?from=2024-01-01&to=2026-09-01')).status).toBe(400);
    expect((await get('stash/operator/metrics/growth', null)).status).toBe(401);
    expect((await get('stash/operator/metrics/growth', 'gh:2')).status).toBe(403);
    await env.DB.prepare("DELETE FROM app_roles WHERE app_id = 'stash'").run();
    expect((await get('stash/operator/metrics/growth?from=2026-09-01&to=2026-09-03')).status).toBe(403);
    expect(sent).toHaveLength(0);
  });

  it('Parents Clubs gets its weekly measures through the same route; an empty range stays null', async () => {
    rows('parents-clubs', []);
    const res = await get('parents-clubs/operator/metrics/club_trends?from=2026-09-07&to=2026-09-20');
    const body = await res.json() as { grain: string; measures: { label: string; summary: unknown; series: { values: unknown[] }[] }[] };
    expect(body.grain).toBe('week');
    expect(body.measures.map((m) => [m.label, m.summary, m.series[0]!.values])).toEqual([
      ['Attendance', null, [null, null]], ['Events', null, [null, null]], ['Fees collected', null, [null, null]],
    ]);
    expect(sent).toEqual([expect.arrayContaining(['2026-09-07', '2026-09-20'])]);
  });
});

// #240 operator audit trail on real D1: entry exactly once per visit, owner
// refusals recorded once, strangers never, and a paged, filtered, redacted trail.
describe('operator audit trail (#240)', () => {
  const worker = (appId: string) => fetchMock.get(`https://pas-data-${appId}.${env.DATA_WORKER_HOST}`);
  const fresh = () => mintSession({ uid: 'gh:1', login: 'owner', avatarUrl: null, roles: ['user'], auth_time: Math.floor(Date.now() / 1000) - 5, auth_method: 'passkey', step_up_rp_id: 'console.proappstore.online' } as never, env.SESSION_SIGNING_KEY);
  const call = async (path: string, init: { method?: string; body?: unknown; uid?: string | null; token?: string } = {}) =>
    SELF.fetch(`${BASE}/v1/apps/${path}`, json(init.method ?? 'GET', init.body, init.token ?? (init.uid === null ? undefined : await session(init.uid ?? 'gh:1'))));
  const rows = async (appId: string) => (await env.DB.prepare('SELECT actor_id, role_name, status, operator_action, target FROM app_action_audit WHERE app_id = ? ORDER BY id').bind(appId).all()).results;
  type Trail = { rows: { kind: string; target: string | null; target_hidden: boolean; outcome: string; status: number }[]; next_cursor: string | null; targets_hidden: boolean };

  beforeEach(async () => {
    await seedApp('parents-clubs', 'gh:1');
    for (const [appId, sample] of [['stash', STASH], ['parents-clubs', PARENTS_CLUBS]] as const) {
      worker(appId).intercept({ path: '/validate', method: 'POST' })
        .reply(200, (req) => ({ results: (JSON.parse(String(req.body)) as { statements: { id: string }[] }).statements.map((st) => ({ id: st.id, ok: true })) }));
      const res = await SELF.fetch(`${BASE}/v1/apps/${appId}/tools`, json('PUT', sample, await session('gh:1')));
      expect(res.status, await res.clone().text()).toBe(200);
    }
    await env.DB.prepare("INSERT INTO app_roles (app_id, user_id, role_name) VALUES ('stash', 'gh:1', 'operator')").run();
    await env.DB.prepare('DELETE FROM app_action_audit').run();
  });

  it('records entry exactly once per visit, however often the console repeats it', async () => {
    const enter = (visit: string, uid = 'gh:1') => call('stash/operator/entries', { method: 'POST', body: { visit }, uid });
    const answers = await Promise.all([enter('visit-aaaaaaaa'), enter('visit-aaaaaaaa'), enter('visit-aaaaaaaa')]);
    expect(answers.map((r) => r.status)).toEqual([200, 200, 200]);
    expect(await enter('visit-aaaaaaaa').then((r) => r.json())).toEqual({ recorded: false });
    expect(await enter('visit-bbbbbbbb').then((r) => r.json())).toEqual({ recorded: true });
    expect((await enter('visit-cccccccc', 'gh:2')).status).toBe(403); // a stranger is refused and not written
    expect((await call('stash/operator/entries', { method: 'POST', body: { visit: 'visit-dddddddd' }, uid: null })).status).toBe(401);
    expect(await rows('stash')).toEqual([
      { actor_id: 'gh:1', role_name: '', status: 200, operator_action: 'enter', target: 'visit-aaaaaaaa' },
      { actor_id: 'gh:1', role_name: '', status: 200, operator_action: 'enter', target: 'visit-bbbbbbbb' },
    ]);
  });

  it('shows reads, decisions and refusals, pages them, filters them, and hides identity targets until a recent sign-in', async () => {
    await call('stash/operator/entries', { method: 'POST', body: { visit: 'visit-aaaaaaaa' } });
    worker('stash').intercept({ path: '/query', method: 'POST' }).reply(200, { rows: [], meta: {} });
    await call('stash/operator/resources/members');
    expect((await call('stash/operator/resources/kyc/records/k1')).status).toBe(403); // stale: refused, recorded
    worker('stash').intercept({ path: '/query', method: 'POST' }).reply(200, { rows: [{ request_id: 'k1', user_id: 'gh:10', full_name: 'Ada', document_type: 'passport', status: 'pending', submitted_at: 1 }], meta: {} });
    expect((await call('stash/operator/resources/kyc/records/k1', { token: await fresh() })).status).toBe(200);
    expect((await call('stash/operator/actions/review', { method: 'POST', body: { row: { report_id: 'r1', status: 'resolved' } } })).status).toBe(409);

    const stale = await (await call('stash/operator/audit')).json() as Trail;
    expect(stale.rows.map((r) => [r.kind, r.outcome, r.status, r.target, r.target_hidden])).toEqual([
      ['action', 'refused', 409, null, false],
      ['detail', 'success', 200, null, true],
      ['detail', 'refused', 403, null, true],
      ['read', 'success', 200, null, false],
      ['enter', 'success', 200, 'visit-aaaaaaaa', false],
    ]);
    expect(stale.targets_hidden).toBe(true);
    const text = JSON.stringify(stale);
    expect(text).not.toMatch(/Ada|passport|gh:10|Bearer|_review/);

    const revealed = await (await call('stash/operator/audit?kind=detail', { token: await fresh() })).json() as Trail;
    expect(revealed.rows.map((r) => [r.target, r.target_hidden])).toEqual([['k1', false], ['k1', false]]);
    const refused = await (await call('stash/operator/audit?outcome=refused')).json() as Trail;
    expect(refused.rows.map((r) => r.status)).toEqual([409, 403]);
    // The three trail reads above are on the trail too.
    expect((await rows('stash'))!.filter((r) => (r as { operator_action: string }).operator_action === 'audit')).toHaveLength(3);
  });

  it('pages 50 at a time with a working cursor', async () => {
    const now = Date.now();
    for (let i = 0; i < 60; i++) {
      await env.DB.prepare("INSERT INTO app_action_audit (app_id, action_name, actor_id, role_name, status, created_at, operator_action, target) VALUES ('stash', 'op_list_users', 'gh:1', 'operator', 200, ?, 'read:members', NULL)").bind(now + i).run();
    }
    const first = await (await call('stash/operator/audit?kind=read')).json() as Trail;
    expect(first.rows).toHaveLength(50);
    expect(first.next_cursor).not.toBeNull();
    const second = await (await call(`stash/operator/audit?kind=read&cursor=${first.next_cursor}`)).json() as Trail;
    expect(second.rows).toHaveLength(10);
    expect(second.next_cursor).toBeNull();
    expect((await call('stash/operator/audit?from=2020-01-01&to=2026-09-01')).status).toBe(400);
  });

  it('Parents Clubs declares an audit role: the owner needs it to read the trail; other owners never read it', async () => {
    const without = await call('parents-clubs/operator/audit');
    expect(without.status).toBe(403);
    expect(await without.text()).toContain('requires app role');
    await env.DB.prepare("INSERT INTO app_roles (app_id, user_id, role_name) VALUES ('parents-clubs', 'gh:1', 'operator')").run();
    expect((await call('parents-clubs/operator/audit')).status).toBe(200);
    expect((await call('parents-clubs/operator/audit', { uid: 'gh:2' })).status).toBe(403);
    expect(await rows('parents-clubs')).toEqual([
      { actor_id: 'gh:1', role_name: '', status: 403, operator_action: 'audit', target: null },
      { actor_id: 'gh:1', role_name: 'operator', status: 200, operator_action: 'audit', target: null },
    ]);
  });
});


// #294: categorical secret-field blocking, on real D1. One name per pattern
// family plus the `_internal` prefix: registration refuses each as a declared
// column, and a contract stored before the rule still never returns them — to
// the owner or anyone — nor writes them to the audit trail.
describe('operator sensitive-field blocking (#294)', () => {
  const FAMILIES: Record<string, string> = {
    password: 'password_hash', secret: 'client_secret', token: 'auth_token', key: 'api_key',
    hash: 'pin_hash', salt: 'password_salt', credential: 'aws_credentials', bearer: 'bearer_value', _internal: '_internal_notes',
  };
  const worker = () => fetchMock.get(`https://pas-data-stash.${env.DATA_WORKER_HOST}`);
  const validates = () => worker().intercept({ path: '/validate', method: 'POST' })
    .reply(200, (req) => ({ results: (JSON.parse(String(req.body)) as { statements: { id: string }[] }).statements.map((st) => ({ id: st.id, ok: true })) }));

  it('refuses to register a declared column from every family, with a clear error', async () => {
    for (const [family, key] of Object.entries(FAMILIES)) {
      const view = JSON.parse(JSON.stringify(STASH.operator_view)) as typeof STASH.operator_view;
      view.resources[0]!.columns[0]!.key = key;
      validates();
      const res = await SELF.fetch(`${BASE}/v1/apps/stash/tools`, json('PUT', { ...STASH, operator_view: view }, await session('gh:1')));
      const text = await res.text();
      expect(res.status, family).toBe(400);
      expect((JSON.parse(text) as { error: string }).error, family).toContain(`"${key}" matches the sensitive-field list`);
    }
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM app_operator_view WHERE app_id = 'stash'").first<{ n: number }>()).toEqual({ n: 0 });
  });

  it('never returns a declared secret-like column from a stored contract, to the owner, and never audits it', async () => {
    validates();
    const reg = await SELF.fetch(`${BASE}/v1/apps/stash/tools`, json('PUT', STASH, await session('gh:1')));
    expect(reg.status, await reg.clone().text()).toBe(200);
    await env.DB.prepare("INSERT INTO app_roles (app_id, user_id, role_name) VALUES ('stash', 'gh:1', 'operator')").run();
    // As if stored before the rule: append one column per family straight into the stored contract.
    const row = await env.DB.prepare("SELECT contract FROM app_operator_view WHERE app_id = 'stash'").first<{ contract: string }>();
    const contract = JSON.parse(row!.contract) as { resources: { id: string; columns: { key: string; label: string; format: string }[] }[] };
    const members = contract.resources.find((r) => r.id === 'members')!;
    for (const key of Object.values(FAMILIES)) members.columns.push({ key, label: key, format: 'text' });
    await env.DB.prepare("UPDATE app_operator_view SET contract = ? WHERE app_id = 'stash'").bind(JSON.stringify(contract)).run();

    const values = Object.fromEntries(Object.values(FAMILIES).map((key) => [key, `VALUE-OF-${key}`]));
    worker().intercept({ path: '/query', method: 'POST' })
      .reply(200, { rows: [{ user_id: 'u001', display_name: 'Ada', created_at: 1, suspended: 0, ...values }], meta: {} });
    const res = await SELF.fetch(`${BASE}/v1/apps/stash/operator/resources/members`, json('GET', undefined, await session('gh:1')));
    const text = await res.text();
    expect(res.status, text).toBe(200);
    expect(JSON.parse(text).rows).toEqual([{ display_name: 'Ada', user_id: 'u001', created_at: 1, suspended: 0 }]);
    for (const key of Object.values(FAMILIES)) {
      expect(text, key).not.toContain(key);
      expect(text, key).not.toContain(`VALUE-OF-${key}`);
    }

    const audit = await env.DB.prepare("SELECT * FROM app_action_audit WHERE app_id = 'stash'").all();
    expect(audit.results).toHaveLength(1);
    const trail = JSON.stringify(audit.results);
    for (const key of Object.values(FAMILIES)) expect(trail, key).not.toContain(`VALUE-OF-${key}`);
  });
});

// #295: the admin-authoring routes behind the MCP tools, on real D1. Owner-only,
// read-only, and they never call the data worker (no interceptor is set, and
// disableNetConnect fails any call), so no field value can appear.
describe('admin-console authoring routes (#295)', () => {
  const validates = () => fetchMock.get(`https://pas-data-stash.${env.DATA_WORKER_HOST}`).intercept({ path: '/validate', method: 'POST' })
    .reply(200, (req) => ({ results: (JSON.parse(String(req.body)) as { statements: { id: string }[] }).statements.map((st) => ({ id: st.id, ok: true })) }));

  beforeEach(async () => {
    validates();
    const put = await SELF.fetch(`${BASE}/v1/apps/stash/tools`, json('PUT', STASH, await session('gh:1')));
    expect(put.status, await put.clone().text()).toBe(200);
  });

  it('inspect: no gaps for a fresh contract; deleting a referenced action is flagged as action_missing', async () => {
    const inspect = async () => SELF.fetch(`${BASE}/v1/apps/stash/operator-view/inspect`, json('GET', undefined, await session('gh:1')));
    const fresh = await inspect();
    expect(fresh.status, await fresh.clone().text()).toBe(200);
    expect(await fresh.json()).toMatchObject({ app_id: 'stash', gaps: [], contract: { version: 1 } });

    const del = await SELF.fetch(`${BASE}/v1/apps/stash/tools/op_list_users`, json('DELETE', undefined, await session('gh:1')));
    expect(del.status).toBe(200);
    const body = (await (await inspect()).json()) as { gaps: { code: string; where: string }[]; resources: { id: string; renders: boolean }[] };
    expect(body.gaps).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'action_missing', where: 'resources[0]' })]));
    expect(body.resources.find((r) => r.id === 'members')).toMatchObject({ renders: false });
  });

  it('preview: validates a proposal with the real validator and renders it; nothing is stored', async () => {
    const before = await env.DB.prepare("SELECT contract FROM app_operator_view WHERE app_id = 'stash'").first<{ contract: string }>();
    const proposal = { ...STASH.operator_view, admin_access: { roles: ['support'] } };
    const res = await SELF.fetch(`${BASE}/v1/apps/stash/operator-view/preview`, json('POST', { operator_view: proposal }, await session('gh:1')));
    expect(res.status, await res.clone().text()).toBe(200);
    expect(await res.json()).toMatchObject({ valid: true, render: { access: { console: { owner: true, admin_roles: ['support'] } } } });
    const bad = await SELF.fetch(`${BASE}/v1/apps/stash/operator-view/preview`, json('POST', {
      operator_view: { ...STASH.operator_view, resources: [{ ...STASH.operator_view.resources[0], columns: [{ key: 'api_key', label: 'Key' }] }] },
    }, await session('gh:1')));
    expect(await bad.json()).toMatchObject({ valid: false, blocked_fields: [{ key: 'api_key', matched: 'key' }] });
    expect(await env.DB.prepare("SELECT contract FROM app_operator_view WHERE app_id = 'stash'").first<{ contract: string }>()).toEqual(before);
  });

  it("refuses another app's owner and a signed-out caller; capabilities need a session", async () => {
    for (const [method, path, body] of [['GET', '/v1/apps/stash/operator-view/inspect', undefined], ['POST', '/v1/apps/stash/operator-view/preview', { operator_view: STASH.operator_view }]] as const) {
      expect((await SELF.fetch(`${BASE}${path}`, json(method, body, await session('gh:2')))).status, path).toBe(403);
      expect((await SELF.fetch(`${BASE}${path}`, json(method, body))).status, path).toBe(401);
    }
    expect((await SELF.fetch(`${BASE}/v1/operator-view/capabilities`, json('GET'))).status).toBe(401);
    const caps = await SELF.fetch(`${BASE}/v1/operator-view/capabilities`, json('GET', undefined, await session('gh:2')));
    expect(await caps.json()).toMatchObject({ limits: { resources: 20, actions: 20 } });
  });
});

// #296: propose and security on real D1 — the role context comes from the real
// app_roles/apps/users join (including a GitHub creator's legacy login grant).
describe('admin-console propose / security routes (#296)', () => {
  beforeEach(async () => {
    fetchMock.get(`https://pas-data-stash.${env.DATA_WORKER_HOST}`).intercept({ path: '/validate', method: 'POST' })
      .reply(200, (req) => ({ results: (JSON.parse(String(req.body)) as { statements: { id: string }[] }).statements.map((st) => ({ id: st.id, ok: true })) }));
    const put = await SELF.fetch(`${BASE}/v1/apps/stash/tools`, json('PUT', STASH, await session('gh:1')));
    expect(put.status, await put.clone().text()).toBe(200);
  });

  it('propose: the validator verdict, and role warnings from who actually holds the roles', async () => {
    // The creator holds `auditor` through a legacy login-keyed grant; `helpdesk` is held by someone else.
    await env.DB.prepare("INSERT INTO app_roles (app_id, user_id, role_name) VALUES ('stash', 'owner', 'auditor'), ('stash', 'gh:3', 'helpdesk')").run();
    const view = { ...STASH.operator_view, audit: { app_roles: ['auditor'] }, admin_access: { roles: ['helpdesk', 'typo_role'] } };
    const res = await SELF.fetch(`${BASE}/v1/apps/stash/operator-view/propose`, json('POST', { operator_view: view }, await session('gh:1')));
    expect(res.status, await res.clone().text()).toBe(200);
    const body = (await res.json()) as { valid: boolean; passes_security_gates: boolean; security_issues: { code: string; message: string }[] };
    expect(body.valid).toBe(true);
    expect(body.passes_security_gates).toBe(true);
    const codes = body.security_issues.map((i) => `${i.code}:${i.message.match(/"([^"]+)"/)?.[1] ?? ''}`);
    expect(codes).toContain('undefined_role:typo_role');
    expect(codes.some((c) => c.startsWith('audit_role_unheld'))).toBe(false); // the creator holds auditor via the login alias
    expect(codes.some((c) => c === 'undefined_role:helpdesk')).toBe(false);
  });

  it('security: a declared secret column and a destructive action without step_up fail the gate; non-owners are refused', async () => {
    const view = JSON.parse(JSON.stringify(STASH.operator_view));
    view.resources[0].columns.push({ key: 'api_key', label: 'Key' });
    const tools = STASH.tools.map((t) => (t.name === 'op_suspend_user' ? { ...t, step_up: false } : t));
    const res = await SELF.fetch(`${BASE}/v1/apps/stash/operator-view/security`, json('POST', { operator_view: view, tools }, await session('gh:1')));
    const body = (await res.json()) as { passes_security_gates: boolean; issues: { code: string }[] };
    expect(body.passes_security_gates).toBe(false);
    expect(body.issues.map((i) => i.code)).toEqual(expect.arrayContaining(['secret_exposure', 'destructive_without_step_up']));
    for (const path of ['/v1/apps/stash/operator-view/security', '/v1/apps/stash/operator-view/propose']) {
      expect((await SELF.fetch(`${BASE}${path}`, json('POST', { operator_view: view }, await session('gh:2')))).status, path).toBe(403);
    }
  });
});
