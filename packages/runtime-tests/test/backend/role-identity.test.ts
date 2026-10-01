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
  return (await credentialAccount(displayName)).token;
}

/** As credentialSession, plus the account's PAS user id (`cred:…`). */
async function credentialAccount(displayName: string): Promise<{ token: string; id: string }> {
  const email = `squat${Date.now()}-${n++}@example.com`;
  const password = 'correct-horse-battery-9';
  // A distinct client address per account: registration is rate-limited per IP.
  const init = json('POST', { email, password, displayName });
  const reg = await SELF.fetch(`${BASE}/v1/auth/credentials/register`, { ...init, headers: { ...(init.headers as Record<string, string>), 'cf-connecting-ip': `203.0.113.${n % 250}` } });
  expect(reg.status).toBe(202);
  const res = await SELF.fetch(`${BASE}/v1/auth/credentials/login`, json('POST', { login: email, password }));
  expect(res.status).toBe(200);
  const { token } = (await res.json()) as { token: string };
  const row = await env.DB.prepare('SELECT id, login FROM users WHERE credential_email = ?1').bind(email).first<{ id: string; login: string }>();
  expect(row?.login).toBe(displayName);
  return { token, id: row!.id };
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

/**
 * #273 review: every other call site that binds the role subject, each with a
 * squatter case that passed on the pre-#272 code (verified by reverting the
 * routes locally) and a real-holder control so the refusal is not a blanket 403.
 * The squatter is always a self-registered credential account whose display
 * name is the victim's `gh:` id or a legacy login-keyed grant.
 */
describe('app-role identity at every role-checking call site (#272)', () => {
  beforeEach(async () => {
    for (const t of ['invites', 'app_invite_policies', 'app_group_admin_grants', 'app_storage_config', 'storage_review_access', 'app_operator_view', 'app_action_audit', 'notification_log', 'email_usage']) {
      await env.DB.prepare(`DELETE FROM ${t}`).run();
    }
  });

  it('email.ts: the editor grant behind /email/send', async () => {
    await env.DB.prepare("INSERT INTO app_roles (app_id, user_id, role_name) VALUES ('diary', 'gh:2', 'editor'), ('diary', 'bob', 'editor')").run();
    const send = (token: string) => SELF.fetch(`${BASE}/v1/email/send`, json('POST', { appId: 'diary', to: 'x@example.com', subject: 's', body: 'b' }, token));
    for (const name of ['gh:2', 'bob']) {
      const res = await send(await credentialSession(name));
      expect(res.status, name).toBe(403);
    }
    fetchMock.get('https://api.resend.com').intercept({ path: '/emails', method: 'POST' }).reply(200, { id: 'em_1' });
    expect((await send(await session('gh:2'))).status).toBe(200);
  });

  it('invites.ts inviteAccess: a delegate role is not inherited by name', async () => {
    await env.DB.prepare("INSERT INTO app_invite_policies (app_id, delegate_role, grantable_role, created_by, created_at) VALUES ('diary', 'viewer', 'member', 'gh:1', 0)").run();
    const list = (token: string) => SELF.fetch(`${BASE}/v1/apps/diary/invites`, json('GET', undefined, token));
    for (const name of ['gh:2', 'bob']) {
      const res = await list(await credentialSession(name));
      expect(res.status, name).toBe(403);
      expect(await res.text()).toBe('invite delegation not granted');
    }
    expect((await list(await session('gh:2'))).status).toBe(200);
  });

  it('invites.ts canDelegateRoleToGroup: a delegate cannot borrow a richer policy from a victim’s role', async () => {
    // The squatter is a genuine delegate (holds `lead` by id, administers group g1),
    // so inviteAccess lets them in; `lead` may grant `member` only. The victim gh:2
    // holds `viewer`, whose policy grants `editor`.
    const sq = await credentialAccount('gh:2');
    await env.DB.prepare(
      "INSERT INTO app_invite_policies (app_id, delegate_role, grantable_role, created_by, created_at) VALUES ('diary', 'lead', 'member', 'gh:1', 0), ('diary', 'viewer', 'editor', 'gh:1', 0)",
    ).run();
    await env.DB.prepare("INSERT INTO app_roles (app_id, user_id, role_name) VALUES ('diary', ?1, 'lead')").bind(sq.id).run();
    await env.DB.prepare("INSERT INTO app_group_admin_grants (app_id, group_id, user_id, granted_by, granted_at) VALUES ('diary', 'g1', ?1, 'gh:1', 0)").bind(sq.id).run();
    const invite = (role: string) => SELF.fetch(`${BASE}/v1/apps/diary/invites`, json('POST', { role, group: 'g1' }, sq.token));
    const editor = await invite('editor');
    expect(editor.status).toBe(403);
    expect(await editor.text()).toContain('not allowed to invite this role for this group');
    expect((await invite('member')).status).toBe(200);
  });

  it('operator-audit.ts trailRole: an owner without the declared audit role is refused', async () => {
    const sq = await credentialAccount('gh:2');
    await seedApp('ops', sq.id);
    await env.DB.prepare("INSERT INTO app_roles (app_id, user_id, role_name) VALUES ('ops', 'gh:2', 'auditor'), ('ops', 'bob', 'auditor')").run();
    await env.DB.prepare("INSERT INTO app_operator_view (app_id, version, contract, created_at) VALUES ('ops', 1, ?1, 0)")
      .bind(JSON.stringify({ version: 1, resources: [], audit: { app_roles: ['auditor'] } })).run();
    const trail = (token: string) => SELF.fetch(`${BASE}/v1/apps/ops/operator/audit`, json('GET', undefined, token));
    const res = await trail(sq.token);
    expect(res.status).toBe(403);
    expect(await res.text()).toContain('requires app role');
    const bob = await credentialAccount('bob');
    await env.DB.prepare("UPDATE apps SET creator_id = ?1 WHERE id = 'ops'").bind(bob.id).run();
    expect((await trail(bob.token)).status).toBe(403);
    // Control: the same owner, once granted the role by id, reads the trail.
    await env.DB.prepare("INSERT INTO app_roles (app_id, user_id, role_name) VALUES ('ops', ?1, 'auditor')").bind(bob.id).run();
    expect((await trail(bob.token)).status).toBe(200);
  });

  it('storage.ts holdsReviewRole: another user’s review document stays private', async () => {
    await env.DB.prepare("INSERT INTO app_storage_config (app_id, review_roles, updated_by, updated_at) VALUES ('diary', '[\"viewer\"]', 'gh:1', 0)").run();
    await env.STORAGE.put('diary/_review/u/gh:5/id.pdf', 'secret', { httpMetadata: { contentType: 'application/pdf' } });
    const read = (token: string) => SELF.fetch(`${BASE}/v1/apps/diary/storage/_review/u/gh%3A5/id.pdf`, json('GET', undefined, token));
    for (const name of ['gh:2', 'bob']) {
      const res = await read(await credentialSession(name));
      expect(res.status, name).toBe(403);
      expect(await res.text()).not.toBe('secret');
    }
    const ok = await read(await session('gh:2'));
    expect(ok.status).toBe(200);
    expect(await ok.text()).toBe('secret');
    await env.STORAGE.delete('diary/_review/u/gh:5/id.pdf');
  });

  it('notifications.ts isAppMember: a squatter is not a member, as sender or as recipient', async () => {
    const notify = (token: string, targetUserId: string) => SELF.fetch(
      `${BASE}/v1/notifications/notify-user`,
      json('POST', { appId: 'diary', targetUserId, title: 't', body: 'b', channel: 'email' }, token),
    );
    for (const name of ['gh:2', 'bob']) {
      const res = await notify(await credentialSession(name), 'gh:1');
      expect(res.status, name).toBe(403);
      expect(await res.text()).toContain('must be a member');
    }
    // Recipient side: the real member gh:2 emails a squatter named `gh:2`. Old code
    // counted the squatter a member (and only failed later for want of an address).
    const sq = await credentialAccount('gh:2');
    const res = await notify(await session('gh:2'), sq.id);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ email: 'skipped', skipped: 'not_member' });
  });
});
