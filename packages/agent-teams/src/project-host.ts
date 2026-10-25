import type { Bindings } from './bindings.ts';
import type { ChatStreamSubscriber } from './chat-thread.ts';

/**
 * What the modules the ProjectDO delegates to may touch on it: its storage and
 * bindings, the few pieces of in-memory state it carries between requests, and
 * the three primitives every handler reports through (broadcast + the activity
 * log). The DO implements this; nothing else may reach into its internals.
 */
export interface ProjectHost {
  readonly state: DurableObjectState;
  readonly env: Bindings;
  /** Ticket IDs with an agent run in flight — prevents double-dispatch. */
  readonly running: Set<string>;
  /** True while a chat-driven Knowledge Base build is in flight (the Architect is
   *  writing in the Research thread). Prevents overlapping "Build KB" runs. */
  architectChatBusy: boolean;
  /** When the current Architect run started — used to self-heal a leaked lock
   *  (a run that hung past the hard timeout) so KB builds aren't 409'd forever. */
  architectChatStartedAt: number;
  /** Recent chat timestamps for the per-project throttle (in-memory). */
  chatWindow: number[];
  /** Cached official docs (skills.md), TTL'd, so read_docs doesn't refetch each call. */
  docsCache: { text: string; at: number } | null;
  /** Open `GET /chat/stream` subscribers (#8): each receives the chat events of
   *  one thread (or all) as Server-Sent Events, token by token. */
  readonly chatStreams: Set<ChatStreamSubscriber>;
  broadcast(event: Record<string, unknown>): void;
  logActivity(type: string, detail: string, ticketId?: string | null, meta?: string): string;
  setActivityMeta(id: string, meta: string): void;
}
