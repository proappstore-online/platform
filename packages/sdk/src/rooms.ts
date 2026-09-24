import type { Auth } from './auth.js';
import type { Unsubscribe } from './base-types.js';

/**
 * Light realtime room — Durable-Object-backed WebSocket fan-out.
 *
 * Use cases: cursor presence, low-state multiplayer (Slither-style), chat-light.
 * Not a multiplayer game server. Messages are not persisted.
 *
 * Limits (enforced server-side, ProAppStore):
 * - max 32 concurrent peers per room (a 33rd join is closed with code 4429 `room_full`)
 * - max 100 messages/sec per peer
 * - max 4KB per message
 * - rooms per app: **no platform cap** — every room is its own Durable Object.
 *   There is no LRU and no eviction of a room that has peers connected (#119).
 * - a room idle for 24h clears its (tiny) storage on the next join; that is the
 *   only eviction, and it never disconnects anyone.
 *
 * When a join is refused the server completes the WebSocket upgrade and closes
 * it with a readable code (see {@link ROOM_CLOSE_CODES}); subscribe with
 * {@link Room.onClose} to tell capacity or auth from a network drop. The client
 * reconnects with backoff only for the drops a retry can fix.
 */
export interface RoomPeer {
  uid: string;
  login: string;
}

export interface RoomMessage<T = unknown> {
  from: RoomPeer;
  data: T;
  at: number;
}

export type ConnectionState = 'connecting' | 'open' | 'closed' | 'error';

/**
 * Close codes the platform sends on a refused join (#119). Kept in sync by
 * hand with packages/backend/src/do/room.ts.
 */
export const ROOM_CLOSE_CODES = {
  /** The room already holds 32 peers. Retrying will not help until someone leaves. */
  ROOM_FULL: 4429,
  /** The session was missing or invalid. Sign in again. */
  UNAUTHORIZED: 4401,
} as const;

export type RoomCloseKind = 'capacity' | 'auth' | 'network' | 'normal' | 'server';

export interface RoomCloseInfo {
  /** WebSocket close code (1006 = the connection dropped without a close frame). */
  code: number;
  /** Server-provided reason, e.g. `room_full`, `invalid_session`; empty when none. */
  reason: string;
  /** What the code means for the app. Only `network` and `server` are retried. */
  kind: RoomCloseKind;
  /** Whether the client will try to reconnect. */
  willReconnect: boolean;
  at: number;
}

export function classifyClose(code: number): RoomCloseKind {
  if (code === ROOM_CLOSE_CODES.ROOM_FULL) return 'capacity';
  if (code === ROOM_CLOSE_CODES.UNAUTHORIZED) return 'auth';
  if (code === 1000 || code === 1001) return 'normal';
  if (code === 1006 || code === 1005 || code === 1012 || code === 1013) return 'network';
  return 'server';
}

export class Rooms {
  constructor(
    private readonly appId: string,
    private readonly apiBase: string,
    private readonly auth: Auth,
  ) {}

  join(roomId: string): Room {
    return new Room(this.appId, this.apiBase, this.auth, roomId);
  }
}

const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 30_000;

export class Room {
  private socket: WebSocket | null = null;
  private listeners = new Set<(msg: RoomMessage) => void>();
  private peerListeners = new Set<(peers: RoomPeer[]) => void>();
  private stateListeners = new Set<(state: ConnectionState) => void>();
  private closeListeners = new Set<(info: RoomCloseInfo) => void>();
  private _lastClose: RoomCloseInfo | null = null;
  private _peers: RoomPeer[] = [];
  private connectionState: ConnectionState = 'connecting';
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private explicitlyClosed = false;

  /** Enable to log all WebSocket traffic to console. */
  debug = false;

  constructor(
    private readonly appId: string,
    private readonly apiBase: string,
    private readonly auth: Auth,
    private readonly roomId: string,
  ) {
    this.connect();
  }

  /** Current connection state. */
  get state(): ConnectionState {
    return this.connectionState;
  }

  /** Underlying WebSocket readyState (or -1 if no socket). */
  get socketState(): number {
    return this.socket?.readyState ?? -1;
  }

  /** Number of registered message listeners. */
  get listenerCount(): number {
    return this.listeners.size;
  }

  /** Current peer list (read-only snapshot). */
  get peers(): RoomPeer[] {
    return this._peers;
  }

  send<T>(data: T): void {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      if (this.debug) console.warn('[rooms] send dropped — socket not open', this.connectionState);
      return;
    }
    const frame = JSON.stringify({ kind: 'msg', data });
    if (this.debug) console.log('[rooms] →', frame);
    this.socket.send(frame);
  }

  onMessage<T = unknown>(listener: (msg: RoomMessage<T>) => void): Unsubscribe {
    this.listeners.add(listener as (msg: RoomMessage) => void);
    return () => this.listeners.delete(listener as (msg: RoomMessage) => void);
  }

  onPeers(listener: (peers: RoomPeer[]) => void): Unsubscribe {
    this.peerListeners.add(listener);
    listener(this._peers);
    return () => this.peerListeners.delete(listener);
  }

  onConnectionState(listener: (state: ConnectionState) => void): Unsubscribe {
    this.stateListeners.add(listener);
    listener(this.connectionState);
    return () => this.stateListeners.delete(listener);
  }

  /**
   * Why the socket last closed, with the server's code and reason (#119):
   * `capacity` (room full — retrying will not help until someone leaves),
   * `auth` (sign in again), `network` (dropped; the client is reconnecting),
   * `normal`, or `server`. Fires on every close, including the ones the client
   * retries. `lastClose` holds the most recent one.
   */
  onClose(listener: (info: RoomCloseInfo) => void): Unsubscribe {
    this.closeListeners.add(listener);
    return () => this.closeListeners.delete(listener);
  }

  /** The most recent close, or null while the socket has never closed. */
  get lastClose(): RoomCloseInfo | null {
    return this._lastClose;
  }

  /** Permanently close the room. Stops any pending reconnect. */
  close(): void {
    this.explicitlyClosed = true;
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.socket?.close();
    this.socket = null;
    this.setState('closed');
    this.listeners.clear();
    this.peerListeners.clear();
    this.stateListeners.clear();
    this.closeListeners.clear();
  }

  private connect(): void {
    if (!this.isAuthenticated()) {
      // Auth state may have changed (sign-out). Stop trying.
      this.setState('closed');
      return;
    }
    this.setState('connecting');

    const url = this.auth.usesPlatformCookie ? this.platformCookieUrl() : this.legacyBearerUrl();
    const socket = new WebSocket(url.toString());
    this.socket = socket;

    socket.addEventListener('open', () => {
      this.reconnectAttempt = 0;
      this.setState('open');
      if (this.debug) console.log(`[rooms] connected to ${this.roomId}`);
    });

    socket.addEventListener('message', (ev) => {
      if (this.debug) console.log('[rooms] ←', ev.data);
      try {
        const parsed = JSON.parse(ev.data as string) as
          | { kind: 'msg'; from: RoomPeer; data: unknown; at: number }
          | { kind: 'peers'; peers: RoomPeer[] };
        if (parsed.kind === 'msg' && parsed.from) {
          if (this.debug)
            console.log(`[rooms] msg from ${parsed.from.login}, ${this.listeners.size} listeners`);
          for (const l of this.listeners) {
            l({ from: parsed.from, data: parsed.data, at: parsed.at });
          }
        } else if (parsed.kind === 'peers' && Array.isArray(parsed.peers)) {
          // Guard the shape — a malformed frame ({"kind":"peers"} with no array)
          // must not set _peers to undefined and hand undefined to every
          // onPeers subscriber (they call .length/.map on it).
          this._peers = parsed.peers;
          if (this.debug) console.log(`[rooms] peers: ${this._peers.length}`);
          for (const l of this.peerListeners) l(this._peers);
        }
      } catch (e) {
        console.warn('[rooms] malformed frame', e);
      }
    });

    socket.addEventListener('close', (ev) => {
      if (this.debug) console.log(`[rooms] closed (code=${ev.code} reason=${ev.reason || 'none'})`);
      if (this.socket === socket) this.socket = null;
      if (this.explicitlyClosed) return;
      // Surface the server's verdict and only retry what a retry can fix: a full
      // room stays full until someone leaves, and a bad session stays bad — a
      // reconnect loop there is the thrash #119 describes, not a recovery.
      const kind = classifyClose(ev.code);
      const willReconnect = kind === 'network' || kind === 'server';
      const info: RoomCloseInfo = { code: ev.code, reason: ev.reason ?? '', kind, willReconnect, at: Date.now() };
      this._lastClose = info;
      for (const l of this.closeListeners) l(info);
      this.setState('closed');
      if (willReconnect) this.scheduleReconnect();
    });

    socket.addEventListener('error', () => {
      // We let the close handler do the actual reconnect logic. error is
      // informational and may or may not be followed by close (it always is
      // in browsers per spec).
      this.setState('error');
    });
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer !== null) return;
    // Exponential backoff capped at 30s, with up to 1s of jitter so a
    // backend hiccup doesn't produce a thundering herd of reconnects.
    const backoff = Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * 2 ** this.reconnectAttempt);
    const jitter = Math.random() * 1000;
    this.reconnectAttempt++;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.explicitlyClosed) return;
      this.connect();
    }, backoff + jitter);
  }

  private isAuthenticated(): boolean {
    return this.auth.usesPlatformCookie ? this.auth.isSignedIn : !!this.auth.token;
  }

  private legacyBearerUrl(): URL {
    const token = this.auth.token;
    if (!token) throw new Error('Not signed in.');
    const url = new URL(
      `/v1/apps/${encodeURIComponent(this.appId)}/rooms/${encodeURIComponent(this.roomId)}`,
      this.apiBase,
    );
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    url.searchParams.set('token', token);
    return url;
  }

  private platformCookieUrl(): URL {
    const origin = typeof window !== 'undefined' ? window.location.origin : 'https://app.local';
    const url = new URL(
      `/.pas/api/v1/apps/${encodeURIComponent(this.appId)}/rooms/${encodeURIComponent(this.roomId)}`,
      origin,
    );
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    return url;
  }

  private setState(state: ConnectionState): void {
    if (this.connectionState === state) return;
    this.connectionState = state;
    for (const l of this.stateListeners) l(state);
  }
}
