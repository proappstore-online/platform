import { Hono } from 'hono';
import { ROOM_CLOSE_CODES, refuseWebSocket } from '../do/room.js';
import { verifySession } from '@proappstore/build-core';
import type { Env } from '../types.js';
import { getAppVisibilityCached, visibilityAllows } from '../lib/visibility.js';

export const roomRoutes = new Hono<{ Bindings: Env }>();

/**
 * A stable, collision-free Durable Object name for one app room. The old
 * `${appId}:${roomId}` delimiter was ambiguous when either component contained
 * `:`. Rooms are ephemeral, so deliberately do not route to that legacy name:
 * retaining it would retain the cross-app collision (#329).
 */
export function roomObjectName(appId: string, roomId: string): string {
  const bytes = new TextEncoder().encode(`${appId}\0${roomId}`);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return `v1:${btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')}`;
}

roomRoutes.get('/apps/:appId/rooms/:roomId', async (c) => {
  if (c.req.header('upgrade') !== 'websocket') return c.text('expected websocket', 400);

  // A bad session is answered on the socket (close 4401), not with an HTTP 401
  // the browser cannot read: the SDK stops reconnecting and tells the app why (#119).
  const token = bearerToken(c.req.header('Authorization')) ?? c.req.query('token');
  if (!token) return refuseWebSocket(ROOM_CLOSE_CODES.UNAUTHORIZED, 'missing_token');
  const session = await verifySession(token, c.env.SESSION_SIGNING_KEY);
  if (!session) return refuseWebSocket(ROOM_CLOSE_CODES.UNAUTHORIZED, 'invalid_session');

  const { appId, roomId } = c.req.param();
  // #259: a private app's rooms admit only callers its visibility gate allows.
  // Refused on the socket like a bad session (4401 stops the SDK reconnecting),
  // with its own reason so the app can tell the two apart.
  // Per-isolate cached (lib/visibility.ts): a public app's room upgrade pays no D1 read.
  // Unknown and unreadable → a 503 HttpError, which the SDK retries (unlike a 4401 close).
  const visibility = await getAppVisibilityCached(c.env.DB, appId);
  if (!(await visibilityAllows(c.env, appId, visibility, { id: session.uid, login: session.login ?? session.uid, roles: session.roles ?? ['user'] }))) {
    return refuseWebSocket(ROOM_CLOSE_CODES.UNAUTHORIZED, 'app_private');
  }
  const id = c.env.ROOM.idFromName(roomObjectName(appId, roomId));
  const stub = c.env.ROOM.get(id);
  const url = new URL(c.req.raw.url);
  url.searchParams.set('uid', session.uid);
  url.searchParams.set('login', session.login ?? session.uid);
  // #276: what the room needs to re-run the gate on its open sockets.
  url.searchParams.set('app', appId);
  url.searchParams.set('roles', (session.roles ?? ['user']).join(','));
  return stub.fetch(url.toString(), c.req.raw);
});

function bearerToken(header: string | undefined): string | null {
  if (!header?.startsWith('Bearer ')) return null;
  return header.slice('Bearer '.length).trim() || null;
}
