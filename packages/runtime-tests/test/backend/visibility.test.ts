import { SELF, env as providedEnv, fetchMock } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Env } from '../../../backend/src/types';
import { runScheduledActions } from '../../../backend/src/lib/scheduled-actions';
import { BASE, json, mockNetwork, resetTables, seedApp, seedUser, session } from './helpers';

const env = providedEnv as unknown as Env;

// #259 (part of #251): a private app — declared in mcp.json, stored in
// app_visibility — is usable only by its owner and the declared app roles:
// visibility/me, its actions, its tool list and the storefront all agree. Real
// D1 and the real migrations; only the app's data worker is intercepted.
//
//   gh:1 owner (creator)   gh:2 holds 'viewer'   gh:3 holds only 'member'
//   gh:4 team 'owner'      gh:5 platform admin

const notes = {
  name: 'my_notes',
  description: 'My notes',
  operation: 'query',
  sql: 'SELECT id, body FROM notes WHERE user_id = :__user_id LIMIT 50',
  params: {},
  requires_auth: true,
};
const catalogue = {
  name: 'list_public',
  description: 'Public catalogue',
  operation: 'query',
  sql: 'SELECT id, title FROM items LIMIT 50',
  params: {},
  requires_auth: false,
};
const PRIVATE = { mode: 'private', roles: ['viewer'] };

const dataWorker = (appId = 'diary') => fetchMock.get(`https://pas-data-${appId}.${env.DATA_WORKER_HOST}`);
function validates(appId = 'diary'): void {
  dataWorker(appId).intercept({ path: '/validate', method: 'POST' })
    .reply(200, (req) => ({ results: (JSON.parse(String(req.body)) as { statements: { id: string }[] }).statements.map((st) => ({ id: st.id, ok: true })) }));
}
async function register(body: Record<string, unknown>, appId = 'diary', validated = true): Promise<Response> {
  if (validated) validates(appId);
  return SELF.fetch(`${BASE}/v1/apps/${appId}/tools`, json('PUT', body, await session('gh:1')));
}
async function me(token?: string, appId = 'diary') {
  const res = await SELF.fetch(`${BASE}/v1/apps/${appId}/visibility/me`, json('GET', undefined, token));
  return { status: res.status, body: (await res.json()) as { mode?: string; allowed?: boolean }, cache: res.headers.get('Cache-Control') };
}
async function call(name: string, token?: string): Promise<Response> {
  return SELF.fetch(`${BASE}/v1/apps/diary/actions/${name}`, json('POST', { params: {} }, token));
}

afterEach(() => fetchMock.assertNoPendingInterceptors());
beforeEach(async () => {
  mockNetwork();
  await resetTables();
  for (const t of ['app_visibility', 'app_listings', 'user_app_tokens', 'scheduled_action_runs', 'scheduled_action_state']) await env.DB.prepare(`DELETE FROM ${t}`).run();
  for (const [uid, login] of [['gh:1', 'owner'], ['gh:2', 'viewer'], ['gh:3', 'member'], ['gh:4', 'coowner'], ['gh:5', 'admin']]) await seedUser(uid!, login);
  await seedApp('diary', 'gh:1');
  await seedApp('open', 'gh:1');
  await env.DB.prepare("INSERT INTO app_roles (app_id, user_id, role_name) VALUES ('diary', 'gh:2', 'viewer'), ('diary', 'gh:3', 'member')").run();
  await env.DB.prepare("INSERT INTO team_members (app_id, user_id, role, invited_by, created_at) VALUES ('diary', 'gh:4', 'owner', 'gh:1', 1)").run();
});

describe('private apps: registration (#259)', () => {
  it('stores the declaration with the tools and reports it', async () => {
    const res = await register({ tools: [notes], visibility: PRIVATE });
    const body = (await res.json()) as { visibility?: unknown; error?: string };
    expect(res.status, body.error).toBe(200);
    expect(body.visibility).toEqual(PRIVATE);
    const row = await env.DB.prepare("SELECT mode, roles FROM app_visibility WHERE app_id = 'diary'").first();
    expect(row).toEqual({ mode: 'private', roles: '["viewer"]' });
  });

  it("refuses 'member' as an allowed role, and a public action on a private app — writing nothing", async () => {
    const member = await register({ tools: [notes], visibility: { mode: 'private', roles: ['member'] } }, 'diary', false);
    expect(member.status).toBe(400);
    expect(((await member.json()) as { error: string }).error).toContain("cannot include 'member'");

    const open = await register({ tools: [notes, catalogue], visibility: PRIVATE }, 'diary', false);
    expect(open.status).toBe(400);
    expect(((await open.json()) as { error: string }).error).toContain('cannot register public action "list_public"');
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM app_visibility WHERE app_id = 'diary'").first<{ n: number }>()).toEqual({ n: 0 });
  });

  it('a later manifest without the declaration makes the app public again; deleting the tools does not', async () => {
    expect((await register({ tools: [notes], visibility: PRIVATE })).status).toBe(200);
    const del = await SELF.fetch(`${BASE}/v1/apps/diary/tools`, json('DELETE', undefined, await session('gh:1')));
    expect(del.status).toBe(200);
    expect((await me()).body).toEqual({ mode: 'private', allowed: false });

    expect((await register({ tools: [notes] })).status).toBe(200);
    expect((await me()).body).toEqual({ mode: 'public', allowed: true });
  });
});

describe('private apps: GET /v1/apps/:id/visibility/me (#259)', () => {
  beforeEach(async () => {
    expect((await register({ tools: [notes], visibility: PRIVATE })).status).toBe(200);
  });

  it('allows the owner, a team owner, a platform admin and a holder of a declared role', async () => {
    expect((await me(await session('gh:1'))).body).toEqual({ mode: 'private', allowed: true });
    expect((await me(await session('gh:4'))).body).toEqual({ mode: 'private', allowed: true });
    expect((await me(await session('gh:5', { roles: ['user', 'admin'] }))).body).toEqual({ mode: 'private', allowed: true });
    expect((await me(await session('gh:2'))).body).toEqual({ mode: 'private', allowed: true });
  });

  it('refuses member-only and signed-out callers; an invalid session is a 401, not "signed out"', async () => {
    expect((await me(await session('gh:3'))).body).toEqual({ mode: 'private', allowed: false });
    expect((await me()).body).toEqual({ mode: 'private', allowed: false });
    expect((await me('not-a-session')).status).toBe(401);
  });

  it('is never cacheable, and a public app allows everyone', async () => {
    expect((await me(await session('gh:2'))).cache).toBe('private, no-store');
    expect((await me(undefined, 'open')).body).toEqual({ mode: 'public', allowed: true });
  });
});

describe('private apps: actions (#259)', () => {
  beforeEach(async () => {
    expect((await register({ tools: [notes], visibility: PRIVATE })).status).toBe(200);
  });

  it('refuses an authenticated call from a caller who is not allowed with 403, before the data worker', async () => {
    const res = await call('my_notes', await session('gh:3'));
    expect(res.status).toBe(403);
    expect(await res.text()).toContain('this app is private');
  });

  it('applies to app tokens too: a token held by a member-only user is refused, a role holder\'s runs', async () => {
    const mint = async (uid: string, token: string) => {
      const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token)))].map((x) => x.toString(16).padStart(2, '0')).join('');
      await env.DB.prepare("INSERT INTO user_app_tokens (token_hash, token_id, user_id, app_id, scopes, created_at, expires_at) VALUES (?, ?, ?, 'diary', '{\"access\":\"read\",\"actions\":null}', ?, ?)")
        .bind(hash, crypto.randomUUID().replace(/-/g, ''), uid, Date.now(), Date.now() + 3_600_000).run();
    };
    await mint('gh:3', 'pas_at_member0000000000000000000000000000');
    await mint('gh:2', 'pas_at_viewer0000000000000000000000000000');
    expect((await call('my_notes', 'pas_at_member0000000000000000000000000000')).status).toBe(403);
    dataWorker().intercept({ path: '/query', method: 'POST' }).reply(200, { rows: [], meta: {} });
    const ok = await call('my_notes', 'pas_at_viewer0000000000000000000000000000');
    expect(ok.status, await ok.clone().text()).toBe(200);
  });

  it('runs for an allowed role holder', async () => {
    dataWorker().intercept({ path: '/query', method: 'POST' }).reply(200, { rows: [{ id: 1, body: 'hi' }], meta: {} });
    const res = await call('my_notes', await session('gh:2'));
    expect(res.status, await res.clone().text()).toBe(200);
  });

  it('refuses a public action that reached the table some other way (a console endpoint, a pre-existing row)', async () => {
    const now = Date.now();
    await env.DB.prepare("INSERT INTO app_tools (app_id, name, manifest, created_at, updated_at, source) VALUES ('diary', 'list_public', ?, ?, ?, 'console')")
      .bind(JSON.stringify(catalogue), now, now).run();
    expect((await call('list_public')).status).toBe(403);
    expect((await call('list_public', await session('gh:1'))).status).toBe(403);
  });

  it('a scheduled action still runs on the platform scheduler', async () => {
    const nightly = {
      name: 'nightly',
      description: 'Nightly cleanup',
      operation: 'execute',
      sql: "UPDATE notes SET archived = 1 WHERE updated_at < :__now - 86400000",
      params: {},
      requires_auth: true,
      auth: { caller_unscoped: { reason: 'Scheduled maintenance; bounded by age.' } },
      schedule: { cron: '*/5 * * * *', params: {} },
    };
    expect((await register({ tools: [notes, nightly], visibility: PRIVATE })).status).toBe(200);
    dataWorker().intercept({ path: '/execute', method: 'POST' }).reply(200, { meta: { changes: 1 } });
    const report = await runScheduledActions({ env, now: Date.UTC(2026, 8, 26, 10, 5) });
    expect(report).toMatchObject({ claimed: 1, succeeded: 1 });
  });
});

describe('private apps: tool list and storefront (#259)', () => {
  beforeEach(async () => {
    expect((await register({ tools: [notes], visibility: PRIVATE })).status).toBe(200);
  });

  it("the tool list (what MCP's tools/list is built from) is refused to anyone not allowed", async () => {
    expect((await SELF.fetch(`${BASE}/v1/apps/diary/tools`)).status).toBe(403);
    expect((await SELF.fetch(`${BASE}/v1/apps/diary/tools`, json('GET', undefined, await session('gh:3')))).status).toBe(403);
    const allowed = await SELF.fetch(`${BASE}/v1/apps/diary/tools`, json('GET', undefined, await session('gh:2')));
    expect(allowed.status).toBe(200);
    expect(allowed.headers.get('Cache-Control')).toBe('private, no-store');
    const { tools } = (await allowed.json()) as { tools: Record<string, unknown>[] };
    expect(tools.map((t) => t.name)).toEqual(['my_notes']);
    expect(tools[0]).not.toHaveProperty('sql'); // a role holder is not the team
  });

  it('is absent from the storefront catalogue and its detail endpoint 404s', async () => {
    const list = await SELF.fetch(`${BASE}/v1/storefront/apps`);
    const { apps } = (await list.json()) as { apps: { appId: string }[] };
    expect(apps.map((a) => a.appId)).toContain('open');
    expect(apps.map((a) => a.appId)).not.toContain('diary');
    expect((await SELF.fetch(`${BASE}/v1/storefront/apps/diary`)).status).toBe(404);
    expect((await SELF.fetch(`${BASE}/v1/storefront/apps/open`)).status).toBe(200);
  });
});
