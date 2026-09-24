import { Hono } from 'hono';
import { ROOM_CLOSE_CODES, refuseWebSocket } from '../do/room.js';
import { verifySession } from '@proappstore/build-core';
import type { Env } from '../types.js';

export const roomRoutes = new Hono<{ Bindings: Env }>();

roomRoutes.get('/apps/:appId/rooms/:roomId', async (c) => {
  if (c.req.header('upgrade') !== 'websocket') return c.text('expected websocket', 400);

  // A bad session is answered on the socket (close 4401), not with an HTTP 401
  // the browser cannot read: the SDK stops reconnecting and tells the app why (#119).
  const token = bearerToken(c.req.header('Authorization')) ?? c.req.query('token');
  if (!token) return refuseWebSocket(ROOM_CLOSE_CODES.UNAUTHORIZED, 'missing_token');
  const session = await verifySession(token, c.env.SESSION_SIGNING_KEY);
  if (!session) return refuseWebSocket(ROOM_CLOSE_CODES.UNAUTHORIZED, 'invalid_session');

  const { appId, roomId } = c.req.param();
  const id = c.env.ROOM.idFromName(`${appId}:${roomId}`);
  const stub = c.env.ROOM.get(id);
  const url = new URL(c.req.raw.url);
  url.searchParams.set('uid', session.uid);
  url.searchParams.set('login', session.login ?? session.uid);
  return stub.fetch(url.toString(), c.req.raw);
});

function bearerToken(header: string | undefined): string | null {
  if (!header?.startsWith('Bearer ')) return null;
  return header.slice('Bearer '.length).trim() || null;
}
