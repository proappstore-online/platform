import { SELF, env, fetchMock } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BASE, json, mockNetwork, seedApp, seedUser, session, resetTables } from './helpers';
import { STASH } from '../../../backend/src/__fixtures__/operator-view';

// #245 on real D1: app-wide aggregates in the operator view. The platform
// baseline renders for an app that declares nothing; declared KPI panels are
// one row of numbers, whatever the app's query returns, for the owner only.

const worker = () => fetchMock.get(`https://pas-data-stash.${env.DATA_WORKER_HOST}`);
const get = async (path: string, uid: string | null = 'gh:1') => SELF.fetch(`${BASE}/v1/apps/${path}`, json('GET', undefined, uid ? await session(uid) : undefined));

afterEach(() => fetchMock.assertNoPendingInterceptors());
beforeEach(async () => {
  mockNetwork();
  await resetTables();
  for (const t of ['usage_daily', 'app_operator_view', 'app_action_audit']) await env.DB.prepare(`DELETE FROM ${t}`).run();
  await seedUser('gh:1', 'owner');
  await seedUser('gh:2', 'other-owner');
  await seedApp('stash', 'gh:1');
  await seedApp('bingo', 'gh:2');
  const today = new Date().toISOString().slice(0, 10);
  await env.DB.prepare(
    "INSERT INTO usage_daily (app_id, user_id, day, session_seconds, api_calls, last_seen) VALUES ('stash', 'gh:10', ?1, 60, 5, 0), ('bingo', 'gh:12', ?1, 30, 3, 0), ('bingo', 'gh:13', ?1, 10, 1, 0)",
  ).bind(today).run();
  await env.DB.prepare("INSERT INTO app_roles (app_id, user_id, role_name) VALUES ('stash', 'gh:1', 'operator'), ('bingo', 'gh:12', 'member')").run();
  worker().intercept({ path: '/validate', method: 'POST' })
    .reply(200, (req) => ({ results: (JSON.parse(String(req.body)) as { statements: { id: string }[] }).statements.map((st) => ({ id: st.id, ok: true })) }));
  expect((await SELF.fetch(`${BASE}/v1/apps/stash/tools`, json('PUT', STASH, await session('gh:1')))).status).toBe(200);
});

describe('app-wide aggregate metrics (#245)', () => {
  it('the platform baseline renders for an app that declares nothing, counting only that app', async () => {
    const res = await get('bingo/operator', 'gh:2');
    expect(res.status, await res.clone().text()).toBe(200);
    expect(await res.json()).toMatchObject({
      contract: null,
      baseline: { usersWithRoles: 1, activity: { days: 30, activeUsers: 2, sessionSeconds: 40, apiCalls: 4 } },
    });
  });

  it('a declared KPI panel is one row of numbers, whatever the query returns; the read is audited', async () => {
    worker().intercept({ path: '/query', method: 'POST' }).reply(200, {
      rows: [
        { open_reports: '12', suspended_users: 'ada@x.test', email: 'ada@x.test' },
        { open_reports: 1, suspended_users: 1, email: 'bo@x.test' },
      ],
      meta: {},
    });
    const res = await get('stash/operator/resources/moderation');
    expect(res.status, await res.clone().text()).toBe(200);
    const text = await res.text();
    expect(JSON.parse(text)).toEqual({ rows: [{ open_reports: 12, suspended_users: null }], next_cursor: null });
    expect(text).not.toMatch(/@/);
    expect(await env.DB.prepare("SELECT action_name, status, operator_action FROM app_action_audit WHERE app_id = 'stash'").all().then((r) => r.results))
      .toEqual([{ action_name: 'op_report_metrics', status: 200, operator_action: 'read:moderation' }]);
  });

  it('only the owner reads an app\'s aggregates: other owners and signed-out callers are refused, nothing is read', async () => {
    expect((await get('stash/operator/resources/moderation', null)).status).toBe(401);
    expect((await get('stash/operator/resources/moderation', 'gh:2')).status).toBe(403);
    expect((await get('stash/operator/metrics/growth?from=2026-09-01&to=2026-09-02', 'gh:2')).status).toBe(403);
    const other = await get('stash/operator', 'gh:2');
    expect(other.status).toBe(403);
    expect(await other.text()).not.toContain('usersWithRoles');
    expect((await get('bingo/operator', 'gh:1')).status).toBe(403);
    expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM app_action_audit').first<{ n: number }>())!.n).toBe(0);
  });

  it('a per-user query dressed as a KPI is refused at registration, and the previous contract stays', async () => {
    const leaky = {
      ...STASH,
      tools: [...STASH.tools, { ...STASH.tools.find((t) => t.name === 'op_report_metrics')!, name: 'op_leaky', sql: 'SELECT email, COUNT(*) AS n FROM members GROUP BY email' }],
      operator_view: { ...STASH.operator_view, resources: [...STASH.operator_view.resources, { id: 'leaky', kind: 'metrics', title: 'Leaky', action: 'op_leaky', columns: [{ key: 'email', label: 'Email' }, { key: 'n', label: 'N', format: 'number' }] }] },
    };
    const res = await SELF.fetch(`${BASE}/v1/apps/stash/tools`, json('PUT', leaky, await session('gh:1')));
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain('column "email" must have format "number"');
    const stored = JSON.parse((await env.DB.prepare("SELECT contract FROM app_operator_view WHERE app_id = 'stash'").first<{ contract: string }>())!.contract) as { resources: { id: string }[] };
    expect(stored.resources.map((r) => r.id)).not.toContain('leaky');
  });

  it('a contract stored before the check still serves numbers only', async () => {
    const row = await env.DB.prepare("SELECT contract FROM app_operator_view WHERE app_id = 'stash'").first<{ contract: string }>();
    const contract = JSON.parse(row!.contract) as { resources: { id: string; columns: { key: string; label: string; format: string }[] }[] };
    contract.resources.find((r) => r.id === 'moderation')!.columns[1]!.format = 'text';
    await env.DB.prepare("UPDATE app_operator_view SET contract = ? WHERE app_id = 'stash'").bind(JSON.stringify(contract)).run();
    worker().intercept({ path: '/query', method: 'POST' }).reply(200, { rows: [{ open_reports: 2, suspended_users: 'ada@x.test' }], meta: {} });
    const res = await get('stash/operator/resources/moderation');
    expect(await res.json()).toEqual({ rows: [{ open_reports: 2, suspended_users: null }], next_cursor: null });
  });
});
