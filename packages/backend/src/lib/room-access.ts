/**
 * Who may be in a room (#351). Three kinds of room, decided from the room id:
 *
 *   user:<uid>   reserved: only the signed-in user `<uid>` may join. An app's
 *                worker publishes a user's private events there.
 *   <prefix>…    declared in mcp.json `rooms` (`{ pattern: "chat:*", authorize }`):
 *                the registered query action `authorize` runs as the joining
 *                user, with params `room` (the full id) and `key` (the part after
 *                the prefix), and admits them only when it returns a row.
 *   anything else open to every signed-in caller the app's visibility admits,
 *                exactly as before #351.
 *
 * Checked at the join (routes/rooms.ts) and again on every open socket by the
 * room's re-check alarm (do/room.ts), so a revoked membership closes within
 * VISIBILITY_RECHECK_MS. Publishing (`PAS.rooms.publish`) is the app worker's
 * own and is not gated here: the worker can only name rooms of its own app.
 */
import type { Env } from '../types.js';
import { queryAsUser, WorkerCallError } from './app-worker-calls.js';

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

export const USER_ROOM_PREFIX = 'user:';
/** A room id an app worker may publish to, and the ids declared rooms match. */
export const ROOM_ID = /^[A-Za-z0-9][A-Za-z0-9:_.@-]{0,127}$/;
/** `rooms[].pattern`: a lowercase prefix ending in `:`, then `*`. */
export const ROOM_PATTERN = /^([a-z][a-z0-9_-]{0,31}:)\*$/;
export const MAX_ROOM_RULES_PER_APP = 20;

export interface RoomRule { prefix: string; authorize: string }
export type RoomAccess = 'allowed' | 'denied';

export async function roomRules(db: D1Database, appId: string): Promise<RoomRule[]> {
  const { results } = await db.prepare('SELECT prefix, authorize FROM app_room_rules WHERE app_id = ?').bind(appId).all<RoomRule>();
  return results ?? [];
}

/** The rule a room id falls under: the longest declared prefix it starts with. */
export function ruleFor(rules: RoomRule[], roomId: string): RoomRule | null {
  let best: RoomRule | null = null;
  for (const r of rules) if (roomId.startsWith(r.prefix) && (!best || r.prefix.length > best.prefix.length)) best = r;
  return best;
}

/**
 * Whether `user` may be in `roomId` of `appId`. An authorize action that is
 * missing, refuses the user (role gate, callers) or is malformed denies, fail
 * closed; a data-worker outage throws, so the caller can answer "try again"
 * rather than refuse on a guess.
 */
export async function roomAccess(
  env: Env, appId: string, roomId: string, user: { id: string; roles: string[] }, rules?: RoomRule[],
): Promise<RoomAccess> {
  if (roomId.startsWith(USER_ROOM_PREFIX)) return roomId === `${USER_ROOM_PREFIX}${user.id}` ? 'allowed' : 'denied';
  const rule = ruleFor(rules ?? await roomRules(env.DB, appId), roomId);
  if (!rule) return 'allowed';
  try {
    const rows = await queryAsUser(env, appId, rule.authorize, { room: roomId, key: roomId.slice(rule.prefix.length) }, user);
    return rows.length > 0 ? 'allowed' : 'denied';
  } catch (e) {
    if (e instanceof WorkerCallError && e.code !== 'Failed' && e.code !== 'Unavailable') return 'denied';
    throw e;
  }
}

// ── Publishing from the app worker ───────────────────────────────────────────

/** A published event's `data`, serialized. The same cap as a peer's message. */
export const MAX_ROOM_EVENT_BYTES = 4 * 1024;
/** Publishes per app per minute, beside the per-invocation PAS call budget. */
export const ROOM_PUBLISH_PER_MINUTE = 60;
const PUBLISH_WINDOW_MS = 60_000;
/** The internal publish path of the Room Durable Object; the WebSocket route never forwards a POST. */
export const ROOM_PUBLISH_PATH = '/__pas/publish';

/**
 * `PAS.rooms.publish(roomId, data)` (#351): deliver `data` as a server event to
 * every socket open in `roomId` of the worker's own app, and say how many got
 * it. `delivered: 0` is not an error: nobody is connected, and clients that
 * reconnect refetch (the SDK's `onReconnect`). The app comes from the binding's
 * props (authorizeWorkerCall), so a worker can never name another app's room.
 */
export async function workerRoomPublish(
  env: Env, appId: string, roomId: unknown, data: unknown, now = Date.now(),
): Promise<{ delivered: number }> {
  if (typeof roomId !== 'string' || !ROOM_ID.test(roomId)) throw new WorkerCallError('InvalidRoom', `room id must match ${ROOM_ID.source}`);
  let body: string | undefined;
  try { body = JSON.stringify(data); } catch { body = undefined; }
  if (body === undefined) throw new WorkerCallError('BadRequest', 'data must be JSON-serializable');
  const size = new TextEncoder().encode(body).byteLength;
  if (size > MAX_ROOM_EVENT_BYTES) throw new WorkerCallError('PayloadTooLarge', `data is ${size} bytes serialized; the limit is ${MAX_ROOM_EVENT_BYTES}`);
  const claimed = await env.DB.prepare(
    `INSERT INTO app_room_publish_usage (app_id, window_start, count) VALUES (?1, ?2, 1)
     ON CONFLICT(app_id) DO UPDATE SET
       window_start = CASE WHEN ?2 - window_start >= ?3 THEN ?2 ELSE window_start END,
       count        = CASE WHEN ?2 - window_start >= ?3 THEN 1 ELSE count + 1 END
     RETURNING count`,
  ).bind(appId, now, PUBLISH_WINDOW_MS).first<{ count: number }>();
  if ((claimed?.count ?? 0) > ROOM_PUBLISH_PER_MINUTE) throw new WorkerCallError('RateLimited', `at most ${ROOM_PUBLISH_PER_MINUTE} room publishes per minute per app`);
  const stub = env.ROOM.get(env.ROOM.idFromName(roomObjectName(appId, roomId)));
  const res = await stub.fetch(`https://room${ROOM_PUBLISH_PATH}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ app: appId, room: roomId, data }),
  });
  if (!res.ok) throw new WorkerCallError('Failed', `room ${roomId} refused the publish (${res.status})`);
  const { delivered } = await res.json<{ delivered: number }>();
  return { delivered };
}
