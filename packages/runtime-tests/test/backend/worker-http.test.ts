import { SELF, env as providedEnv, fetchMock } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Env } from '../../../backend/src/types';
import { appWorkerHost, disableAppWorker } from '../../../backend/src/lib/app-worker-host';
import { mintCallerGrant } from '../../../backend/src/lib/caller-grant';
import { sha256Hex } from '../../../backend/src/lib/app-tokens';
import { AppWorkerApi } from '../../../backend/src/rpc/app-worker-api';
import { BASE, json, mockNetwork, resetTables, seedApp, seedUser, session, viaHostApi } from './helpers';

const env = providedEnv as unknown as Env;

// #260 on real D1, R2 and the Worker Loader: a signed-in user's /.pas/worker/*
// request (as the host forwards it) reaches the app worker with a caller grant,
// bytes intact both ways, and only an allowlisted, uncacheable response comes
// back. Then the grant lets the worker run actions as that user, under the
// user's own role gates.

const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff];
const APP = `
function bytesOf(p) {
  if (p.body_encoding !== 'base64') return new TextEncoder().encode(p.body || '');
  const bin = atob(p.body || ''); const b = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) b[i] = bin.charCodeAt(i);
  return b;
}
export default { async fetch(req) {
  const e = await req.json();
  const p = e.payload;
  if (p.path === '/v1/ping') return new Response(JSON.stringify({ pong: true, user: e.caller && e.caller.user_id, method: p.method, query: p.query }), {
    headers: { 'content-type': 'application/json', 'set-cookie': 'evil=1', 'cache-control': 'public, max-age=600', 'x-internal': 'leak', etag: '"v1"' },
  });
  if (p.path === '/v1/grant') return Response.json({ id: e.id, attempt: e.attempt, caller: e.caller });
  if (p.path === '/v1/echo') {
    const digest = await crypto.subtle.digest('SHA-256', bytesOf(p));
    return Response.json({ sha: [...new Uint8Array(digest)].map((x) => x.toString(16).padStart(2, '0')).join(''), enc: p.body_encoding });
  }
  if (p.path === '/png') return new Response(new Uint8Array(${JSON.stringify(PNG)}), { headers: { 'content-type': 'image/png' } });
  return new Response('no such route', { status: 404 });
} };`;

async function viaHost(path: string, init: { method?: string; body?: BodyInit; contentType?: string; uid?: string | null; app?: string } = {}) {
  const headers: Record<string, string> = { 'X-PAS-App': init.app ?? 't', 'X-PAS-Worker-Method': init.method ?? 'GET', 'X-PAS-Worker-Path': path };
  if (init.uid !== null) headers.Authorization = `Bearer ${await session(init.uid ?? 'gh:42')}`;
  if (init.contentType) headers['content-type'] = init.contentType;
  return viaHostApi(`${BASE}/v1/apps/t/worker/http`, { method: 'POST', headers, ...(init.body !== undefined ? { body: init.body } : {}) });
}

beforeEach(async () => {
  mockNetwork();
  for (const r of (await env.DB.prepare('SELECT app_id FROM app_workers').all<{ app_id: string }>()).results ?? []) await disableAppWorker(env, r.app_id);
  await resetTables();
  for (const t of ['app_worker_invocations', 'app_log_usage', 'app_action_audit']) await env.DB.prepare(`DELETE FROM ${t}`).run();
  await seedUser('gh:admin', 'admin');
  await seedUser('gh:42', 'user42');
  await seedApp('t', 'gh:admin');
  const enabled = await SELF.fetch(`${BASE}/v1/admin/apps/t/worker-enabled`, json('PUT', { enabled: true }, await session('gh:admin', { roles: ['user', 'admin'] })));
  expect(enabled.status).toBe(200);
  await appWorkerHost(env).deploy('t', { modules: { 'app.js': APP } });
});
afterEach(() => fetchMock.assertNoPendingInterceptors());

describe('browser requests to the app worker (#260)', () => {
  it('a signed-in request reaches the worker with a grant for that user; only an allowlisted, private response comes back', async () => {
    const res = await viaHost('/v1/ping?x=1');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ pong: true, user: 'gh:42', method: 'GET', query: 'x=1' });
    expect(res.headers.get('cache-control')).toBe('private, no-store');
    expect(res.headers.get('etag')).toBe('"v1"');
    expect(res.headers.get('set-cookie')).toBeNull();
    expect(res.headers.get('x-internal')).toBeNull();
  });

  it('signed out → 401; not through the app origin → 403; no active worker → 404; the worker\'s own 404 passes through', async () => {
    expect((await viaHost('/v1/ping', { uid: null })).status).toBe(401);
    expect((await viaHost('/v1/ping', { app: 'other' })).status).toBe(403);
    expect((await viaHost('/nope')).status).toBe(404);
    await disableAppWorker(env, 't');
    const gone = await viaHost('/v1/ping');
    expect(gone.status).toBe(404);
  });

  it('a 200 KB binary POST reaches the worker byte-identical, and a PNG comes back byte-identical', async () => {
    const bytes = new Uint8Array(200 * 1024);
    for (let i = 0; i < bytes.length; i += 65536) crypto.getRandomValues(bytes.subarray(i, i + 65536));
    const echoed = await viaHost('/v1/echo', { method: 'POST', body: bytes, contentType: 'application/octet-stream' });
    expect(echoed.status).toBe(200);
    const digest = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map((x) => x.toString(16).padStart(2, '0')).join('');
    expect(await echoed.json()).toEqual({ sha: digest, enc: 'base64' });
    const png = await viaHost('/png');
    expect(png.headers.get('content-type')).toBe('image/png');
    expect([...new Uint8Array(await png.arrayBuffer())]).toEqual(PNG);
  });

  it('refuses a request body over 1 MB', async () => {
    expect((await viaHost('/v1/echo', { method: 'POST', body: new Uint8Array(1024 * 1024 + 1), contentType: 'application/octet-stream' })).status).toBe(413);
  });
});

describe('actions run as the grant\'s user (#260)', () => {
  const tools = [
    { name: 'my_rows', description: 'Mine', operation: 'query', requires_auth: true, sql: 'SELECT id FROM rows WHERE owner = :__user_id LIMIT 10', params: {} },
    { name: 'mod_rows', description: 'Moderation', operation: 'query', requires_auth: true, sql: 'SELECT id FROM rows WHERE owner = :__user_id LIMIT 10', params: {}, auth: { app_roles: ['moderator'] } },
  ];
  const INVOCATION = 'req-1:1';
  let queried: unknown[] = [];

  beforeEach(async () => {
    queried = [];
    fetchMock.get(`https://pas-data-t.${env.DATA_WORKER_HOST}`).intercept({ path: '/validate', method: 'POST' })
      .reply(200, (req) => ({ results: (JSON.parse(String(req.body)) as { statements: { id: string }[] }).statements.map((s) => ({ id: s.id, ok: true })) }));
    const put = await SELF.fetch(`${BASE}/v1/apps/t/tools`, json('PUT', { tools }, await session('gh:admin')));
    expect(put.status, await put.clone().text()).toBe(200);
    await env.DB.prepare("INSERT INTO app_worker_invocations (id, app_id, event_id, type, attempt, status, pas_calls, started_at) VALUES (?, 't', 'req-1', 'http', 1, 'running', 0, ?)").bind(INVOCATION, Date.now()).run();
  });
  const token = async () => {
    // The deployed worker's token is sealed; for these direct RPC calls, give the worker a known one.
    await env.DB.prepare("UPDATE app_workers SET token_hash = ? WHERE app_id = 't'").bind(await sha256Hex('w'.repeat(64))).run();
    return 'w'.repeat(64);
  };

  it(':__user_id is the user; a role the user lacks is Forbidden; with the role it runs and is audited', async () => {
    const tok = await token();
    const pas = new AppWorkerApi({ props: { appId: 't' } } as never, env);
    const grant = await mintCallerGrant(env, 't', { id: 'gh:42', roles: ['user'] }, { id: 'req-1', attempt: 1 });
    fetchMock.get(`https://pas-data-t.${env.DATA_WORKER_HOST}`).intercept({ path: '/query', method: 'POST' })
      .reply(200, (req) => { queried.push(JSON.parse(String(req.body))); return { rows: [], meta: {} }; }).times(2);
    await pas.actions.call('my_rows', {}, { token: tok, invocation: INVOCATION, as: grant });
    expect(queried[0]).toEqual({ sql: 'SELECT id FROM rows WHERE owner = ? LIMIT 10', params: ['gh:42'] });
    await expect(pas.actions.call('mod_rows', {}, { token: tok, invocation: INVOCATION, as: grant })).rejects.toThrow(/^Forbidden:/);
    await env.DB.prepare("INSERT INTO app_roles (app_id, user_id, role_name) VALUES ('t', 'gh:42', 'moderator')").run();
    await pas.actions.call('mod_rows', {}, { token: tok, invocation: INVOCATION, as: grant });
    expect((await env.DB.prepare("SELECT actor_id, role_name FROM app_action_audit WHERE app_id = 't'").all()).results).toEqual([{ actor_id: 'gh:42', role_name: 'moderator' }]);
  });

  it('a grant for another app, or one replayed after it expired, is Unauthorized', async () => {
    const tok = await token();
    const pas = new AppWorkerApi({ props: { appId: 't' } } as never, env);
    const other = await mintCallerGrant(env, 'u', { id: 'gh:42', roles: ['user'] }, { id: 'req-1', attempt: 1 });
    await expect(pas.actions.call('my_rows', {}, { token: tok, invocation: INVOCATION, as: other })).rejects.toThrow(/^Unauthorized:/);
    const stale = await mintCallerGrant(env, 't', { id: 'gh:42', roles: ['user'] }, { id: 'req-1', attempt: 1 }, Math.floor(Date.now() / 1000) - 31);
    await expect(pas.actions.call('my_rows', {}, { token: tok, invocation: INVOCATION, as: stale })).rejects.toThrow(/^Unauthorized:/);
  });

  describe('a grant works only from the invocation it was minted for (#318)', () => {
    const running = (id: string, type: string, eventId = id.split(':')[0]!, attempt = Number(id.split(':')[1])) => env.DB.prepare(
      "INSERT INTO app_worker_invocations (id, app_id, event_id, type, attempt, status, pas_calls, started_at) VALUES (?, 't', ?, ?, ?, 'running', 0, ?)",
    ).bind(id, eventId, type, attempt, Date.now()).run();
    const budget = (id: string) => env.DB.prepare('SELECT pas_calls FROM app_worker_invocations WHERE id = ?').bind(id).first<{ pas_calls: number }>().then((r) => r!.pas_calls);
    const rows = () => fetchMock.get(`https://pas-data-t.${env.DATA_WORKER_HOST}`).intercept({ path: '/query', method: 'POST' }).reply(200, { rows: [], meta: {} });

    it('the platform binds a real request\'s grant to that request\'s envelope', async () => {
      const res = await viaHost('/v1/grant');
      expect(res.status).toBe(200);
      const { id, attempt, caller } = await res.json<{ id: string; attempt: number; caller: { event_id: string; attempt: number; user_id: string } }>();
      expect(caller).toMatchObject({ event_id: id, attempt, user_id: 'gh:42' });
      // Kept after its request finished, it acts as nobody — the request's invocation is no longer running.
      const tok = await token();
      const pas = new AppWorkerApi({ props: { appId: 't' } } as never, env);
      await expect(pas.actions.call('my_rows', {}, { token: tok, invocation: `${id}:${attempt}`, as: caller })).rejects.toThrow(/^Unauthorized:/);
    });

    it("kept in module state, it is refused from a schedule, a hook, another user's request or another attempt — and spends none of their budget", async () => {
      const tok = await token();
      const pas = new AppWorkerApi({ props: { appId: 't' } } as never, env);
      const kept = await mintCallerGrant(env, 't', { id: 'gh:42', roles: ['user'] }, { id: 'req-1', attempt: 1 });
      await running('sched-9:1', 'schedule');
      await running('hook-3:1', 'hook');
      await running('req-2:1', 'http');
      await running('req-1:2', 'http');
      for (const inv of ['sched-9:1', 'hook-3:1', 'req-2:1', 'req-1:2']) {
        await expect(pas.actions.call('my_rows', {}, { token: tok, invocation: inv, as: kept }), inv).rejects.toThrow(/^Unauthorized:.*not for this invocation/);
        expect(await budget(inv), inv).toBe(0);
      }
      // From its own running invocation it works, and counts there.
      rows();
      await pas.actions.call('my_rows', {}, { token: tok, invocation: INVOCATION, as: kept });
      expect(await budget(INVOCATION)).toBe(1);
    });

    it('is refused once its own invocation has finished or timed out, though the grant is unexpired', async () => {
      const tok = await token();
      const pas = new AppWorkerApi({ props: { appId: 't' } } as never, env);
      const grant = await mintCallerGrant(env, 't', { id: 'gh:42', roles: ['user'] }, { id: 'req-1', attempt: 1 });
      for (const status of ['succeeded', 'timeout']) {
        await env.DB.prepare('UPDATE app_worker_invocations SET status = ? WHERE id = ?').bind(status, INVOCATION).run();
        await expect(pas.actions.call('my_rows', {}, { token: tok, invocation: INVOCATION, as: grant }), status).rejects.toThrow(/^Unauthorized:/);
      }
    });
  });
});
