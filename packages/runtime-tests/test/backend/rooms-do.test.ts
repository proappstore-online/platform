import { SELF, env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { BASE, session, mockNetwork, resetTables } from './helpers';

function nextMessage(ws: WebSocket): Promise<unknown> {
  return new Promise((resolve) => ws.addEventListener('message', (ev) => resolve(JSON.parse(String((ev as MessageEvent).data))), { once: true }));
}

function nextClose(ws: WebSocket): Promise<{ code: number; reason: string }> {
  return new Promise((resolve) => ws.addEventListener('close', (ev) => resolve({ code: (ev as CloseEvent).code, reason: (ev as CloseEvent).reason }), { once: true }));
}

beforeEach(async () => { mockNetwork(); await resetTables(); });

describe('Room Durable Object', () => {
  it('accepts a WebSocket through the route, broadcasts peers, and the stub is addressable by name', async () => {
    const tok = await session('gh:1', { login: 'alice' });
    const res = await SELF.fetch(`${BASE}/v1/apps/demo/rooms/lobby?token=${encodeURIComponent(tok)}`, { headers: { Upgrade: 'websocket' } });
    expect(res.status).toBe(101);
    const ws = res.webSocket!;
    expect(ws).toBeTruthy();
    ws.accept();
    const first = await nextMessage(ws);
    expect(first).toMatchObject({ kind: 'peers', peers: [expect.objectContaining({ uid: 'gh:1' })] });
    ws.close();
    // The same room, addressed directly: a second peer joins the same object.
    const stub = env.ROOM.get(env.ROOM.idFromName('demo:lobby'));
    const direct = await stub.fetch('https://room/?uid=gh:2&login=bob', { headers: { Upgrade: 'websocket' } });
    expect(direct.status).toBe(101);
    direct.webSocket!.accept();
    direct.webSocket!.close();
  });

  it('refuses a non-websocket request with 400', async () => {
    expect((await SELF.fetch(`${BASE}/v1/apps/demo/rooms/lobby`)).status).toBe(400);
  });

  it('a missing session completes the upgrade and closes 4401 so the client can tell auth from network', async () => {
    const res = await SELF.fetch(`${BASE}/v1/apps/demo/rooms/lobby`, { headers: { Upgrade: 'websocket' } });
    expect(res.status).toBe(101);
    const ws = res.webSocket!;
    const closed = nextClose(ws);
    ws.accept();
    expect(await closed).toEqual({ code: 4401, reason: 'missing_token' });
  });

  it('the 33rd peer is closed 4429 room_full and the room keeps serving the 32 inside', async () => {
    const stub = env.ROOM.get(env.ROOM.idFromName('demo:packed'));
    const inside: WebSocket[] = [];
    for (let i = 0; i < 32; i++) {
      const res = await stub.fetch(`https://room/?uid=gh:${i}&login=u${i}`, { headers: { Upgrade: 'websocket' } });
      expect(res.status).toBe(101);
      res.webSocket!.accept();
      inside.push(res.webSocket!);
    }
    const res = await stub.fetch('https://room/?uid=gh:33&login=late', { headers: { Upgrade: 'websocket' } });
    expect(res.status).toBe(101);
    const closed = nextClose(res.webSocket!);
    res.webSocket!.accept();
    expect(await closed).toEqual({ code: 4429, reason: 'room_full' });
    // One leaves, the seat frees up.
    inside[0]!.close();
    await new Promise((r) => setTimeout(r, 50));
    const again = await stub.fetch('https://room/?uid=gh:33&login=late', { headers: { Upgrade: 'websocket' } });
    expect(again.status).toBe(101);
    again.webSocket!.accept();
    expect(await nextMessage(again.webSocket!)).toMatchObject({ kind: 'peers' });
    for (const ws of inside.slice(1)) ws.close();
    again.webSocket!.close();
  });
});
