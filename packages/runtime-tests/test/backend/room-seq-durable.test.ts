import { env as testEnv, runInDurableObject } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { Room } from '../../../backend/src/do/room';
import { ROOM_PUBLISH_PATH } from '../../../backend/src/lib/room-access';
import type { Env } from '../../../backend/src/types';
import { mockNetwork, resetTables } from './helpers';

const env = testEnv as unknown as Env;

// #365 (#303 N23) on the real Room Durable Object: a worker publish is room
// activity, persisted with the event sequence, and the sequence never restarts —
// not after a publish to an idle room and a reconnect, not through idle eviction,
// not across a cold restart of the object. Events are still never replayed.

const DAY_MS = 24 * 60 * 60 * 1000;
let n = 0;
let roomName: string;
const stub = () => env.ROOM.get(env.ROOM.idFromName(roomName));

const publishRequest = (data: unknown) =>
  new Request(`https://room${ROOM_PUBLISH_PATH}`, { method: 'POST', body: JSON.stringify({ app: 't', room: roomName, data }) });
const publish = async (data: unknown) => {
  const res = await stub().fetch(publishRequest(data));
  expect(res.status).toBe(200);
  return res.json() as Promise<{ delivered: number; seq: number }>;
};
async function join(uid = 'gh:2') {
  const res = await stub().fetch(`https://room/?uid=${uid}&login=${uid}`, { headers: { Upgrade: 'websocket' } });
  expect(res.status).toBe(101);
  const ws = res.webSocket!;
  const frames: { kind: string; seq?: number; data?: unknown }[] = [];
  ws.addEventListener('message', (ev) => frames.push(JSON.parse(String((ev as MessageEvent).data))));
  ws.accept();
  return { ws, frames };
}
const stored = () => runInDurableObject(stub(), async (_i, state) => ({
  seq: await state.storage.get<number>('seq'),
  lastActivity: await state.storage.get<number>('lastActivity'),
}));
/** Age the room past the idle threshold, in memory and in storage, as if nobody had touched it for 25 h. */
const ageRoom = () => runInDurableObject(stub(), async (instance, state) => {
  const old = Date.now() - DAY_MS - 60 * 60 * 1000;
  (instance as unknown as { lastActivity: number }).lastActivity = old;
  await state.storage.put('lastActivity', old);
});
/**
 * A cold restart: a fresh Room over the same durable storage, which is all a
 * restarted object has, publishing once. Runs inside the object's own context.
 */
const publishAfterRestart = (data: unknown) => runInDurableObject(stub(), async (_i, state) => {
  const fresh = new Room(state, env);
  await state.blockConcurrencyWhile(async () => {}); // the constructor's load has run
  return (await fresh.fetch(publishRequest(data))).json() as Promise<{ delivered: number; seq: number }>;
});

beforeEach(async () => {
  mockNetwork();
  await resetTables();
  roomName = `t:seq-${++n}-${Date.now()}`;
});

describe('room event sequence is durable (#365)', () => {
  it('publish to an idle room, then a reconnect: the room is not cleared and the sequence continues', async () => {
    expect((await publish({ n: 1 })).seq).toBe(1);
    await ageRoom();
    const before = Date.now();
    // The publish lands while nobody is connected: it is missed (no replay), but it is activity.
    expect(await publish({ n: 2 })).toEqual({ delivered: 0, seq: 2 });
    expect((await stored()).lastActivity).toBeGreaterThanOrEqual(before);

    const client = await join();
    expect(await stored()).toMatchObject({ seq: 2 });
    expect(await publish({ n: 3 })).toEqual({ delivered: 1, seq: 3 });
    while (!client.frames.some((f) => f.kind === 'event')) await new Promise((r) => setTimeout(r, 5));
    // The client sees seq 3 after having seen nothing since 1: a gap, and n: 2 was never replayed.
    expect(client.frames.filter((f) => f.kind === 'event')).toEqual([expect.objectContaining({ seq: 3, data: { n: 3 } })]);
    client.ws.close();
  });

  it('idle eviction still clears an empty idle room, but never its sequence', async () => {
    await publish({ n: 1 });
    await publish({ n: 2 });
    await runInDurableObject(stub(), (_i, state) => state.storage.put('scratch', 'cleared on eviction'));
    await ageRoom();
    const client = await join();
    const left = await runInDurableObject(stub(), async (_i, state) => [...(await state.storage.list()).keys()].sort());
    expect(left).toEqual(['lastActivity', 'seq']);
    expect((await stored()).seq).toBe(2);
    client.ws.close();
    expect((await publish({ n: 3 })).seq).toBe(3);
  });

  it('a cold restart after publish-after-idle and an eviction continues the sequence instead of restarting at 1', async () => {
    await publish({ n: 1 });
    await ageRoom();
    const client = await join(); // eviction runs here: storage is cleared, the sequence is kept
    client.ws.close();
    await ageRoom();
    await publish({ n: 2 });
    const second = await join(); // not idle any more: nothing cleared
    second.ws.close();
    expect(await publishAfterRestart({ n: 3 })).toEqual({ delivered: 0, seq: 3 });
    expect((await stored()).seq).toBe(3);
  });
});
