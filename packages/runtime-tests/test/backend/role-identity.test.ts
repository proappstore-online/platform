import { SELF, env, fetchMock } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BASE, json, mockNetwork, resetTables, seedApp, seedUser, session } from './helpers';

/**
 * #272: app-role checks matched `app_roles.user_id` against the session's
 * `login` for every session kind — but a credential account's `login` is the
 * `displayName` its creator typed at sign-up. An anonymous sign-up named after
 * a role holder (their `gh:` id, or a legacy login-keyed grant) inherited that
 * holder's roles. These run the real register → login → role-check path in
 * workerd against real D1.
 */
afterEach(() => fetchMock.assertNoPendingInterceptors());
beforeEach(async () => {
  mockNetwork();
  await resetTables();
  await seedUser('gh:1', 'owner');
  await seedUser('gh:2', 'viewer');
  await seedApp('diary', 'gh:1');
  // gh:2 holds `viewer` by id; `bob` is a legacy grant keyed by GitHub login.
  await env.DB.prepare("INSERT INTO app_roles (app_id, user_id, role_name) VALUES ('diary', 'gh:2', 'viewer'), ('diary', 'bob', 'viewer')").run();
});

let n = 0;
/** A self-registered credential account (no invite, no GitHub) with the given display name; returns its session. */
async function credentialSession(displayName: string): Promise<string> {
  const email = `squat${Date.now()}-${n++}@example.com`;
  const password = 'correct-horse-battery-9';
  const reg = await SELF.fetch(`${BASE}/v1/auth/credentials/register`, json('POST', { email, password, displayName }));
  expect(reg.status).toBe(202);
  const res = await SELF.fetch(`${BASE}/v1/auth/credentials/login`, json('POST', { login: email, password }));
  expect(res.status).toBe(200);
  const { token } = (await res.json()) as { token: string };
  return token;
}

const rolesMe = async (token: string) =>
  ((await (await SELF.fetch(`${BASE}/v1/apps/diary/roles/me`, json('GET', undefined, token))).json()) as { roles: string[] }).roles;
const hasViewer = async (token: string) =>
  ((await (await SELF.fetch(`${BASE}/v1/apps/diary/roles/check/viewer`, json('GET', undefined, token))).json()) as { has: boolean }).has;

describe('app-role identity (#272)', () => {
  it('a credential account named after a role holder’s gh: id does not inherit the role', async () => {
    const tok = await credentialSession('gh:2');
    expect(await rolesMe(tok)).toEqual([]);
    expect(await hasViewer(tok)).toBe(false);
  });

  it('a credential account named after a legacy login-keyed grant does not inherit it', async () => {
    const tok = await credentialSession('bob');
    expect(await rolesMe(tok)).toEqual([]);
    expect(await hasViewer(tok)).toBe(false);
  });

  it('a Google session whose profile name equals a legacy login does not inherit it', async () => {
    const tok = await session('google:99', { login: 'bob', roles: ['user'] });
    expect(await rolesMe(tok)).toEqual([]);
  });

  it('the real holders still match: by id, and the GitHub user who owns a legacy login', async () => {
    expect(await rolesMe(await session('gh:2'))).toEqual(['viewer']);
    expect(await rolesMe(await session('gh:7', { login: 'bob' }))).toEqual(['viewer']);
  });

  it('ensure-member gives a squatter a fresh member row instead of treating the victim’s rows as theirs', async () => {
    const tok = await credentialSession('gh:2');
    const res = await SELF.fetch(`${BASE}/v1/apps/diary/roles/ensure-member`, json('POST', {}, tok));
    expect(await res.json()).toMatchObject({ ok: true, assigned: true });
    expect(await rolesMe(tok)).toEqual(['member']);
  });

  it('a role-gated action refuses the squatter (enforceActionAuth)', async () => {
    const tool = { name: 'viewer_notes', description: 'n', operation: 'query', sql: 'SELECT :__user_id AS x', params: {}, requires_auth: true, auth: { app_roles: ['viewer'] } };
    const dw = fetchMock.get(`https://pas-data-diary.${env.DATA_WORKER_HOST}`);
    dw.intercept({ path: '/validate', method: 'POST' }).reply(200, { results: [{ id: 'viewer_notes#0', ok: true }] });
    const reg = await SELF.fetch(`${BASE}/v1/apps/diary/tools`, json('PUT', { tools: [tool] }, await session('gh:1')));
    expect(reg.status).toBe(200);

    for (const name of ['gh:2', 'bob']) {
      const res = await SELF.fetch(`${BASE}/v1/apps/diary/actions/viewer_notes`, json('POST', { params: {} }, await credentialSession(name)));
      expect(res.status).toBe(403);
      expect(await res.json()).toMatchObject({ error: 'requires app role' });
    }

    dw.intercept({ path: '/query', method: 'POST' }).reply(200, { rows: [{ x: 1 }], meta: {} });
    const ok = await SELF.fetch(`${BASE}/v1/apps/diary/actions/viewer_notes`, json('POST', { params: {} }, await session('gh:2')));
    expect(ok.status).toBe(200);
  });
});
