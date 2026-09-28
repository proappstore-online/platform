import { SELF, env, fetchMock } from 'cloudflare:test';
import { mintSession } from '@proappstore/build-core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BASE, json, mockNetwork, seedApp, seedUser, session, resetTables } from './helpers';
import { STASH } from '../../../backend/src/__fixtures__/operator-view';

// #240 regression, on real D1: every console operator route refuses every
// caller who is not the app's owner, against an app that HAS a registered
// contract. Nothing is served and nothing joins the app's audit trail.

const ROUTES: { method: 'GET' | 'POST'; path: string; body?: unknown }[] = [
  { method: 'GET', path: '/v1/apps/stash/operator' },
  { method: 'GET', path: '/v1/apps/stash/operator/resources/members' },
  { method: 'GET', path: '/v1/apps/stash/operator/resources/members/records/u001' },
  { method: 'GET', path: '/v1/apps/stash/operator/resources/kyc/records/k1/evidence/document_path' },
  { method: 'POST', path: '/v1/apps/stash/operator/actions/suspend_member', body: { row: { user_id: 'u001' } } },
  { method: 'GET', path: '/v1/apps/stash/operator/metrics/growth' },
  { method: 'POST', path: '/v1/apps/stash/operator/entries', body: { visit: 'visit-0001' } },
  { method: 'GET', path: '/v1/apps/stash/operator/audit' },
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
    expect(text, route.path).not.toMatch(/usersWithRoles|"contract"|"rows"|"record"|"series"/);
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
