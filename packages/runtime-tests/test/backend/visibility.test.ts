import { SELF, env as providedEnv, fetchMock, runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Env } from '../../../backend/src/types';
import { runScheduledActions } from '../../../backend/src/lib/scheduled-actions';
import { roomObjectName } from '../../../backend/src/routes/rooms';
import { BASE, json, mockNetwork, resetTables, seedApp, seedUser, session } from './helpers';

const env = providedEnv as unknown as Env;

// #259 (part of #251): a private app — declared in mcp.json, stored in
// app_visibility — is usable only by its team and the declared app roles:
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

  it('admits a platform admin whose session came from an app origin (roles [user], #56) — by ADMIN_GITHUB_IDS', async () => {
    const appOrigin = await session('gh:admin', { roles: ['user'] });
    expect((await me(appOrigin)).body).toEqual({ mode: 'private', allowed: true });
    // …and on the paths that use requireVisible: an action runs for them too.
    dataWorker().intercept({ path: '/query', method: 'POST' }).reply(200, { rows: [], meta: {} });
    expect((await call('my_notes', appOrigin)).status).toBe(200);
    // A non-admin with the same session shape is still refused.
    expect((await me(await session('gh:3', { roles: ['user'] }))).body.allowed).toBe(false);
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

// ── Review round 1 ───────────────────────────────────────────────────────────

let squatters = 0;
/** A self-registered credential account — no invite, no GitHub — named `displayName`. */
async function credentialSession(displayName: string): Promise<string> {
  const email = `squat${Date.now()}-${squatters++}@example.com`;
  const password = 'correct-horse-battery-9';
  expect((await SELF.fetch(`${BASE}/v1/auth/credentials/register`, json('POST', { email, password, displayName }))).status).toBe(202);
  const res = await SELF.fetch(`${BASE}/v1/auth/credentials/login`, json('POST', { login: email, password }));
  return ((await res.json()) as { token: string }).token;
}

describe('private apps: role identity (#259 review, #272)', () => {
  beforeEach(async () => {
    expect((await register({ tools: [notes], visibility: PRIVATE })).status).toBe(200);
    // A legacy grant keyed by GitHub login, as rows from before resolveRoleUser are.
    await env.DB.prepare("INSERT INTO app_roles (app_id, user_id, role_name) VALUES ('diary', 'bob', 'viewer')").run();
  });

  it("a credential account named after a role holder's gh: id, or a legacy login grant, is refused", async () => {
    for (const name of ['gh:2', 'bob', 'viewer']) {
      const tok = await credentialSession(name);
      expect((await me(tok)).body, name).toEqual({ mode: 'private', allowed: false });
      expect((await SELF.fetch(`${BASE}/v1/apps/diary/tools`, json('GET', undefined, tok))).status, name).toBe(403);
    }
  });

  it('a Google session whose profile name equals a legacy login is refused; the GitHub owner of that login is allowed', async () => {
    expect((await me(await session('google:9', { login: 'bob', roles: ['user'] }))).body.allowed).toBe(false);
    expect((await me(await session('gh:77', { login: 'bob' }))).body.allowed).toBe(true);
  });
});

describe('private apps: non-owner team members (#259 review)', () => {
  beforeEach(async () => {
    expect((await register({ tools: [notes], visibility: PRIVATE })).status).toBe(200);
    await seedUser('gh:6', 'teamdev');
    await env.DB.prepare("INSERT INTO team_members (app_id, user_id, role, invited_by, created_at) VALUES ('diary', 'gh:6', 'viewer', 'gh:1', 1)").run();
  });

  it('pass the gate — visibility/me and the console tool list — like requireAppAccess(viewer)', async () => {
    const tok = await session('gh:6');
    expect((await me(tok)).body).toEqual({ mode: 'private', allowed: true });
    const tools = await SELF.fetch(`${BASE}/v1/apps/diary/tools`, json('GET', undefined, tok));
    expect(tools.status).toBe(200);
  });
});

describe('private apps: invites from the platform invite page (#259 review)', () => {
  beforeEach(async () => {
    expect((await register({ tools: [notes], visibility: PRIVATE })).status).toBe(200);
    for (const t of ['invite_redemptions', 'invites']) await env.DB.prepare(`DELETE FROM ${t}`).run();
  });

  it('a non-GitHub invitee redeems a code scoped to this app and is then admitted; the same code is not found for another app', async () => {
    const created = await SELF.fetch(`${BASE}/v1/apps/diary/invites`, json('POST', { role: 'viewer' }, await session('gh:1')));
    expect(created.status).toBe(200);
    const { code } = (await created.json()) as { code: string };
    const invitee = await session('cred:invitee', { login: 'invitee', roles: ['user'] });
    expect((await me(invitee)).body).toEqual({ mode: 'private', allowed: false });

    const elsewhere = await SELF.fetch(`${BASE}/v1/invites/${code}/redeem`, json('POST', { appId: 'open' }, invitee));
    expect(elsewhere.status).toBe(404);
    expect((await me(invitee)).body.allowed).toBe(false);

    const redeemed = await SELF.fetch(`${BASE}/v1/invites/${code}/redeem`, json('POST', { appId: 'diary' }, invitee));
    expect(redeemed.status).toBe(200);
    expect((await me(invitee)).body).toEqual({ mode: 'private', allowed: true });
  });
});

describe('private apps: public storage, counters and rooms (#259 review)', () => {
  beforeEach(async () => {
    expect((await register({ tools: [notes], visibility: PRIVATE })).status).toBe(200);
    await env.DB.prepare('DELETE FROM counters').run();
    await env.DB.prepare("INSERT INTO counters (app_id, key, value, updated_at) VALUES ('diary', 'total', 42, 1), ('open', 'total', 7, 1)").run();
    await env.STORAGE.put('diary/_public/u/gh:2/secret.png', 'PRIVATE-UPLOAD', { httpMetadata: { contentType: 'image/png' } });
    await env.STORAGE.put('open/_public/logo.png', 'PUBLIC', { httpMetadata: { contentType: 'image/png' } });
  });
  afterEach(async () => {
    await env.STORAGE.delete(['diary/_public/u/gh:2/secret.png', 'open/_public/logo.png']);
    await env.DB.prepare('DELETE FROM counters').run();
  });

  it('public storage: anonymous 401, not allowed 403, allowed 200 and never shared-cacheable', async () => {
    const url = `${BASE}/v1/apps/diary/public/u/gh:2/secret.png`;
    const anon = await SELF.fetch(url);
    expect(anon.status).toBe(401);
    expect(await anon.text()).not.toContain('PRIVATE-UPLOAD');
    expect(anon.headers.get('cache-control')).toBe('private, no-store');
    expect((await SELF.fetch(url, json('GET', undefined, await session('gh:3')))).status).toBe(403);
    const ok = await SELF.fetch(url, json('GET', undefined, await session('gh:2')));
    expect(ok.status).toBe(200);
    expect(await ok.text()).toBe('PRIVATE-UPLOAD');
    expect(ok.headers.get('cache-control')).toBe('private, no-store');
  });

  it('public storage of a public app is unchanged: anonymous and immutable', async () => {
    const res = await SELF.fetch(`${BASE}/v1/apps/open/public/logo.png`);
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
    await res.text();
  });

  it('counters: reads need an allowed caller, writes too; a public app is unchanged', async () => {
    expect((await SELF.fetch(`${BASE}/v1/apps/diary/counters`)).status).toBe(401);
    expect((await SELF.fetch(`${BASE}/v1/apps/diary/counters/total`)).status).toBe(401);
    expect((await SELF.fetch(`${BASE}/v1/apps/diary/counters`, json('GET', undefined, await session('gh:3')))).status).toBe(403);
    expect((await SELF.fetch(`${BASE}/v1/apps/diary/counters/total`, json('POST', { increment: 1 }, await session('gh:3')))).status).toBe(403);
    const read = await SELF.fetch(`${BASE}/v1/apps/diary/counters`, json('GET', undefined, await session('gh:2')));
    expect(read.status).toBe(200);
    expect(await read.json()).toEqual({ total: 42 });
    expect(read.headers.get('Cache-Control')).toBe('private, no-store');
    const write = await SELF.fetch(`${BASE}/v1/apps/diary/counters/total`, json('POST', { increment: 1 }, await session('gh:2')));
    expect(await write.json()).toEqual({ value: 43 });
    expect(await (await SELF.fetch(`${BASE}/v1/apps/open/counters/total`)).json()).toEqual({ value: 7 });
  });

  it('rooms: a caller the gate refuses is closed 4401 app_private; an allowed one joins', async () => {
    const join = async (uid: string) => {
      const tok = await session(uid);
      const res = await SELF.fetch(`${BASE}/v1/apps/diary/rooms/lobby?token=${encodeURIComponent(tok)}`, { headers: { Upgrade: 'websocket' } });
      expect(res.status).toBe(101);
      const ws = res.webSocket!;
      const closed = new Promise<{ code: number; reason: string }>((resolve) => ws.addEventListener('close', (ev) => resolve({ code: (ev as CloseEvent).code, reason: (ev as CloseEvent).reason }), { once: true }));
      ws.accept();
      return { ws, closed };
    };
    const refused = await join('gh:3');
    expect(await refused.closed).toEqual({ code: 4401, reason: 'app_private' });
    const allowed = await join('gh:2');
    const outcome = await Promise.race([allowed.closed, new Promise((r) => setTimeout(() => r('open'), 50))]);
    expect(outcome).toBe('open');
    allowed.ws.close();
  });
});

describe('private apps residuals: per-user KV/storage and open room sockets (#276)', () => {
  beforeEach(async () => {
    expect((await register({ tools: [notes], visibility: PRIVATE })).status).toBe(200);
    await env.DB.prepare('DELETE FROM kv').run();
  });
  afterEach(async () => {
    await env.DB.prepare('DELETE FROM kv').run();
    const listed = await env.STORAGE.list({ prefix: 'diary/' });
    const open = await env.STORAGE.list({ prefix: 'open/' });
    const keys = [...listed.objects, ...open.objects].map((o) => o.key);
    if (keys.length) await env.STORAGE.delete(keys);
  });

  const kv = async (method: string, appId: string, uid: string) =>
    SELF.fetch(`${BASE}/v1/apps/${appId}/kv/x`, { method, headers: { Authorization: `Bearer ${await session(uid)}` }, ...(method === 'PUT' ? { body: '"v"' } : {}) });
  const file = async (method: string, appId: string, uid: string) =>
    SELF.fetch(`${BASE}/v1/apps/${appId}/storage/a.png`, {
      method,
      headers: { Authorization: `Bearer ${await session(uid)}`, 'Content-Type': 'image/png' },
      ...(method === 'PUT' ? { body: new Uint8Array([1, 2, 3]) } : {}),
    });

  it('a refused user cannot write or read their own KV or private storage; nothing is stored', async () => {
    expect((await kv('PUT', 'diary', 'gh:3')).status).toBe(403);
    expect((await kv('GET', 'diary', 'gh:3')).status).toBe(403);
    expect((await file('PUT', 'diary', 'gh:3')).status).toBe(403);
    expect((await file('GET', 'diary', 'gh:3')).status).toBe(403);
    const listing = await SELF.fetch(`${BASE}/v1/apps/diary/files`, json('GET', undefined, await session('gh:3')));
    expect(listing.status).toBe(403);
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM kv WHERE app_id = 'diary'").first('n')).toBe(0);
    expect((await env.STORAGE.list({ prefix: 'diary/gh:3/' })).objects).toHaveLength(0);
  });

  it('a revoked user is refused on the next write', async () => {
    expect((await kv('PUT', 'diary', 'gh:2')).status).toBe(204);
    await env.DB.prepare("DELETE FROM app_roles WHERE app_id = 'diary' AND user_id = 'gh:2'").run();
    expect((await kv('PUT', 'diary', 'gh:2')).status).toBe(403);
    expect((await file('PUT', 'diary', 'gh:2')).status).toBe(403);
  });

  it('the owner and an allowed role are unchanged; a public app is unchanged for anyone', async () => {
    for (const uid of ['gh:1', 'gh:2']) {
      expect((await kv('PUT', 'diary', uid)).status).toBe(204);
      expect((await kv('GET', 'diary', uid)).status).toBe(200);
      expect((await file('PUT', 'diary', uid)).status).toBe(200);
      const got = await file('GET', 'diary', uid);
      expect(got.status).toBe(200);
      await got.arrayBuffer();
    }
    expect((await kv('PUT', 'open', 'gh:3')).status).toBe(204);
    expect((await file('PUT', 'open', 'gh:3')).status).toBe(200);
  });

  it('an open socket of a user whose role is revoked closes 4401 app_private on the next re-check (<= 60 s); others stay', async () => {
    const join = async (uid: string) => {
      const res = await SELF.fetch(`${BASE}/v1/apps/diary/rooms/revoke?token=${encodeURIComponent(await session(uid))}`, { headers: { Upgrade: 'websocket' } });
      expect(res.status).toBe(101);
      const ws = res.webSocket!;
      const closed = new Promise<{ code: number; reason: string }>((resolve) => ws.addEventListener('close', (ev) => resolve({ code: (ev as CloseEvent).code, reason: (ev as CloseEvent).reason }), { once: true }));
      ws.accept();
      return { ws, closed };
    };
    const viewer = await join('gh:2');
    const owner = await join('gh:1');
    // Look up the same collision-safe Durable Object name used by the route.
    // A delimiter name would inspect a fresh DO and falsely report no alarm.
    const stub = env.ROOM.get(env.ROOM.idFromName(roomObjectName('diary', 'revoke')));
    // Joining scheduled the re-check within the stated bound.
    const alarm = await runInDurableObject(stub, (_i, state) => state.storage.getAlarm());
    expect(alarm).not.toBeNull();
    expect(alarm! - Date.now()).toBeLessThanOrEqual(60_000);

    // Still allowed: the tick closes nothing.
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    expect(await Promise.race([viewer.closed, new Promise((r) => setTimeout(() => r('open'), 50))])).toBe('open');

    await env.DB.prepare("DELETE FROM app_roles WHERE app_id = 'diary' AND user_id = 'gh:2'").run();
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    expect(await viewer.closed).toEqual({ code: 4401, reason: 'app_private' });
    expect(await Promise.race([owner.closed, new Promise((r) => setTimeout(() => r('open'), 50))])).toBe('open');
    owner.ws.close();
  });

  it('a public app flipped to private closes the sockets it now refuses', async () => {
    const res = await SELF.fetch(`${BASE}/v1/apps/open/rooms/flip?token=${encodeURIComponent(await session('gh:3'))}`, { headers: { Upgrade: 'websocket' } });
    const ws = res.webSocket!;
    const closed = new Promise<{ code: number; reason: string }>((resolve) => ws.addEventListener('close', (ev) => resolve({ code: (ev as CloseEvent).code, reason: (ev as CloseEvent).reason }), { once: true }));
    ws.accept();
    await env.DB.prepare("INSERT INTO app_visibility (app_id, mode, roles, created_at) VALUES ('open', 'private', '[]', 1)").run();
    const stub = env.ROOM.get(env.ROOM.idFromName(roomObjectName('open', 'flip')));
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    expect(await closed).toEqual({ code: 4401, reason: 'app_private' });
  });
});
