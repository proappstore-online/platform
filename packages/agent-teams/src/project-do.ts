/**
 * ProjectDO — one Durable Object per PAS Agent Teams project.
 * Holds backlog, messages, role configs, cost ledger.
 * WebSocket hibernation for streaming agent output to the browser.
 */

import type { Bindings } from './bindings.ts';
import { notifyOwnerOfTransition } from './project-access.ts';
import { publishChatEvent } from './project-chat.ts';
import { runWatchdogAlarm } from './project-pipeline.ts';
import { handleRequest } from './project-routes.ts';
import { applySchema } from './project-schema.ts';
import type { ProjectHost } from './project-host.ts';
import { insertActivity, updateActivityMeta, activityFromBroadcast } from './activity-log.ts';
import type { ChatStreamSubscriber } from './chat-thread.ts';

// Re-exported: these lived here before being split out, and callers import them from this module.
export { minRoleFor } from './role-gate.ts';
export { LISTING_MODEL, sanitizeListing } from './listing.ts';
export { CHAT_THREADS, chatThreadOf, type ChatThread } from './chat-thread.ts';

/**
 * The Durable Object itself: it owns the storage, the in-memory run state and
 * the broadcast/activity primitives, and delegates every route and the
 * pipeline to the project-*.ts modules through {@link ProjectHost}.
 */
export class ProjectDO implements DurableObject, ProjectHost {
  readonly state: DurableObjectState;
  readonly env: Bindings;
  private initialized = false;
  readonly running = new Set<string>();
  architectChatBusy = false;
  architectChatStartedAt = 0;
  chatWindow: number[] = [];
  docsCache: { text: string; at: number } | null = null;
  readonly chatStreams = new Set<ChatStreamSubscriber>();

  constructor(state: DurableObjectState, env: Bindings) {
    this.state = state;
    this.env = env;
  }

  private async ensureSchema(): Promise<void> {
    if (this.initialized) return;
    applySchema(this.state.storage.sql);
    this.initialized = true;
  }

  // ── Broadcast to connected WebSocket clients ──────────────
  // Uses ctx.getWebSockets() to survive DO hibernation — the manual
  // Set pattern loses sockets when the DO sleeps and wakes.

  broadcast(event: Record<string, unknown>): void {
    const data = JSON.stringify(event);
    for (const ws of this.state.getWebSockets()) {
      try {
        ws.send(data);
      } catch { /* dead socket, DO will clean up */ }
    }
    publishChatEvent(this, event, data);
    // #6: every state-changing broadcast is also an audit row, so the activity
    // trail survives a refresh. `activity` itself maps to null — no recursion.
    const derived = activityFromBroadcast(event);
    if (derived) this.logActivity(derived.type, derived.detail, derived.ticketId);
    // Push a notification to the owner on attention-worthy transitions, so they
    // don't have to watch the board while agents work. Fire-and-forget — the DO
    // outlives the request, so the fetch can complete; never blocks the broadcast.
    if (event.type === 'transition') void notifyOwnerOfTransition(this, event).catch(() => {});
  }

  // ── Activity log (persisted audit trail) ───────────────────
  // Every meaningful action — play/pause, ticket created, agent started, tool
  // calls, transitions, errors, cost — is written to the activity_log table so
  // the full history is in the DB (traceable, survives refresh/eviction), not
  // just in the browser. Also broadcast for live UIs.

  logActivity(type: string, detail: string, ticketId: string | null = null, meta?: string): string {
    const { id, createdAt, meta: metaStr } = insertActivity(this.state.storage.sql, { type, detail, ticketId, ...(meta !== undefined ? { meta } : {}) });
    this.broadcast({ type: 'activity', entry: { id, ticketId, type, detail, createdAt, meta: metaStr ?? undefined } });
    return id;
  }

  /** Attach the output of a tool call to its already-logged activity row (audit). */
  setActivityMeta(id: string, meta: string): void {
    const metaStr = updateActivityMeta(this.state.storage.sql, id, meta);
    this.broadcast({ type: 'activity-meta', id, meta: metaStr });
  }

  // ── HTTP + WebSocket handler ──────────────────────────────

  async fetch(request: Request): Promise<Response> {
    await this.ensureSchema();
    return handleRequest(this, request);
  }

  // ── WebSocket hibernation callbacks ───────────────────────

  webSocketMessage(_ws: WebSocket, _message: string | ArrayBuffer): void {
    // Client messages not used yet; agent output is server→client only
  }

  webSocketClose(_ws: WebSocket): void {
    // DO runtime handles cleanup automatically with hibernation
  }

  webSocketError(_ws: WebSocket): void {
    // DO runtime handles cleanup automatically with hibernation
  }

  async alarm(): Promise<void> {
    await this.ensureSchema();
    runWatchdogAlarm(this);
  }
}
