import { consume, newRateLimitState, type RateLimitState } from '../lib/rate-limit.js';
import { getAppVisibility, visibilityAllows } from '../lib/visibility.js';
import { ROOM_PUBLISH_PATH, roomAccess, roomRules, ruleFor, USER_ROOM_PREFIX, type RoomAccess } from '../lib/room-access.js';
import type { Env } from '../types.js';

const MAX_PEERS = 32;
const MAX_MESSAGE_BYTES = 4 * 1024;
/** The `from` of an event an app worker published (#351); no peer can send one. */
export const SERVER_PEER = { uid: 'system:worker', login: 'system:worker' } as const;
const MAX_MSGS_PER_SEC = 100;
const IDLE_EVICT_MS = 24 * 60 * 60 * 1000;
/**
 * How often an occupied room re-runs the private-app gate on its open sockets
 * (#276). The upgrade route checks only at join, so without this a socket
 * outlived a role revocation or a flip to private. The propagation bound.
 */
export const VISIBILITY_RECHECK_MS = 60_000;

/**
 * WebSocket close codes a client can read (#119). A refused join is delivered
 * as a completed upgrade followed by a close frame with one of these, because
 * a browser cannot see the HTTP status of a failed upgrade — a 503 and a lost
 * network both surface as code 1006. The SDK (packages/sdk/src/rooms.ts,
 * ROOM_CLOSE_CODES — kept in sync by hand) maps them to a close kind and stops
 * reconnecting on the ones that will not clear by retrying.
 *
 * Capacity model, published so apps can plan: there is NO per-app room cap and
 * NO LRU eviction on ProAppStore — every room is its own Durable Object, and
 * the only ceiling is per room (MAX_PEERS). A room whose storage sat idle for
 * 24 h is cleared on its next join only when nobody is connected; a room with
 * live peers is never evicted.
 */
export const ROOM_CLOSE_CODES = {
  /** The room holds MAX_PEERS already. Retrying will not help until someone leaves. */
  ROOM_FULL: 4429,
  /** The session on the join was missing or invalid. Sign in again; do not retry blindly. */
  UNAUTHORIZED: 4401,
} as const;

/** Complete the upgrade, then close with a readable code and reason. */
export function refuseWebSocket(code: number, reason: string): Response {
  const pair = new WebSocketPair();
  const server = pair[1];
  server.accept();
  server.close(code, reason);
  return new Response(null, { status: 101, webSocket: pair[0] });
}

interface Peer {
  socket: WebSocket;
  uid: string;
  login: string;
  roles: string[];
  rateLimit: RateLimitState;
}

interface PublicPeer {
  uid: string;
  login: string;
}

export class Room {
  private peers = new Map<WebSocket, Peer>();
  private lastActivity = Date.now();
  /** The app this room belongs to, from the upgrade route; null when addressed directly. */
  private appId: string | null = null;
  /** The room's id within its app (#351), for re-running its access rule on open sockets. */
  private roomId: string | null = null;
  /** Server events published here (#351), numbered so a client can see it missed some and refetch. */
  private seq = 0;

  constructor(
    private readonly state: DurableObjectState,
    private readonly env: Env,
  ) {
    void this.state.blockConcurrencyWhile(async () => {
      const stored = (await this.state.storage.get<number>('lastActivity')) ?? Date.now();
      this.lastActivity = stored;
      this.seq = (await this.state.storage.get<number>('seq')) ?? 0;
    });
  }

  async fetch(request: Request): Promise<Response> {
    // #351: an app worker's publish, reachable only through this Durable
    // Object's binding (lib/room-access.ts workerRoomPublish): the WebSocket
    // route forwards upgrade GETs only, so no client can send a server event.
    const target = new URL(request.url);
    if (request.method === 'POST' && target.pathname === ROOM_PUBLISH_PATH) return this.publish(request);

    // Idle eviction clears the room's storage only — and only when the room is
    // empty. Connected peers are never evicted (#119).
    if (this.peers.size === 0 && Date.now() - this.lastActivity > IDLE_EVICT_MS) {
      await this.state.storage.deleteAll();
    }
    this.lastActivity = Date.now();
    void this.state.storage.put('lastActivity', this.lastActivity);

    if (this.peers.size >= MAX_PEERS) {
      return refuseWebSocket(ROOM_CLOSE_CODES.ROOM_FULL, 'room_full');
    }

    const url = new URL(request.url);
    const uid = url.searchParams.get('uid') ?? 'anon';
    const login = url.searchParams.get('login') ?? uid;
    const roles = (url.searchParams.get('roles') ?? 'user').split(',').filter(Boolean);
    this.appId = url.searchParams.get('app') ?? this.appId;
    this.roomId = url.searchParams.get('room') ?? this.roomId;

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    server.accept();

    const peer: Peer = { socket: server, uid, login, roles, rateLimit: newRateLimitState(Date.now()) };
    this.peers.set(server, peer);
    this.broadcastPeers();
    if (this.appId && (await this.state.storage.getAlarm()) === null) {
      await this.state.storage.setAlarm(Date.now() + VISIBILITY_RECHECK_MS);
    }

    server.addEventListener('message', (ev) => {
      this.lastActivity = Date.now();
      void this.state.storage.put('lastActivity', this.lastActivity);

      if (!consume(peer.rateLimit, Date.now(), MAX_MSGS_PER_SEC)) {
        server.send(JSON.stringify({ kind: 'error', error: 'rate_limited' }));
        return;
      }

      const data = ev.data;
      const size = typeof data === 'string' ? data.length : (data as ArrayBuffer).byteLength;
      if (size > MAX_MESSAGE_BYTES) {
        server.send(JSON.stringify({ kind: 'error', error: 'message_too_large' }));
        return;
      }

      let parsed: { kind?: string; data?: unknown };
      try {
        parsed = JSON.parse(typeof data === 'string' ? data : new TextDecoder().decode(data));
      } catch { return; }
      if (parsed.kind !== 'msg') return;

      const from: PublicPeer = { uid, login };
      const out = JSON.stringify({ kind: 'msg', from, data: parsed.data, at: Date.now() });
      this.broadcast(out, server);
    });

    server.addEventListener('close', () => {
      this.peers.delete(server);
      this.broadcastPeers();
      try { server.close(1000, 'done'); } catch { /* already closed */ }
    });

    return new Response(null, { status: 101, webSocket: client });
  }

  /**
   * An app worker's event (#351): `{ kind: 'event', from: SERVER_PEER, data,
   * at, seq }` to every open socket. Answers how many got it; 0 when nobody is
   * connected, which is not an error. `seq` grows by one per event in this room
   * and survives the room going idle, so a client that sees a gap refetches.
   */
  private async publish(request: Request): Promise<Response> {
    const body = await request.json<{ app?: string; room?: string; data?: unknown }>().catch(() => null);
    if (!body || typeof body.app !== 'string' || typeof body.room !== 'string') return new Response('bad publish', { status: 400 });
    this.appId ??= body.app;
    this.roomId ??= body.room;
    this.seq += 1;
    await this.state.storage.put('seq', this.seq);
    const frame = JSON.stringify({ kind: 'event', from: SERVER_PEER, data: body.data ?? null, at: Date.now(), seq: this.seq });
    let delivered = 0;
    for (const peer of this.peers.values()) {
      try { peer.socket.send(frame); delivered += 1; } catch { /* gone */ }
    }
    return Response.json({ delivered, seq: this.seq });
  }

  /**
   * Re-run the private-app gate on every open socket (#276), and the room's own
   * access rule (#351: a declared room's authorize action, or `user:<uid>`);
   * refused sockets close 4401 with `app_private` or `room_forbidden`, as at the
   * upgrade. Reads D1 live, not the 30 s isolate cache, so the bound stays
   * VISIBILITY_RECHECK_MS. A failed lookup closes nothing: an open socket is kept
   * and re-checked on the next tick, never closed on a guess.
   */
  async alarm(): Promise<void> {
    if (this.peers.size === 0 || !this.appId) return;
    const appId = this.appId;
    const before = this.peers.size;
    const refuse = (peer: Peer, reason: string) => {
      this.peers.delete(peer.socket);
      try { peer.socket.close(ROOM_CLOSE_CODES.UNAUTHORIZED, reason); } catch { /* gone */ }
    };
    try {
      const visibility = await getAppVisibility(this.env.DB, appId);
      if (visibility.mode === 'private') {
        const allowed = new Map<string, boolean>();
        for (const peer of [...this.peers.values()]) {
          if (!allowed.has(peer.uid)) {
            allowed.set(peer.uid, await visibilityAllows(this.env, appId, visibility, { id: peer.uid, login: peer.login, roles: peer.roles }));
          }
          if (!allowed.get(peer.uid)) refuse(peer, 'app_private');
        }
      }
    } catch (e) {
      console.warn(`room visibility re-check failed for ${appId}: ${(e as Error)?.message ?? e}`);
    }
    const roomId = this.roomId;
    if (roomId && this.peers.size > 0) {
      try {
        const rules = roomId.startsWith(USER_ROOM_PREFIX) ? [] : await roomRules(this.env.DB, appId);
        if (roomId.startsWith(USER_ROOM_PREFIX) || ruleFor(rules, roomId)) {
          const verdicts = new Map<string, RoomAccess>();
          for (const peer of [...this.peers.values()]) {
            if (!verdicts.has(peer.uid)) {
              try { verdicts.set(peer.uid, await roomAccess(this.env, appId, roomId, { id: peer.uid, roles: peer.roles }, rules)); } catch { /* unknown: keep */ }
            }
            if (verdicts.get(peer.uid) === 'denied') refuse(peer, 'room_forbidden');
          }
        }
      } catch (e) {
        console.warn(`room access re-check failed for ${appId}/${roomId}: ${(e as Error)?.message ?? e}`);
      }
    }
    if (this.peers.size !== before) this.broadcastPeers();
    if (this.peers.size > 0) await this.state.storage.setAlarm(Date.now() + VISIBILITY_RECHECK_MS);
  }

  private broadcast(msg: string, except?: WebSocket): void {
    for (const peer of this.peers.values()) {
      if (peer.socket === except) continue;
      try { peer.socket.send(msg); } catch { /* gone */ }
    }
  }

  private broadcastPeers(): void {
    const byUid = new Map<string, PublicPeer>();
    for (const p of this.peers.values()) byUid.set(p.uid, { uid: p.uid, login: p.login });
    const peers = Array.from(byUid.values());
    const msg = JSON.stringify({ kind: 'peers', peers });
    for (const peer of this.peers.values()) {
      try { peer.socket.send(msg); } catch { /* ignore */ }
    }
  }
}
