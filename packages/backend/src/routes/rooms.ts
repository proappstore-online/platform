import { Hono } from 'hono';
import { verifySession } from '@proappstore/build-core';
import type { Env } from '../types.js';

export const roomRoutes = new Hono<{ Bindings: Env }>();

roomRoutes.get('/apps/:appId/rooms/:roomId', async (c) => {
  if (c.req.header('upgrade') !== 'websocket') return c.text('expected websocket', 400);

  const token = c.req.query('token');
  if (!token) return c.text('missing token', 401);
  const session = await verifySession(token, c.env.SESSION_SIGNING_KEY);
  if (!session) return c.text('invalid session', 401);

  const { appId, roomId } = c.req.param();
  const id = c.env.ROOM.idFromName(`${appId}:${roomId}`);
  const stub = c.env.ROOM.get(id);
  const url = new URL(c.req.url);
  url.searchParams.set('uid', session.uid);
  url.searchParams.set('login', session.login ?? session.uid);
  return stub.fetch(url.toString(), c.req.raw);
});
