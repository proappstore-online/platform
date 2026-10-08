import { SELF, env, fetchMock } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BASE, json, mockNetwork, seedApp, seedUser, session, resetTables } from './helpers';
import { STASH } from '../../../backend/src/__fixtures__/operator-view';

// #246 on real D1: an app's platform-held users (app_roles ∪ usage_daily),
// for its owner only, whether or not the app declares an operator contract.

const DAY = 86_400_000;
const today = () => new Date().toISOString().slice(0, 10);
const daysAgo = (n: number) => new Date(Date.now() - n * DAY).toISOString().slice(0, 10);
const users = (appId: string, qs = '', token?: string) => SELF.fetch(`${BASE}/v1/apps/${appId}/operator/users${qs}`, json('GET', undefined, token));
type Body = { users: { user_id: string; login: string | null; roles: string[]; join_date: number | null; last_active: number | null; activity: string }[]; next_cursor: string | null };
const readRows = () => env.DB.prepare("SELECT app_id, actor_id, status, target FROM app_action_audit WHERE operator_action = 'read:platform-users' ORDER BY id").all<{ app_id: string; actor_id: string; status: number; target: string | null }>();

afterEach(() => fetchMock.assertNoPendingInterceptors());
beforeEach(async () => {
  mockNetwork();
  await resetTables();
  for (const t of ['usage_daily', 'app_operator_view', 'app_action_audit']) await env.DB.prepare(`DELETE FROM ${t}`).run();
  await seedUser('gh:1', 'owner');
  await seedUser('gh:2', 'other-owner');
  await seedUser('gh:10', 'alice');
  await seedUser('gh:11', 'bob');
  await seedUser('gh:12', 'carol');
  await seedApp('stash', 'gh:1');
  await seedApp('bingo', 'gh:2');
  const granted = Date.parse('2026-08-15T10:00:00Z');
  await env.DB.prepare(
    "INSERT INTO app_roles (app_id, user_id, role_name, granted_at) VALUES ('stash', 'gh:10', 'moderator', ?1), ('stash', 'gh:10', 'member', ?2), ('stash', 'dave', 'member', ?1), ('bingo', 'gh:12', 'member', ?1)",
  ).bind(granted, granted + DAY).run();
  await env.DB.prepare(
    "INSERT INTO usage_daily (app_id, user_id, day, session_seconds, api_calls, last_seen) VALUES ('stash', 'gh:10', ?1, 60, 5, ?3), ('stash', 'gh:11', ?2, 30, 2, ?4), ('bingo', 'gh:12', ?1, 9, 9, ?3)",
  ).bind(today(), daysAgo(60), Date.now(), Date.now() - 60 * DAY).run();
});

describe('platform-held users of an app (#246)', () => {
  it('lists role holders and active users of this app only — with no operator contract declared', async () => {
    const res = await users('stash', '', await session('gh:1'));
    expect(res.status, await res.clone().text()).toBe(200);
    const body = (await res.json()) as Body;
    // bingo's carol and the owner (no role, no activity) are not users of stash.
    expect(body.users.map((u) => u.user_id)).toEqual(['dave', 'gh:10', 'gh:11']);
    const [dave, alice, bob] = body.users;
    // A role keyed by login is shown as stored, never joined to someone else.
    expect(dave).toMatchObject({ login: null, roles: ['member'], last_active: null, activity: 'never_seen', join_date: Date.parse('2026-08-15T10:00:00Z') });
    expect(alice).toMatchObject({ login: 'alice', roles: ['member', 'moderator'], activity: 'active', join_date: Date.parse('2026-08-15T10:00:00Z') });
    expect(bob).toMatchObject({ login: 'bob', roles: [], activity: 'inactive', join_date: Date.parse(`${daysAgo(60)}T00:00:00Z`) });
    expect(JSON.stringify(body)).not.toMatch(/@|email/i);
    expect(body.next_cursor).toBeNull();
    const rows = (await readRows()).results;
    expect(rows).toEqual([{ app_id: 'stash', actor_id: 'gh:1', status: 200, target: null }]);
  });

  // #347: a grant keyed by a GitHub login (#272 legacy) is that gh: user's grant, so each person is listed once.
  it('merges login-keyed grants into their gh: user, once, with every role; counts each person once', async () => {
    const early = Date.parse('2026-07-01T00:00:00Z');
    // bob: one grant by login, activity by id. alice: grants by id and by login, one role on both keys.
    // erin: a Google account whose profile name is a login — never a GitHub identity, so its grant stays as stored.
    await env.DB.prepare("INSERT OR IGNORE INTO users (id, provider, provider_id, login, avatar_url, created_at, last_login_at) VALUES ('google:7', 'google', '7', 'erin', NULL, 0, 0)").run();
    await env.DB.prepare(
      "INSERT INTO app_roles (app_id, user_id, role_name, granted_at) VALUES ('stash', 'bob', 'moderator', ?1), ('stash', 'alice', 'reviewer', ?1), ('stash', 'alice', 'moderator', ?1), ('stash', 'erin', 'member', ?1)",
    ).bind(early).run();
    const body = (await (await users('stash', '', await session('gh:1'))).json()) as Body;
    expect(body.users.map((u) => u.user_id)).toEqual(['dave', 'erin', 'gh:10', 'gh:11']);
    const byId = Object.fromEntries(body.users.map((u) => [u.user_id, u]));
    expect(byId['gh:11']).toMatchObject({ login: 'bob', roles: ['moderator'], activity: 'inactive', join_date: early });
    expect(byId['gh:10']).toMatchObject({ login: 'alice', roles: ['member', 'moderator', 'reviewer'], join_date: early });
    expect(byId.erin).toMatchObject({ login: null, roles: ['member'] });
    // Search finds the merged holder by its login.
    expect(((await (await users('stash', '?q=bo', await session('gh:1'))).json()) as Body).users.map((u) => u.user_id)).toEqual(['gh:11']);

    // The overview counts people, not keys: dave, erin, gh:10, gh:11 (before #347 it counted 5 keys: gh:10, dave, bob, alice, erin).
    const overview = await SELF.fetch(`${BASE}/v1/apps/stash/operator`, json('GET', undefined, await session('gh:1')));
    expect(overview.status, await overview.clone().text()).toBe(200);
    expect(JSON.stringify(await overview.json())).toContain('"usersWithRoles":4');
  });

  it('searches by login prefix or exact user id; LIKE wildcards are literal', async () => {
    const token = await session('gh:1');
    const ids = async (qs: string) => ((await (await users('stash', qs, token)).json()) as Body).users.map((u) => u.user_id);
    expect(await ids('?q=al')).toEqual(['gh:10']);
    expect(await ids('?q=gh:11')).toEqual(['gh:11']);
    expect(await ids('?q=%25')).toEqual([]);
    expect(await ids('?q=_lice')).toEqual([]);
    expect(await ids('?q=carol')).toEqual([]);
  });

  it('pages 50 at a time on user_id', async () => {
    for (let i = 0; i < 60; i++) {
      await env.DB.prepare("INSERT INTO usage_daily (app_id, user_id, day, session_seconds, api_calls, last_seen) VALUES ('stash', ?1, ?2, 1, 1, ?3)")
        .bind(`u${String(i).padStart(3, '0')}`, today(), Date.now()).run();
    }
    const token = await session('gh:1');
    const first = (await (await users('stash', '', token)).json()) as Body;
    expect(first.users).toHaveLength(50);
    expect(first.next_cursor).toBe(first.users[49]!.user_id);
    const second = (await (await users('stash', `?cursor=${encodeURIComponent(first.next_cursor!)}`, token)).json()) as Body;
    expect(second.users).toHaveLength(13); // 63 users in all
    expect(second.next_cursor).toBeNull();
    expect(new Set([...first.users, ...second.users].map((u) => u.user_id)).size).toBe(63);
  });

  it('refuses a signed-out caller, another app\'s owner and a team admin, and writes nothing for them', async () => {
    expect((await users('stash')).status).toBe(401);
    const other = await users('stash', '', await session('gh:2'));
    expect(other.status).toBe(403);
    expect(await other.text()).not.toContain('alice');
    await env.DB.prepare("INSERT INTO team_members (app_id, user_id, role, created_at) VALUES ('stash', 'gh:12', 'admin', 0)").run();
    expect((await users('stash', '', await session('gh:12'))).status).toBe(403);
    expect((await readRows()).results).toEqual([]);
    // gh:2 owns bingo: they see bingo's users, never stash's.
    const own = (await (await users('bingo', '', await session('gh:2'))).json()) as Body;
    expect(own.users.map((u) => u.user_id)).toEqual(['gh:12']);
  });

  it('the read appears on the owner\'s audit trail', async () => {
    await users('stash', '?q=al', await session('gh:1'));
    const trail = (await (await SELF.fetch(`${BASE}/v1/apps/stash/operator/audit?kind=read`, json('GET', undefined, await session('gh:1')))).json()) as { rows: { operation: string; kind: string; resource: string; target: string | null }[] };
    expect(trail.rows).toEqual([expect.objectContaining({ operation: 'read:platform-users', kind: 'read', resource: 'platform-users', target: null })]);
  });
});

describe('step-up still guards contract detail reads beside the baseline (#242)', () => {
  it('a stale session is refused on a detail whose action declares step_up, before the data worker', async () => {
    fetchMock.get(`https://pas-data-stash.${env.DATA_WORKER_HOST}`).intercept({ path: '/validate', method: 'POST' })
      .reply(200, (req) => ({ results: (JSON.parse(String(req.body)) as { statements: { id: string }[] }).statements.map((st) => ({ id: st.id, ok: true })) }));
    expect((await SELF.fetch(`${BASE}/v1/apps/stash/tools`, json('PUT', STASH, await session('gh:1')))).status).toBe(200);
    await env.DB.prepare("INSERT INTO app_roles (app_id, user_id, role_name) VALUES ('stash', 'gh:1', 'operator')").run();
    const token = await session('gh:1'); // no auth_time: never recent
    const stale = await SELF.fetch(`${BASE}/v1/apps/stash/operator/resources/kyc/records/k1`, json('GET', undefined, token));
    expect(stale.status).toBe(403);
    expect(await stale.text()).toContain('step_up_required');
    // The baseline itself needs no step-up: it carries no identity documents.
    expect((await users('stash', '', token)).status).toBe(200);
  });
});
