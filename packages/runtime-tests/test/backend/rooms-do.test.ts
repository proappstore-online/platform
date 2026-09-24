import { SELF, env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { BASE, session, mockNetwork, resetTables } from './helpers';

function nextMessage(ws: WebSocket): Promise<unknown> {
  return new Promise((resolve) => ws.addEventListener('message', (ev) => resolve(JSON.parse(String((ev as MessageEvent).data))), { once: true }));
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

  it('refuses a non-websocket request and a missing session at the route', async () => {
    expect((await SELF.fetch(`${BASE}/v1/apps/demo/rooms/lobby`)).status).toBe(400);
    expect((await SELF.fetch(`${BASE}/v1/apps/demo/rooms/lobby`, { headers: { Upgrade: 'websocket' } })).status).toBe(401);
  });
});
