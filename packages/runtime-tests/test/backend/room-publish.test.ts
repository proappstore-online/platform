import { SELF, env as providedEnv, fetchMock, runDurableObjectAlarm } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import type { Env } from '../../../backend/src/types';
import { AppWorkerApi } from '../../../backend/src/rpc/app-worker-api';
import { roomObjectName } from '../../../backend/src/routes/rooms';
import { MAX_ROOM_EVENT_BYTES, ROOM_PUBLISH_PER_MINUTE } from '../../../backend/src/lib/room-access';
import { disableAppWorker } from '../../../backend/src/lib/app-worker-host';
import { sha256Hex } from '../../../backend/src/lib/app-tokens';
import { BASE, json, mockNetwork, resetTables, seedApp, seedUser, session } from './helpers';

const env = providedEnv as unknown as Env;

// #351 on real D1 and the real Room Durable Object: an app worker writes state,
// publishes an event to a room of its own app, and the clients that room admits
// receive it. Rooms: `user:<uid>` (only that user), `doors:*` (declared in
// mcp.json, admitted by the can_join_campaign query as the joining user), and
// undeclared rooms (open, as before). Only the app's data worker is intercepted:
// its /query answers can_join_campaign from `members` (`<uid>/<campaign>`).
//
//   app `t` (owner gh:admin, worker token TOKEN) and app `u` (worker token U_TOKEN).

const TOKEN = 'a'.repeat(64);
const U_TOKEN = 'b'.repeat(64);
const INVOCATION = 'evt-r:1';
const members = new Set<string>();

const tools = [
  {
    name: 'mark_door', description: 'Worker write', operation: 'execute', requires_auth: true,
    sql: 'UPDATE doors SET knocked = 1 WHERE id = :id', params: { id: { type: 'string' } },
    auth: { caller_unscoped: { reason: 'the worker updates any door' } }, callers: ['worker'],
  },
  {
    name: 'can_join_campaign', description: 'Is the caller on this campaign', operation: 'query', requires_auth: true,
    sql: 'SELECT 1 AS ok FROM campaign_members WHERE campaign_id = :key AND user_id = :__user_id LIMIT 1', params: { key: { type: 'string' } },
  },
];

const dataWorker = (appId = 't') => fetchMock.get(`https://pas-data-${appId}.${env.DATA_WORKER_HOST}`);
const pas = (appId = 't') => new AppWorkerApi({ props: { appId } } as never, env);
const ctx = (token = TOKEN, invocation = INVOCATION) => ({ token, invocation });

async function seedWorker(appId: string, token: string) {
  await env.DB.prepare(
    `INSERT INTO app_workers (app_id, enabled, backend, token_hash, deployed_at, config_version) VALUES (?, 1, 'loader', ?, ?, 1)
     ON CONFLICT(app_id) DO UPDATE SET enabled = 1, token_hash = excluded.token_hash, deployed_at = excluded.deployed_at`,
  ).bind(appId, await sha256Hex(token), Date.now()).run();
}
const invocation = (id: string, appId: string) => env.DB.prepare(
  "INSERT OR REPLACE INTO app_worker_invocations (id, app_id, event_id, type, attempt, status, pas_calls, started_at) VALUES (?, ?, ?, 'hook', 1, 'running', 0, ?)",
).bind(id, appId, id.split(':')[0], Date.now()).run();

/** A WebSocket joined through the real route, collecting every frame. */
async function join(appId: string, room: string, uid: string) {
  const res = await SELF.fetch(`${BASE}/v1/apps/${appId}/rooms/${encodeURIComponent(room)}?token=${encodeURIComponent(await session(uid))}`, { headers: { Upgrade: 'websocket' } });
  expect(res.status).toBe(101);
  const ws = res.webSocket!;
  const frames: { kind: string; [k: string]: unknown }[] = [];
  const waiters: (() => void)[] = [];
  ws.addEventListener('message', (ev) => { frames.push(JSON.parse(String((ev as MessageEvent).data))); waiters.splice(0).forEach((w) => w()); });
  const closed = new Promise<{ code: number; reason: string }>((resolve) =>
    ws.addEventListener('close', (ev) => resolve({ code: (ev as CloseEvent).code, reason: (ev as CloseEvent).reason }), { once: true }));
  ws.accept();
  const events = () => frames.filter((f) => f.kind === 'event');
  /** Resolves once `n` events have arrived (the publish is answered only after the room sent them). */
  const eventCount = async (n: number) => { while (events().length < n) await new Promise<void>((r) => waiters.push(r)); return events(); };
  // The join is complete once the room has sent its first peers frame.
  while (!frames.some((f) => f.kind === 'peers')) await new Promise<void>((r) => waiters.push(r));
  return { ws, closed, frames, events, eventCount };
}
async function refused(appId: string, room: string, uid: string) {
  const res = await SELF.fetch(`${BASE}/v1/apps/${appId}/rooms/${encodeURIComponent(room)}?token=${encodeURIComponent(await session(uid))}`, { headers: { Upgrade: 'websocket' } });
  const ws = res.webSocket!;
  const closed = new Promise<{ code: number; reason: string }>((resolve) =>
    ws.addEventListener('close', (ev) => resolve({ code: (ev as CloseEvent).code, reason: (ev as CloseEvent).reason }), { once: true }));
  ws.accept();
  return closed;
}

beforeEach(async () => {
  mockNetwork();
  members.clear();
  for (const r of (await env.DB.prepare('SELECT app_id FROM app_workers').all<{ app_id: string }>()).results ?? []) await disableAppWorker(env, r.app_id);
  await resetTables();
  for (const t of ['app_worker_invocations', 'app_room_rules', 'app_room_publish_usage']) await env.DB.prepare(`DELETE FROM ${t}`).run();
  for (const uid of ['gh:admin', 'gh:2', 'gh:3']) await seedUser(uid, uid.slice(3));
  await seedApp('t', 'gh:admin');
  await seedApp('u', 'gh:admin');
  dataWorker().intercept({ path: '/validate', method: 'POST' })
    .reply(200, (req) => ({ results: (JSON.parse(String(req.body)) as { statements: { id: string }[] }).statements.map((s) => ({ id: s.id, ok: true })) }));
  const put = await SELF.fetch(`${BASE}/v1/apps/t/tools`, json('PUT', { tools, rooms: [{ pattern: 'doors:*', authorize: 'can_join_campaign' }] }, await session('gh:admin')));
  expect(put.status, await put.clone().text()).toBe(200);
  expect((await put.json<{ rooms: unknown }>()).rooms).toEqual([{ pattern: 'doors:*', authorize: 'can_join_campaign' }]);
  // can_join_campaign, run as the joining user: a row when `<uid>/<campaign>` is a member.
  dataWorker().intercept({ path: '/query', method: 'POST' }).reply(200, (req) => {
    const { params } = JSON.parse(String(req.body)) as { params: string[] };
    const [campaign, uid] = params;
    return { rows: members.has(`${uid}/${campaign}`) ? [{ ok: 1 }] : [], meta: {} };
  }).persist();
  await seedWorker('t', TOKEN);
  await seedWorker('u', U_TOKEN);
  await invocation(INVOCATION, 't');
});

describe('app-worker room publish (#351)', () => {
  it('a worker writes state and publishes; the members the room admits receive the event, numbered', async () => {
    members.add('gh:2/c1');
    const client = await join('t', 'doors:c1', 'gh:2');
    dataWorker().intercept({ path: '/execute', method: 'POST' }).reply(200, { meta: { changes: 1 } });
    expect(await pas().actions.call('mark_door', { id: 'd1' }, ctx())).toMatchObject({ meta: { changes: 1 } });
    expect(await pas().rooms.publish('doors:c1', { type: 'door_updated', id: 'd1' }, ctx())).toEqual({ delivered: 1 });
    expect(await client.eventCount(1)).toEqual([
      { kind: 'event', from: { uid: 'system:worker', login: 'system:worker' }, data: { type: 'door_updated', id: 'd1' }, at: expect.any(Number), seq: expect.any(Number) },
    ]);
    client.ws.close();
  });

  it('a declared room refuses a user its authorize action does not admit (cross-tenant), and an undeclared room stays open', async () => {
    members.add('gh:2/c1');
    expect(await refused('t', 'doors:c1', 'gh:3')).toEqual({ code: 4401, reason: 'room_forbidden' });
    expect(await refused('t', 'doors:c2', 'gh:2')).toEqual({ code: 4401, reason: 'room_forbidden' }); // a member of c1 only
    const open = await join('t', 'lobby', 'gh:3');
    expect(await pas().rooms.publish('lobby', { hello: true }, ctx())).toEqual({ delivered: 1 });
    expect((await open.eventCount(1))[0]).toMatchObject({ data: { hello: true } });
    open.ws.close();
  });

  it('user:<uid> rooms admit only that user, and the worker reaches exactly them', async () => {
    expect(await refused('t', 'user:gh:2', 'gh:3')).toEqual({ code: 4401, reason: 'room_forbidden' });
    const owner = await join('t', 'user:gh:2', 'gh:2');
    const other = await join('t', 'user:gh:3', 'gh:3');
    expect(await pas().rooms.publish('user:gh:2', { notification: 'n1' }, ctx())).toEqual({ delivered: 1 });
    expect((await owner.eventCount(1))[0]).toMatchObject({ data: { notification: 'n1' } });
    expect(other.events()).toEqual([]);
    owner.ws.close();
    other.ws.close();
  });

  it("a worker can only reach its own app's rooms, and only with its own token", async () => {
    const inT = await join('t', 'lobby', 'gh:3');
    await invocation('evt-u:1', 'u');
    // u's worker publishing "lobby" reaches u's lobby, which is a different room.
    expect(await pas('u').rooms.publish('lobby', { from: 'u' }, ctx(U_TOKEN, 'evt-u:1'))).toEqual({ delivered: 0 });
    expect(inT.events()).toEqual([]);
    // u's token on t's binding, or t's token naming u's invocation, is refused before anything is sent.
    await expect(pas('t').rooms.publish('lobby', {}, ctx(U_TOKEN))).rejects.toThrow(/Unauthorized/);
    await expect(pas('t').rooms.publish('lobby', {}, ctx(TOKEN, 'evt-u:1'))).rejects.toThrow(/Unauthorized/);
    expect(inT.events()).toEqual([]);
    inT.ws.close();
  });

  it('no subscriber is not an error; bad room ids, non-JSON and oversized data are refused', async () => {
    expect(await pas().rooms.publish('doors:empty', { x: 1 }, ctx())).toEqual({ delivered: 0 });
    await expect(pas().rooms.publish('bad room', {}, ctx())).rejects.toThrow(/InvalidRoom/);
    await expect(pas().rooms.publish('lobby', undefined, ctx())).rejects.toThrow(/BadRequest/);
    await expect(pas().rooms.publish('lobby', { s: 'x'.repeat(MAX_ROOM_EVENT_BYTES) }, ctx())).rejects.toThrow(/PayloadTooLarge/);
  });

  it(`is rate-limited to ${ROOM_PUBLISH_PER_MINUTE} publishes a minute per app; the window resets`, async () => {
    for (let i = 0; i < ROOM_PUBLISH_PER_MINUTE; i++) expect(await pas().rooms.publish('lobby', { i }, ctx())).toEqual({ delivered: 0 });
    await expect(pas().rooms.publish('lobby', {}, ctx())).rejects.toThrow(/RateLimited/);
    // Another app has its own window.
    await invocation('evt-u:2', 'u');
    expect(await pas('u').rooms.publish('lobby', {}, ctx(U_TOKEN, 'evt-u:2'))).toEqual({ delivered: 0 });
    // A minute later the app may publish again.
    await env.DB.prepare("UPDATE app_room_publish_usage SET window_start = window_start - 61000 WHERE app_id = 't'").run();
    expect(await pas().rooms.publish('lobby', {}, ctx())).toEqual({ delivered: 0 });
  });

  it('reconnect then refetch: an event published while disconnected is missed, and seq shows the gap', async () => {
    members.add('gh:2/c1');
    const first = await join('t', 'doors:c1', 'gh:2');
    // The room's numbering survives across this suite's tests, so compare to what this client saw.
    expect(await pas().rooms.publish('doors:c1', { n: 1 }, ctx())).toEqual({ delivered: 1 });
    const seen = (await first.eventCount(1))[0]!.seq as number;
    const closed = first.closed;
    first.ws.close();
    await closed;
    expect(await pas().rooms.publish('doors:c1', { n: 2 }, ctx())).toEqual({ delivered: 0 }); // missed: nobody connected
    const again = await join('t', 'doors:c1', 'gh:2');
    expect(await pas().rooms.publish('doors:c1', { n: 3 }, ctx())).toEqual({ delivered: 1 });
    // Last seen `seen`, now seen + 2: the client knows it missed one and refetches (the SDK's onReconnect fires on every reconnect too).
    expect((await again.eventCount(1))[0]).toMatchObject({ data: { n: 3 }, seq: seen + 2 });
    again.ws.close();
  });

  it('a peer cannot forge a server event: a client frame of kind "event" is not relayed', async () => {
    const a = await join('t', 'lobby', 'gh:2');
    const b = await join('t', 'lobby', 'gh:3');
    a.ws.send(JSON.stringify({ kind: 'event', data: { forged: true }, seq: 99 }));
    a.ws.send(JSON.stringify({ kind: 'msg', data: 'real' }));
    while (!b.frames.some((f) => f.kind === 'msg')) await new Promise((r) => setTimeout(r, 5));
    expect(b.events()).toEqual([]);
    expect(b.frames.find((f) => f.kind === 'msg')).toMatchObject({ from: { uid: 'gh:2' }, data: 'real' });
    a.ws.close();
    b.ws.close();
  });

  it("a revoked membership closes the open socket on the room's next re-check (room_forbidden)", async () => {
    members.add('gh:2/c1');
    const client = await join('t', 'doors:c1', 'gh:2');
    const stub = env.ROOM.get(env.ROOM.idFromName(roomObjectName('t', 'doors:c1')));
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    members.delete('gh:2/c1');
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    expect(await client.closed).toEqual({ code: 4401, reason: 'room_forbidden' });
  });

  it('a manifest without `rooms` opens declared rooms again', async () => {
    dataWorker().intercept({ path: '/validate', method: 'POST' })
      .reply(200, (req) => ({ results: (JSON.parse(String(req.body)) as { statements: { id: string }[] }).statements.map((s) => ({ id: s.id, ok: true })) }));
    const put = await SELF.fetch(`${BASE}/v1/apps/t/tools`, json('PUT', { tools }, await session('gh:admin')));
    expect(put.status, await put.clone().text()).toBe(200);
    const client = await join('t', 'doors:c1', 'gh:3');
    client.ws.close();
  });
});
