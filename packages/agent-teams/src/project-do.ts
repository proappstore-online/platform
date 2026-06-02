/**
 * ProjectDO — one Durable Object per PAS Agent Teams project.
 * Holds backlog, messages, role configs, cost ledger.
 * WebSocket hibernation for streaming agent output to the browser.
 */

import type { Bindings } from './index.ts';
import type {
  BaSpec,
  Message,
  MessageAuthor,
  Project,
  Role,
  RoleConfig,
  RuntimeKind,
  StreamEvent,
  Ticket,
  TicketStatus,
  ToolCall,
  ToolResult,
} from './types.ts';
import {
  MAX_ITERATIONS,
  MAX_RUN_MINUTES,
  assigneeForStatus,
  canTransition,
  isTerminal,
  qaVerdict,
} from './ticket-machine.ts';
import type { AgentRuntime } from './types.ts';
import { CFNativeRuntime } from './runtimes/cf-native.ts';
import { OpenAIResponsesRuntime } from './runtimes/openai-responses.ts';
import { resolveByoKey, runtimeToProvider } from './byo-key.ts';
import { executeFileTool, isFileTool } from './spine.ts';
import { TOOL_SCHEMAS } from './tool-schemas.ts';
import {
  SCHEMA,
  json,
  rowToMessage,
  rowToRoleConfig,
  rowToTicket,
  uuid,
} from './store.ts';
import { buildSeedMessages } from './prompts.ts';
import { toolActivityDetail } from './tool-activity.ts';
import { slidingWindowAllow, CHAT_LIMIT, CHAT_WINDOW_MS } from './rate-limit.ts';
import { DEFAULT_PERSONAS, PO_PERSONA, formatMemory, type MemoryEntry } from './memory.ts';

/**
 * Watchdog interval. While a project is running, an alarm fires on this cadence
 * to drive the pipeline forward even if the in-process run chain stalls or the
 * DO was evicted between runs. It also re-dispatches active tickets whose
 * in-memory run flag was lost on hibernation.
 */
const WATCHDOG_MS = 60_000;

export class ProjectDO implements DurableObject {
  private state: DurableObjectState;
  private env: Bindings;
  private initialized = false;
  /** Ticket IDs with an agent run in flight — prevents double-dispatch. */
  private running = new Set<string>();
  /** Recent chat timestamps for the per-project throttle (in-memory). */
  private chatWindow: number[] = [];

  constructor(state: DurableObjectState, env: Bindings) {
    this.state = state;
    this.env = env;
  }

  private async ensureSchema(): Promise<void> {
    if (this.initialized) return;
    this.state.storage.sql.exec(SCHEMA);
    // Schema versioning: add columns that may not exist in older DOs
    try { this.state.storage.sql.exec(`ALTER TABLE project ADD COLUMN cost_month TEXT DEFAULT ''`); } catch { /* exists */ }
    try { this.state.storage.sql.exec(`ALTER TABLE project ADD COLUMN status TEXT DEFAULT 'paused'`); } catch { /* exists */ }
    // Owner session token, captured at play time, used to authenticate the
    // spine/MCP tool dispatch during autonomous agent runs. Pre-launch: stored
    // in the DO's own SQLite. TODO: replace with INTERNAL_TOKEN-based MCP auth
    // once issue #5 (MCP ownership scoping) lands.
    try { this.state.storage.sql.exec(`ALTER TABLE project ADD COLUMN owner_session_token TEXT`); } catch { /* exists */ }
    // Per-role output token cap (configurable from the console agent settings).
    try { this.state.storage.sql.exec(`ALTER TABLE role_configs ADD COLUMN max_tokens INTEGER`); } catch { /* exists */ }
    // Per-role persona ("soul") and the project memory table.
    try { this.state.storage.sql.exec(`ALTER TABLE role_configs ADD COLUMN persona TEXT`); } catch { /* exists */ }
    // Tool-call output captured on the activity row (full audit / inspection).
    try { this.state.storage.sql.exec(`ALTER TABLE activity_log ADD COLUMN meta TEXT`); } catch { /* exists */ }
    // Last GitHub commit synced into the working tree (GitHub = source of truth).
    try { this.state.storage.sql.exec(`ALTER TABLE project ADD COLUMN repo_synced_sha TEXT`); } catch { /* exists */ }
    try { this.state.storage.sql.exec(`ALTER TABLE project ADD COLUMN repo_synced_at INTEGER`); } catch { /* exists */ }
    this.initialized = true;
  }

  // ── Broadcast to connected WebSocket clients ──────────────
  // Uses ctx.getWebSockets() to survive DO hibernation — the manual
  // Set pattern loses sockets when the DO sleeps and wakes.

  private broadcast(event: Record<string, unknown>): void {
    const data = JSON.stringify(event);
    for (const ws of this.state.getWebSockets()) {
      try {
        ws.send(data);
      } catch { /* dead socket, DO will clean up */ }
    }
  }

  // ── Activity log (persisted audit trail) ───────────────────
  // Every meaningful action — play/pause, ticket created, agent started, tool
  // calls, transitions, errors, cost — is written to the activity_log table so
  // the full history is in the DB (traceable, survives refresh/eviction), not
  // just in the browser. Also broadcast for live UIs.

  private logActivity(type: string, detail: string, ticketId: string | null = null, meta?: string): string {
    const id = uuid();
    const now = Date.now();
    const metaStr = meta ? meta.slice(0, 20000) : null; // cap; full tool output kept for audit
    this.state.storage.sql.exec(
      'INSERT INTO activity_log (id, ticket_id, type, detail, created_at, meta) VALUES (?, ?, ?, ?, ?, ?)',
      id, ticketId, type, detail.slice(0, 1000), now, metaStr,
    );
    this.broadcast({ type: 'activity', entry: { id, ticketId, type, detail, createdAt: now, meta: metaStr ?? undefined } });
    return id;
  }

  /** Attach the output of a tool call to its already-logged activity row (audit). */
  private setActivityMeta(id: string, meta: string): void {
    const metaStr = meta.slice(0, 20000);
    this.state.storage.sql.exec('UPDATE activity_log SET meta = ? WHERE id = ?', metaStr, id);
    this.broadcast({ type: 'activity-meta', id, meta: metaStr });
  }

  // Wipe the persisted activity trail (start fresh). Audit-only data; safe to clear.
  private clearActivity(): Response {
    this.state.storage.sql.exec('DELETE FROM activity_log');
    this.broadcast({ type: 'activity-cleared' });
    return json({ ok: true });
  }

  private getActivity(): Response {
    const rows = this.state.storage.sql
      .exec('SELECT id, ticket_id, type, detail, created_at, meta FROM activity_log ORDER BY created_at DESC LIMIT 500')
      .toArray() as { id: string; ticket_id: string | null; type: string; detail: string; created_at: number; meta: string | null }[];
    return json({
      activity: rows.reverse().map((r) => ({
        id: r.id, ticketId: r.ticket_id, type: r.type, detail: r.detail, createdAt: r.created_at, meta: r.meta ?? undefined,
      })),
    });
  }

  // ── Ownership check ────────────────────────────────────────

  private assertOwner(request: Request): Response | null {
    const userId = request.headers.get('X-User-Id');
    if (!userId) return json({ error: 'forbidden' }, 403);
    const row = this.state.storage.sql
      .exec('SELECT owner_id FROM project LIMIT 1')
      .toArray()[0] as { owner_id: string } | undefined;
    // If no project exists yet (init), allow (ownership set during init)
    if (!row) return null;
    if (row.owner_id !== userId) return json({ error: 'not_found' }, 404);
    return null;
  }

  // ── HTTP + WebSocket handler ──────────────────────────────

  async fetch(request: Request): Promise<Response> {
    await this.ensureSchema();

    const url = new URL(request.url);
    const path = url.pathname;

    // WebSocket upgrade (hibernation-safe, with ownership check)
    if (request.headers.get('Upgrade') === 'websocket') {
      const ownerErr = this.assertOwner(request);
      if (ownerErr) return ownerErr;
      const pair = new WebSocketPair();
      this.state.acceptWebSocket(pair[1]);
      return new Response(null, { status: 101, webSocket: pair[0] });
    }

    // Init is special: only checks ownership if project already exists
    if (path === '/project' && request.method === 'PUT') return this.initProject(request);

    // All other routes require ownership
    const ownerErr = this.assertOwner(request);
    if (ownerErr) return ownerErr;

    // REST routes
    if (path === '/project' && request.method === 'GET') return this.getProject();
    if (path === '/project/play' && request.method === 'POST') return this.setPlayState('running', request);
    if (path === '/project/pause' && request.method === 'POST') return this.setPlayState('paused');

    if (path === '/roles' && request.method === 'GET') return this.getRoles();
    if (path === '/roles' && request.method === 'PUT') return this.setRoles(request);

    if (path === '/chat' && request.method === 'POST') return this.handleChat(request);
    if (path === '/chat/history' && request.method === 'GET') return this.getChatHistory();
    if (path === '/chat/history' && request.method === 'DELETE') return this.clearChat();

    if (path === '/tickets' && request.method === 'GET') return this.listTickets();
    if (path === '/tickets' && request.method === 'POST') return this.createTicket(request);

    const ticketMatch = path.match(/^\/tickets\/([a-f0-9-]+)$/);
    if (ticketMatch) {
      const ticketId = ticketMatch[1]!;
      if (request.method === 'GET') return this.getTicket(ticketId);
      if (request.method === 'PATCH') return this.updateTicket(ticketId, request);
      if (request.method === 'DELETE') return this.deleteTicket(ticketId);
    }

    const transitionMatch = path.match(/^\/tickets\/([a-f0-9-]+)\/transition$/);
    if (transitionMatch && request.method === 'POST') {
      return this.transitionTicket(transitionMatch[1]!, request);
    }

    const messagesMatch = path.match(/^\/tickets\/([a-f0-9-]+)\/messages$/);
    if (messagesMatch) {
      if (request.method === 'GET') return this.listMessages(messagesMatch[1]!);
      if (request.method === 'POST') return this.addMessage(messagesMatch[1]!, request);
    }

    const runMatch = path.match(/^\/tickets\/([a-f0-9-]+)\/run$/);
    if (runMatch && request.method === 'POST') {
      return this.runAgent(runMatch[1]!, request);
    }

    if (path === '/cost' && request.method === 'GET') return this.getCostSummary();
    if (path === '/activity' && request.method === 'GET') return this.getActivity();
    if (path === '/activity' && request.method === 'DELETE') return this.clearActivity();

    if (path === '/memory' && request.method === 'GET') return json({ memory: this.recallMemory() });
    if (path === '/memory' && request.method === 'POST') return this.addMemory(request);
    const memMatch = path.match(/^\/memory\/([a-f0-9-]+)$/);
    if (memMatch && request.method === 'DELETE') return this.forgetMemory(memMatch[1]!);

    if (path === '/sync' && request.method === 'POST') {
      const r = await this.syncFromGitHub('manual');
      return json({ ok: true, ...r });
    }

    if (path === '/files' && request.method === 'GET') return this.listProjectFiles();
    if (path === '/files/content' && request.method === 'GET') {
      return this.getProjectFile(new URL(request.url).searchParams.get('path') ?? '');
    }

    return json({ error: 'not_found' }, 404);
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

  // ── Project CRUD ──────────────────────────────────────────

  private getProject(): Response {
    const row = this.state.storage.sql
      .exec('SELECT * FROM project LIMIT 1')
      .toArray()[0] as Record<string, unknown> | undefined;
    if (!row) return json({ error: 'project_not_initialized' }, 404);
    return json({
      id: row.id,
      ownerId: row.owner_id,
      name: row.name,
      slug: row.slug,
      createdAt: row.created_at,
      costCapMonthlyUsd: row.cost_cap_monthly_usd,
      costSpentMonthlyUsd: row.cost_spent_monthly_usd,
      repoUrl: row.repo_url,
      status: row.status ?? 'paused',
    });
  }

  private setPlayState(newStatus: 'running' | 'paused', request?: Request): Response {
    const now = Date.now();
    this.state.storage.sql.exec('UPDATE project SET status = ?', newStatus);

    if (newStatus === 'running') {
      // Record when we started running (for idle timeout)
      try { this.state.storage.sql.exec(`ALTER TABLE project ADD COLUMN last_user_activity INTEGER DEFAULT 0`); } catch { /* exists */ }
      this.state.storage.sql.exec('UPDATE project SET last_user_activity = ?', now);

      // Capture the owner's session token for autonomous tool dispatch.
      const ownerToken = request?.headers.get('X-User-Token');
      if (ownerToken) {
        this.state.storage.sql.exec('UPDATE project SET owner_session_token = ?', ownerToken);
      }

      // Retry tickets parked in needs-input. They were blocked on a system
      // condition (missing API key, a prior error) — Play means "go", so
      // re-dispatch them rather than leaving them stuck (needs-input otherwise
      // only resumes via a chat reply).
      const blocked = this.state.storage.sql
        .exec("SELECT id, assignee_role FROM tickets WHERE status = 'needs-input'")
        .toArray() as { id: string; assignee_role: string | null }[];
      for (const t of blocked) {
        const resume = t.assignee_role === 'QA' ? 'qa-active' : t.assignee_role === 'Dev' ? 'dev-active' : 'ba-refining';
        this.state.storage.sql.exec('UPDATE tickets SET status = ?, updated_at = ? WHERE id = ?', resume, now, t.id);
        this.logActivity('control', `Retrying blocked ${t.assignee_role ?? 'BA'} ticket`, t.id);
        this.broadcast({ type: 'transition', ticketId: t.id, from: 'needs-input', to: resume, reason: 'retry-on-play' });
      }
    }

    this.broadcast({ type: 'play-state', status: newStatus });
    this.logActivity('control', newStatus === 'running' ? 'Agents started' : 'Agents paused');

    if (newStatus === 'running') {
      this.scheduleWatchdog();
      this.autoAdvance();
      // If there's no work yet, tell the user (in chat AND the activity feed).
      const open = (this.state.storage.sql
        .exec("SELECT COUNT(*) AS c FROM tickets WHERE status NOT IN ('done','failed','cancelled')")
        .toArray()[0] as { c: number }).c;
      if (open === 0) {
        const msg = "Agents are on. There's no work yet — tell me what to build in the chat and I'll create tickets and get the team going.";
        const msgId = uuid();
        this.state.storage.sql.exec(
          'INSERT INTO chat_history (id, role, body, created_at) VALUES (?, ?, ?, ?)',
          msgId, 'po', msg, now,
        );
        this.broadcast({ type: 'chat', role: 'po', body: msg, id: msgId });
        this.logActivity('info', 'No open tickets — describe what to build in the chat.');
      }
    } else {
      this.clearWatchdog();
    }

    return json({ status: newStatus });
  }

  // ── Watchdog alarm ────────────────────────────────────────
  // Keeps the pipeline moving without a user in the loop. The in-process run
  // chain (runAgentInternal → autoAdvance) is the primary driver; this alarm is
  // the backstop that recovers from stalls and DO eviction.

  private scheduleWatchdog(): void {
    try { this.state.storage.setAlarm(Date.now() + WATCHDOG_MS); } catch { /* unavailable in some test envs */ }
  }

  private clearWatchdog(): void {
    try { this.state.storage.deleteAlarm(); } catch { /* unavailable */ }
  }

  async alarm(): Promise<void> {
    await this.ensureSchema();
    const proj = this.state.storage.sql
      .exec('SELECT status FROM project LIMIT 1')
      .toArray()[0] as { status: string } | undefined;
    if (!proj || proj.status !== 'running') return; // paused → stop the watchdog

    // Drive the pipeline + re-dispatch any active tickets that lost their
    // in-memory run flag (e.g. after hibernation/eviction).
    this.autoAdvance();

    // Re-arm only while still running (autoAdvance may have auto-paused).
    const after = this.state.storage.sql
      .exec('SELECT status FROM project LIMIT 1')
      .toArray()[0] as { status: string } | undefined;
    if (after?.status === 'running') this.scheduleWatchdog();
  }

  /** Record user activity timestamp (for idle timeout) */
  private touchUserActivity(): void {
    try {
      this.state.storage.sql.exec('UPDATE project SET last_user_activity = ?', Date.now());
    } catch { /* column may not exist yet */ }
  }

  /** Auto-advance: move tickets through the pipeline when running.
   *  Safety rails:
   *  - Only runs when project status is 'running'
   *  - Max 3 concurrent active tickets (ba-refining + dev-active + qa-active)
   *  - Idle timeout: auto-pauses after 30 min of no user chat
   *  - Tickets in 'needs-input' block the pipeline until user responds
   *  - Iteration cap: 5 QA→Dev loops then auto-fail
   */
  private autoAdvance(): void {
    const proj = this.state.storage.sql
      .exec("SELECT status, last_user_activity, cost_cap_monthly_usd, cost_spent_monthly_usd, cost_month FROM project LIMIT 1")
      .toArray()[0] as { status: string; last_user_activity: number; cost_cap_monthly_usd: number; cost_spent_monthly_usd: number; cost_month: string } | undefined;
    if (!proj || proj.status !== 'running') return;

    const now = Date.now();

    // Idle timeout: auto-pause after 30 min of no user chat
    const lastActivity = (proj.last_user_activity as number | null) ?? 0;
    const idleMs = lastActivity > 0 ? now - lastActivity : 0;
    if (lastActivity > 0 && idleMs > 30 * 60 * 1000) {
      this.state.storage.sql.exec("UPDATE project SET status = 'paused'");
      this.clearWatchdog();
      this.broadcast({ type: 'play-state', status: 'paused', reason: 'idle-timeout' });
      const idleMsg = 'Auto-paused: no activity for 30 minutes. Hit Play to resume.';
      const idleId = uuid();
      this.state.storage.sql.exec(
        'INSERT INTO chat_history (id, role, body, created_at) VALUES (?, ?, ?, ?)',
        idleId, 'system', idleMsg, now,
      );
      this.broadcast({ type: 'chat', role: 'system', body: idleMsg, id: idleId });
      this.logActivity('control', 'Auto-paused (idle 30 min)');
      return;
    }

    // Cost cap check — spend only counts for the current month. A project that
    // capped last month must not stay paused into a new month (storeMessage
    // resets the counter on the first new-month event, but the cap gate runs
    // before any spend, so compute the effective current-month total here).
    const currentMonth = new Date().toISOString().slice(0, 7);
    const monthlySpent = proj.cost_month === currentMonth ? proj.cost_spent_monthly_usd : 0;
    if (monthlySpent >= proj.cost_cap_monthly_usd) {
      this.state.storage.sql.exec("UPDATE project SET status = 'paused'");
      this.clearWatchdog();
      this.broadcast({ type: 'play-state', status: 'paused', reason: 'cost-cap' });
      this.logActivity('control', `Auto-paused: monthly cost cap reached ($${proj.cost_cap_monthly_usd})`);
      return;
    }

    // Check if any tickets need user input — don't start new work until user responds
    const needsInput = this.state.storage.sql
      .exec("SELECT COUNT(*) as c FROM tickets WHERE status = 'needs-input'")
      .toArray()[0] as { c: number };
    if (needsInput.c > 0) {
      // Agents are waiting for user — don't advance anything else
      return;
    }

    const tickets = this.state.storage.sql
      .exec("SELECT id, status, iterations FROM tickets WHERE status NOT IN ('done','failed','cancelled','needs-input','ba-refining','dev-active','qa-active') ORDER BY created_at")
      .toArray() as { id: string; status: string; iterations: number }[];

    for (const t of tickets) {
      // Re-query active count each iteration to prevent race condition
      const activeCount = (this.state.storage.sql
        .exec("SELECT COUNT(*) as c FROM tickets WHERE status IN ('ba-refining','dev-active','qa-active')")
        .toArray()[0] as { c: number }).c;

      // Don't exceed max concurrent active tickets
      if (activeCount >= 3 && (t.status === 'inbox' || t.status === 'ready' || t.status === 'qa-failed')) {
        break;
      }

      switch (t.status) {
        case 'inbox':
          this.state.storage.sql.exec(
            "UPDATE tickets SET status = 'ba-refining', assignee_role = 'BA', updated_at = ? WHERE id = ?",
            now, t.id,
          );
          this.broadcast({ type: 'transition', ticketId: t.id, from: 'inbox', to: 'ba-refining', auto: true });
          break;

        case 'awaiting-approval':
          // Auto-approve (PO agent trusts BA — user can reject via chat)
          this.state.storage.sql.exec(
            "UPDATE tickets SET status = 'ready', assignee_role = NULL, updated_at = ? WHERE id = ?",
            now, t.id,
          );
          this.broadcast({ type: 'transition', ticketId: t.id, from: 'awaiting-approval', to: 'ready', auto: true });
          break;

        case 'ready':
          this.state.storage.sql.exec(
            "UPDATE tickets SET status = 'dev-active', assignee_role = 'Dev', updated_at = ? WHERE id = ?",
            now, t.id,
          );
          this.broadcast({ type: 'transition', ticketId: t.id, from: 'ready', to: 'dev-active', auto: true });
          break;

        case 'qa-failed':
          if (t.iterations < 5) {
            this.state.storage.sql.exec(
              "UPDATE tickets SET status = 'dev-active', assignee_role = 'Dev', iterations = iterations + 1, updated_at = ? WHERE id = ?",
              now, t.id,
            );
            this.broadcast({ type: 'transition', ticketId: t.id, from: 'qa-failed', to: 'dev-active', auto: true });
          } else {
            this.state.storage.sql.exec(
              "UPDATE tickets SET status = 'failed', stuck_reason = 'Iteration cap reached (5)', updated_at = ? WHERE id = ?",
              now, t.id,
            );
            this.broadcast({ type: 'transition', ticketId: t.id, from: 'qa-failed', to: 'failed', auto: true });
          }
          break;
      }
    }

    // Kick off agent runs for any tickets now sitting in an active state.
    this.runPendingAgents();
  }

  // ── Agent dispatch ────────────────────────────────────────

  /**
   * Find tickets in an active state (ba-refining / dev-active / qa-active) that
   * don't already have a run in flight, and dispatch an agent for each. Runs are
   * fire-and-forget; each one transitions the ticket on completion and re-enters
   * autoAdvance to keep the pipeline moving.
   */
  private runPendingAgents(): void {
    const proj = this.state.storage.sql
      .exec('SELECT status FROM project LIMIT 1')
      .toArray()[0] as { status: string } | undefined;
    if (!proj || proj.status !== 'running') return;

    const active = this.state.storage.sql
      .exec("SELECT id FROM tickets WHERE status IN ('ba-refining','dev-active','qa-active') ORDER BY updated_at")
      .toArray() as { id: string }[];

    for (const t of active) {
      if (this.running.has(t.id)) continue;
      this.dispatchRun(t.id);
    }
  }

  /**
   * Run one agent turn for a ticket: resolve the owner's BYO key, instantiate
   * the configured runtime, stream the turn (persisting messages + cost and
   * broadcasting events), then transition the ticket based on the outcome.
   */
  private async runAgentInternal(ticketId: string): Promise<void> {
    const row = this.state.storage.sql
      .exec('SELECT * FROM tickets WHERE id = ?', ticketId)
      .toArray()[0] as Record<string, unknown> | undefined;
    if (!row) return;
    const ticket = rowToTicket(row);
    const role = assigneeForStatus(ticket.status);
    if (!role) return;

    const proj = this.state.storage.sql
      .exec('SELECT owner_id, slug, owner_session_token FROM project LIMIT 1')
      .toArray()[0] as { owner_id: string; slug: string; owner_session_token: string | null } | undefined;
    if (!proj) return;

    const rcRow = this.state.storage.sql
      .exec('SELECT * FROM role_configs WHERE role = ?', role)
      .toArray()[0] as Record<string, unknown> | undefined;
    if (!rcRow) {
      this.failTicket(ticketId, ticket.status, `Role ${role} is not configured`);
      return;
    }
    const roleConfig = rowToRoleConfig(rcRow);

    // Resolve the owner's BYO key for this runtime's provider.
    const provider = runtimeToProvider(roleConfig.runtime);
    const byoKey = await resolveByoKey(this.env, proj.owner_id, provider);
    if (!byoKey) {
      this.blockForInput(
        ticketId,
        role,
        `${role} needs a ${provider} API key. Add one in the platform key vault (Settings → API Keys), then hit Play.`,
      );
      return;
    }

    this.broadcast({ type: 'agent-run-started', ticketId, role, runtime: roleConfig.runtime });
    this.logActivity('agent', `${role} started`, ticketId);

    const runtime: AgentRuntime = roleConfig.runtime === 'openai-responses'
      ? new OpenAIResponsesRuntime()
      : new CFNativeRuntime();

    const prior = this.state.storage.sql
      .exec('SELECT author, body FROM messages WHERE ticket_id = ? ORDER BY created_at', ticket.id)
      .toArray() as { author: string; body: string }[];
    // Pull the latest committed code before the agent reads/edits (GitHub = truth).
    await this.syncFromGitHub(`before ${role} run`);
    const files = this.loadFiles();
    const messages = buildSeedMessages(role, ticket, proj.slug, prior, [...files.keys()].sort(), formatMemory(this.recallMemory()));

    let assistantText = '';
    const toolCalls: ToolCall[] = [];
    let costUsd = 0;
    let tokensIn = 0;
    let tokensOut = 0;
    let errorMessage: string | null = null;

    try {
      const handle = await runtime.prepare({
        projectId: proj.slug,
        ticketId,
        role: roleConfig,
        byoKey,
        userToken: proj.owner_session_token ?? undefined,
        dispatch: this.makeDispatch(files, proj.slug, proj.owner_session_token ?? null),
      });

      // Consume the stream, but cap wall-clock time so a hung model call can't
      // wedge the ticket forever. On timeout we keep whatever was accumulated
      // and route the ticket to needs-input. `aborted` stops the loop from
      // mutating shared state (files map, DB) after we've moved on.
      let aborted = false;
      const toolActivityIds = new Map<string, string>(); // callId → activity row id
      const consume = (async () => {
        for await (const ev of runtime.run(handle, messages)) {
          if (aborted) break;
          switch (ev.type) {
            case 'text-delta':
              assistantText += ev.text;
              this.broadcast({ type: 'agent-text', ticketId, role, text: ev.text });
              break;
            case 'tool-call': {
              toolCalls.push(ev.call);
              this.broadcast({ type: 'agent-tool-call', ticketId, role, name: ev.call.name });
              const actId = this.logActivity('tool', `${role}: ${toolActivityDetail(ev.call.name, ev.call.args)}`, ticketId,
                JSON.stringify({ args: ev.call.args }));
              toolActivityIds.set(ev.call.id, actId);
              break;
            }
            case 'tool-result': {
              // Attach the result to its call so persisted toolCalls carry it
              // (a future replay of history into the model needs matched pairs).
              const tc = toolCalls.find((c) => c.id === ev.result.callId);
              if (tc) tc.result = ev.result;
              this.broadcast({ type: 'agent-tool-result', ticketId, role, ok: ev.result.ok });
              // Capture the tool's output on its activity row for the audit log.
              const actId = toolActivityIds.get(ev.result.callId);
              if (actId) {
                const out = ev.result.ok ? (typeof ev.result.data === 'string' ? ev.result.data : JSON.stringify(ev.result.data)) : (ev.result.errorMessage ?? 'error');
                this.setActivityMeta(actId, JSON.stringify({ args: tc?.args, ok: ev.result.ok, result: out ?? '(no output)' }));
              }
              break;
            }
            case 'done':
              costUsd = ev.costUsd;
              tokensIn = ev.tokensIn;
              tokensOut = ev.tokensOut;
              break;
            case 'error':
              errorMessage = ev.message;
              break;
            case 'heartbeat':
              this.broadcast({ type: 'agent-heartbeat', ticketId, role });
              break;
          }
        }
      })();

      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<'timeout'>((resolve) => {
        timer = setTimeout(() => resolve('timeout'), MAX_RUN_MINUTES * 60_000);
      });
      const outcome = await Promise.race([consume.then(() => 'ok' as const), timeout]);
      if (timer) clearTimeout(timer);
      if (outcome === 'timeout') {
        aborted = true; // stop the orphaned loop from further state mutation
        errorMessage = errorMessage ?? `run exceeded ${MAX_RUN_MINUTES} minutes`;
      }
    } catch (err) {
      errorMessage = err instanceof Error ? err.message : 'agent run failed';
    }

    // Persist the working tree — Dev's files must survive into the QA run.
    this.saveFiles(files);

    // Persist the agent's output + cost.
    if (assistantText.trim() || toolCalls.length > 0) {
      await this.storeMessage({
        ticketId,
        author: role,
        body: assistantText.trim() || `(${role} ran ${toolCalls.length} tool call(s))`,
        toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
        costUsd,
        tokensIn,
        tokensOut,
        model: roleConfig.model,
      });
    }
    // Mirror the agent's output into the team chat so the collaboration is
    // visible (the chat panel renders BA/Dev/QA roles). Full text lives on the
    // ticket message; the chat copy is capped for readability.
    if (assistantText.trim()) {
      const cid = uuid();
      const chatBody = assistantText.trim().slice(0, 4000);
      this.state.storage.sql.exec(
        'INSERT INTO chat_history (id, role, body, created_at) VALUES (?, ?, ?, ?)',
        cid, role, chatBody, Date.now(),
      );
      this.broadcast({ type: 'chat', role, body: chatBody, id: cid });
    }
    if (costUsd > 0 || tokensIn > 0) {
      this.logActivity('cost', `${role} finished · $${costUsd.toFixed(4)} · ${tokensIn}+${tokensOut} tok`, ticketId);
    }
    if (errorMessage) this.logActivity('error', `${role}: ${errorMessage}`, ticketId);

    // If the cap auto-failed this ticket mid-run, stop here.
    const post = this.state.storage.sql
      .exec('SELECT status FROM tickets WHERE id = ?', ticketId)
      .toArray()[0] as { status: string } | undefined;
    if (!post || isTerminal(post.status as TicketStatus)) {
      return; // dispatcher's finally re-advances the pipeline
    }

    if (errorMessage) {
      this.blockForInput(ticketId, role, `${role} hit an error: ${errorMessage}`);
      return;
    }

    this.applyAgentOutcome(ticketId, role, assistantText);
  }

  /**
   * Dispatch a single agent run for a ticket, clearing the in-flight flag and
   * re-advancing the pipeline once it settles. Centralizes the continuation so
   * the next stage isn't skipped by a still-set run flag.
   */
  private dispatchRun(ticketId: string): void {
    this.running.add(ticketId);
    // Fire-and-forget. The DO stays alive while the promise has pending I/O; the
    // alarm watchdog re-dispatches active tickets if the DO is ever evicted
    // mid-run (so we don't rely on a waitUntil, which DO state doesn't have).
    void this.runAgentInternal(ticketId)
      .catch((e) => {
        // Surface any uncaught run crash — full transparency, never silent.
        const msg = e instanceof Error ? e.message : String(e);
        try {
          this.logActivity('error', `Run crashed: ${msg}`, ticketId);
          this.blockForInput(ticketId, assigneeForStatus(
            (this.state.storage.sql.exec('SELECT status FROM tickets WHERE id = ?', ticketId).toArray()[0] as { status: TicketStatus } | undefined)?.status ?? 'inbox',
          ) ?? 'BA', `Run crashed: ${msg}`);
        } catch { /* last-resort: don't throw from the error handler */ }
      })
      .finally(() => {
        this.running.delete(ticketId);
        // A completed run is pipeline progress — reset the idle timer so a long
        // autonomous build (no user chat) isn't auto-paused mid-flight.
        this.touchUserActivity();
        try { this.autoAdvance(); } catch { /* keep the watchdog as backstop */ }
      });
  }

  // ── Project working tree (file map) ──────────────────────────
  // The Dev/QA file tools edit this map (in spine.ts). It persists between runs
  // so Dev's output survives into the QA run and back into a qa-failed re-run.

  // ── Project memory (durable decisions/facts the team reads each run) ───────

  private recallMemory(): MemoryEntry[] {
    const rows = this.state.storage.sql
      .exec('SELECT id, category, key, value, created_at, updated_at FROM project_memory ORDER BY updated_at DESC')
      .toArray() as { id: string; category: string; key: string; value: string; created_at: number; updated_at: number }[];
    return rows.map((r) => ({ id: r.id, category: r.category, key: r.key, value: r.value, createdAt: r.created_at, updatedAt: r.updated_at }));
  }

  /** Upsert a memory by key (so a decision can be revised, not duplicated). */
  private rememberFact(category: string, key: string, value: string): void {
    const k = key.trim().slice(0, 120);
    const v = value.trim().slice(0, 2000);
    if (!k || !v) return;
    const now = Date.now();
    const existing = this.state.storage.sql.exec('SELECT id FROM project_memory WHERE key = ?', k).toArray()[0] as { id: string } | undefined;
    if (existing) {
      this.state.storage.sql.exec('UPDATE project_memory SET value = ?, category = ?, updated_at = ? WHERE key = ?', v, category, now, k);
    } else {
      this.state.storage.sql.exec(
        'INSERT INTO project_memory (id, category, key, value, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
        uuid(), category, k, v, now, now,
      );
    }
    this.logActivity('memory', `Remembered: ${k}`);
    this.broadcast({ type: 'memory-updated' });
  }

  private async addMemory(request: Request): Promise<Response> {
    const body = (await request.json()) as { category?: string; key?: string; value?: string };
    if (!body.key?.trim() || !body.value?.trim()) return json({ error: 'key and value required' }, 400);
    this.rememberFact(body.category ?? 'decision', body.key, body.value);
    return json({ memory: this.recallMemory() });
  }

  private forgetMemory(id: string): Response {
    this.state.storage.sql.exec('DELETE FROM project_memory WHERE id = ?', id);
    this.broadcast({ type: 'memory-updated' });
    return json({ ok: true });
  }

  /** List the project's working-tree files (path + size) for the console's file
   *  preview panel. Content is fetched lazily per file via getProjectFile. */
  private listProjectFiles(): Response {
    const rows = this.state.storage.sql
      .exec('SELECT path, length(content) AS size, updated_at FROM project_files ORDER BY path')
      .toArray() as { path: string; size: number; updated_at: number }[];
    return json({ files: rows.map((r) => ({ path: r.path, size: r.size, updatedAt: r.updated_at })) });
  }

  /** Return one file's content (for the preview panel). Capped to avoid shipping
   *  a huge build artifact down the wire. */
  private getProjectFile(filePath: string): Response {
    if (!filePath) return json({ error: 'path required' }, 400);
    const row = this.state.storage.sql
      .exec('SELECT path, content FROM project_files WHERE path = ?', filePath)
      .toArray()[0] as { path: string; content: string } | undefined;
    if (!row) return json({ error: 'not_found' }, 404);
    const MAX = 200_000;
    const truncated = row.content.length > MAX;
    return json({ path: row.path, content: truncated ? row.content.slice(0, MAX) : row.content, truncated });
  }

  /**
   * Keep the working tree in sync with GitHub (the source of truth). Cheap:
   * checks the latest commit SHA first and only pulls file contents when GitHub
   * has moved since our last sync. Called before every run and PO investigation,
   * so agents always see the latest committed code. Best-effort — never throws.
   *
   * Safety: when GitHub's HEAD equals our last-synced SHA we do nothing, so a
   * team's mid-ticket unpushed edits (working tree ahead of GitHub) are never
   * clobbered. We only replace the tree when GitHub itself moved.
   */
  private async syncFromGitHub(reason: string): Promise<{ pulled: boolean; count?: number }> {
    if (!this.env.ADMIN || !this.env.INTERNAL_TOKEN) return { pulled: false };
    const proj = this.state.storage.sql
      .exec('SELECT slug, repo_synced_sha FROM project LIMIT 1')
      .toArray()[0] as { slug: string; repo_synced_sha: string | null } | undefined;
    if (!proj?.slug) return { pulled: false };

    const callAdmin = async (headOnly: boolean) => {
      const res = await this.env.ADMIN!.fetch(new Request('https://admin.proappstore.online/api/repo-pull', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Internal-Token': this.env.INTERNAL_TOKEN! },
        body: JSON.stringify({ id: proj.slug, headOnly }),
      }));
      return res.json() as Promise<{ ok: boolean; sha?: string; files?: Record<string, string>; truncated?: boolean }>;
    };

    try {
      const head = await callAdmin(true);
      if (!head.ok || !head.sha) return { pulled: false }; // no repo / no commits
      if (head.sha === proj.repo_synced_sha) return { pulled: false }; // already current

      const pull = await callAdmin(false);
      if (!pull.ok || !pull.files) return { pulled: false };
      const entries = Object.entries(pull.files);
      this.saveFiles(new Map(entries)); // mirror GitHub (only reached when it moved)
      const now = Date.now();
      this.state.storage.sql.exec('UPDATE project SET repo_synced_sha = ?, repo_synced_at = ?', pull.sha ?? head.sha, now);
      this.logActivity('sync', `Synced ${entries.length} file(s) from GitHub @${(pull.sha ?? head.sha)!.slice(0, 7)} (${reason})`);
      this.broadcast({ type: 'files-synced', count: entries.length });
      return { pulled: true, count: entries.length };
    } catch {
      return { pulled: false };
    }
  }

  private loadFiles(): Map<string, string> {
    const rows = this.state.storage.sql
      .exec('SELECT path, content FROM project_files')
      .toArray() as { path: string; content: string }[];
    return new Map(rows.map((r) => [r.path, r.content]));
  }

  private saveFiles(files: Map<string, string>): void {
    const now = Date.now();
    // Small projects — replace wholesale so deletions are reflected.
    this.state.storage.sql.exec('DELETE FROM project_files');
    for (const [path, content] of files) {
      this.state.storage.sql.exec(
        'INSERT INTO project_files (path, content, updated_at) VALUES (?, ?, ?)',
        path, content, now,
      );
    }
  }

  /** Build the tool executor injected into a runtime for one run. */
  private makeDispatch(
    files: Map<string, string>,
    slug: string,
    ownerToken: string | null,
  ): (call: ToolCall) => Promise<ToolResult> {
    return async (call) => {
      if (isFileTool(call.name)) return executeFileTool(call, files);
      return this.executeInfraTool(call, slug, files, ownerToken);
    };
  }

  /**
   * Infra tools (scaffold/provision/deploy-status). Repo creation + file push +
   * registry is delegated to the PAS admin Worker (the sanctioned repo creator)
   * over the ADMIN service binding. scaffold_app and provision_app both ship the
   * current working tree — idempotent: admin creates the repo if needed and
   * pushes the files on top.
   */
  private async executeInfraTool(
    call: ToolCall,
    slug: string,
    files: Map<string, string>,
    _ownerToken: string | null,
  ): Promise<ToolResult> {
    const start = Date.now();
    const args = (call.args ?? {}) as Record<string, unknown>;

    switch (call.name) {
      case 'scaffold_app':
      case 'provision_app': {
        if (files.size === 0) {
          return { callId: call.id, ok: false, errorMessage: 'No files to deploy yet — author the app first, then deploy.', durationMs: Date.now() - start };
        }
        if (!this.env.ADMIN || !this.env.INTERNAL_TOKEN) {
          return { callId: call.id, ok: true, data: `Staged ${files.size} file(s) for "${slug}" (deploy binding not configured in this environment).`, durationMs: Date.now() - start };
        }
        try {
          // CONTRACT (agent-deploy): body matches AgentDeployRequest in
          // packages/admin/src/publish.ts. Same monorepo — keep in sync.
          const res = await this.env.ADMIN.fetch(new Request('https://admin.proappstore.online/api/agent-deploy', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-Internal-Token': this.env.INTERNAL_TOKEN },
            body: JSON.stringify({
              id: slug,
              name: String(args.name ?? slug),
              description: String(args.description ?? ''),
              files: Object.fromEntries(files),
            }),
          }));
          const data = (await res.json()) as {
            success?: boolean;
            repoUrl?: string | null;
            steps?: { name: string; status: string; detail: string }[];
          };
          const steps = (data.steps ?? []).map((s) => `${s.name}: ${s.status}`).join(', ');
          if (!res.ok || !data.success) {
            const detail = (data.steps ?? []).filter((s) => s.status === 'fail').map((s) => `${s.name} — ${s.detail}`).join('; ');
            return { callId: call.id, ok: false, errorMessage: `Deploy failed: ${detail || `admin returned ${res.status}`}`, durationMs: Date.now() - start };
          }
          if (data.repoUrl) {
            this.state.storage.sql.exec('UPDATE project SET repo_url = ? WHERE repo_url IS NULL', data.repoUrl);
          }
          return { callId: call.id, ok: true, data: `Deployed "${slug}" → ${data.repoUrl ?? 'repo'} (${steps}). CI deploys from the repo.`, durationMs: Date.now() - start };
        } catch (err) {
          return { callId: call.id, ok: false, errorMessage: `Deploy error: ${err instanceof Error ? err.message : 'unknown'}`, durationMs: Date.now() - start };
        }
      }

      case 'get_deploy_status': {
        const proj = this.state.storage.sql
          .exec('SELECT repo_url FROM project LIMIT 1')
          .toArray()[0] as { repo_url: string | null } | undefined;
        return {
          callId: call.id,
          ok: true,
          data: proj?.repo_url
            ? `Repo: ${proj.repo_url} — files pushed; CI deploys from the repo.`
            : `"${slug}" is not deployed yet. Author the app, then call provision_app.`,
          durationMs: Date.now() - start,
        };
      }

      default:
        return { callId: call.id, ok: false, errorMessage: `Unknown tool: ${call.name}`, durationMs: Date.now() - start };
    }
  }

  /** Transition a ticket forward after a successful agent run. */
  private applyAgentOutcome(ticketId: string, role: Role, output: string): void {
    const now = Date.now();
    if (role === 'BA') {
      // Stash the BA's analysis as a minimal spec and await approval.
      const spec: BaSpec = {
        summary: output.slice(0, 4000),
        acceptanceCriteria: [],
        sdkPrimitives: [],
        filesToCreate: [],
        outOfScope: [],
        approvedBy: null,
        approvedAt: null,
        revisionOf: null,
      };
      this.state.storage.sql.exec(
        "UPDATE tickets SET status = 'awaiting-approval', assignee_role = NULL, spec_json = ?, updated_at = ? WHERE id = ?",
        JSON.stringify(spec), now, ticketId,
      );
      this.broadcast({ type: 'transition', ticketId, from: 'ba-refining', to: 'awaiting-approval', trigger: 'BA' });
      this.logActivity('transition', 'BA finished spec → awaiting approval', ticketId);
    } else if (role === 'Dev') {
      this.state.storage.sql.exec(
        "UPDATE tickets SET status = 'qa-active', assignee_role = 'QA', updated_at = ? WHERE id = ?",
        now, ticketId,
      );
      this.broadcast({ type: 'transition', ticketId, from: 'dev-active', to: 'qa-active', trigger: 'Dev' });
      this.logActivity('transition', 'Dev finished → QA review', ticketId);
    } else if (role === 'QA') {
      const failed = qaVerdict(output) === 'qa-failed';
      if (failed) {
        this.state.storage.sql.exec(
          "UPDATE tickets SET status = 'qa-failed', assignee_role = 'Dev', updated_at = ? WHERE id = ?",
          now, ticketId,
        );
        this.broadcast({ type: 'transition', ticketId, from: 'qa-active', to: 'qa-failed', trigger: 'QA' });
        this.logActivity('transition', 'QA failed → back to Dev', ticketId);
      } else {
        this.state.storage.sql.exec(
          "UPDATE tickets SET status = 'done', assignee_role = NULL, updated_at = ? WHERE id = ?",
          now, ticketId,
        );
        this.broadcast({ type: 'transition', ticketId, from: 'qa-active', to: 'done', trigger: 'QA' });
        this.logActivity('transition', 'QA passed → done', ticketId);
      }
    }
  }

  /** Park a ticket in needs-input with a message to the user. */
  private blockForInput(ticketId: string, role: Role, message: string): void {
    const now = Date.now();
    // Persist the blocking role so the chat resume restarts the right stage
    // (resume keys off assignee_role).
    this.state.storage.sql.exec(
      "UPDATE tickets SET status = 'needs-input', assignee_role = ?, updated_at = ? WHERE id = ?",
      role, now, ticketId,
    );
    const blockId = uuid();
    this.state.storage.sql.exec(
      'INSERT INTO chat_history (id, role, body, created_at) VALUES (?, ?, ?, ?)',
      blockId, 'system', message, now,
    );
    this.logActivity('blocked', message, ticketId);
    this.broadcast({ type: 'transition', ticketId, to: 'needs-input', reason: 'agent-blocked', role });
    this.broadcast({ type: 'chat', role: 'system', body: message, id: blockId });
  }

  /** Hard-fail a ticket (system trigger). */
  private failTicket(ticketId: string, from: TicketStatus, reason: string): void {
    const now = Date.now();
    this.state.storage.sql.exec(
      "UPDATE tickets SET status = 'failed', stuck_reason = ?, updated_at = ? WHERE id = ?",
      reason, now, ticketId,
    );
    this.broadcast({ type: 'transition', ticketId, from, to: 'failed', trigger: 'system', reason });
  }

  private async initProject(request: Request): Promise<Response> {
    const body = (await request.json()) as Partial<Project> & { idea?: string };
    if (!body.name || !body.slug || !body.ownerId) {
      return json({ error: 'name, slug, ownerId required' }, 400);
    }

    // Prevent re-init takeover: reject if project already exists
    const existing = this.state.storage.sql
      .exec('SELECT id, owner_id FROM project LIMIT 1')
      .toArray()[0] as { id: string; owner_id: string } | undefined;
    if (existing) {
      // Only the owner can re-init (to update name/cap)
      const userId = request.headers.get('X-User-Id');
      if (existing.owner_id !== userId) {
        return json({ error: 'not_found' }, 404);
      }
      // Update, don't replace (preserve cost tracking)
      this.state.storage.sql.exec(
        'UPDATE project SET name = ?, cost_cap_monthly_usd = ? WHERE id = ?',
        body.name, body.costCapMonthlyUsd ?? 50.0, existing.id,
      );
      return json({ id: existing.id, slug: body.slug });
    }

    const id = uuid();
    const now = Date.now();

    this.state.storage.sql.exec(
      `INSERT INTO project (id, owner_id, name, slug, created_at, cost_cap_monthly_usd)
       VALUES (?, ?, ?, ?, ?, ?)`,
      id, body.ownerId, body.name, body.slug, now, body.costCapMonthlyUsd ?? 50.0,
    );

    // Set default role configs
    const defaults: RoleConfig[] = [
      { role: 'BA', runtime: 'cf-native', model: 'claude-sonnet-4-6', maxTokens: 8192, spineTools: [], vendorTools: [] },
      { role: 'Dev', runtime: 'cf-native', model: 'claude-sonnet-4-6', maxTokens: 16384, spineTools: ['scaffold_app', 'write_file', 'read_file', 'list_files', 'batch_write_files', 'search_files', 'get_deploy_status', 'provision_app'], vendorTools: [] },
      { role: 'QA', runtime: 'cf-native', model: 'claude-sonnet-4-6', maxTokens: 8192, spineTools: ['read_file', 'list_files', 'search_files', 'get_deploy_status'], vendorTools: [] },
    ];

    for (const rc of defaults) {
      this.state.storage.sql.exec(
        `INSERT OR REPLACE INTO role_configs (role, runtime, model, spine_tools, vendor_tools, max_tokens, persona)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        rc.role, rc.runtime, rc.model, JSON.stringify(rc.spineTools), JSON.stringify(rc.vendorTools), rc.maxTokens ?? null,
        DEFAULT_PERSONAS[rc.role] ?? null,
      );
    }

    // Seed the first ticket from the initial idea so the project is play-ready:
    // the agent team is already configured above, and now there's work for it.
    const idea = body.idea?.trim();
    if (idea) {
      const ticketId = uuid();
      const title = idea.length > 80 ? `${idea.slice(0, 77)}...` : idea;
      this.state.storage.sql.exec(
        `INSERT INTO tickets (id, title, raw_idea, status, created_at, updated_at)
         VALUES (?, ?, ?, 'inbox', ?, ?)`,
        ticketId, title, idea, now, now,
      );
    }

    this.broadcast({ type: 'project-created', projectId: id });
    return json({ id, slug: body.slug, seededTicket: Boolean(idea) });
  }

  // ── Role configs ──────────────────────────────────────────

  private getRoles(): Response {
    const rows = this.state.storage.sql
      .exec('SELECT * FROM role_configs ORDER BY role')
      .toArray();
    const configs = rows.map(rowToRoleConfig);
    return json({ roles: configs });
  }

  private async setRoles(request: Request): Promise<Response> {
    const body = (await request.json()) as { roles: RoleConfig[] };

    const VALID_ROLES = new Set(['BA', 'Dev', 'QA']);
    const VALID_RUNTIMES = new Set(['cf-native', 'openai-responses']);
    const VALID_TOOLS = new Set([
      'scaffold_app', 'write_file', 'read_file', 'list_files', 'delete_file',
      'search_files', 'batch_write_files', 'get_deploy_status', 'provision_app',
    ]);

    for (const rc of body.roles) {
      if (!VALID_ROLES.has(rc.role)) return json({ error: `invalid role: ${rc.role}` }, 400);
      if (!VALID_RUNTIMES.has(rc.runtime)) return json({ error: `invalid runtime: ${rc.runtime}` }, 400);
      if (!rc.model || rc.model.length > 64) return json({ error: 'model must be 1-64 chars' }, 400);
      // Validate spine tools against catalog
      for (const tool of rc.spineTools) {
        if (!VALID_TOOLS.has(tool)) return json({ error: `unknown spine tool: ${tool}` }, 400);
      }
      // System prompt override: cap length, no prompt injection basics
      if (rc.systemPromptOverride && rc.systemPromptOverride.length > 8192) {
        return json({ error: 'systemPromptOverride too long (max 8KB)' }, 400);
      }
      // Output token cap: optional, but bounded to sane limits when set.
      if (rc.maxTokens != null && (!Number.isInteger(rc.maxTokens) || rc.maxTokens < 1024 || rc.maxTokens > 64000)) {
        return json({ error: 'maxTokens must be an integer between 1024 and 64000' }, 400);
      }
      if (rc.persona && rc.persona.length > 4096) {
        return json({ error: 'persona too long (max 4KB)' }, 400);
      }

      this.state.storage.sql.exec(
        `INSERT OR REPLACE INTO role_configs (role, runtime, model, system_prompt_override, spine_tools, vendor_tools, max_tokens, persona)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        rc.role, rc.runtime, rc.model, rc.systemPromptOverride ?? null,
        JSON.stringify(rc.spineTools), JSON.stringify(rc.vendorTools), rc.maxTokens ?? null, rc.persona ?? null,
      );
    }
    return json({ ok: true });
  }

  // ── Tickets ───────────────────────────────────────────────

  private listTickets(): Response {
    const rows = this.state.storage.sql
      .exec('SELECT * FROM tickets ORDER BY created_at DESC')
      .toArray();
    return json({ tickets: rows.map(rowToTicket) });
  }

  private getTicket(id: string): Response {
    const row = this.state.storage.sql
      .exec('SELECT * FROM tickets WHERE id = ?', id)
      .toArray()[0];
    if (!row) return json({ error: 'ticket_not_found' }, 404);
    return json(rowToTicket(row));
  }

  private async createTicket(request: Request): Promise<Response> {
    const body = (await request.json()) as { title: string; rawIdea: string };
    if (!body.title || !body.rawIdea) {
      return json({ error: 'title and rawIdea required' }, 400);
    }

    const id = uuid();
    const now = Date.now();

    this.state.storage.sql.exec(
      `INSERT INTO tickets (id, title, raw_idea, status, created_at, updated_at)
       VALUES (?, ?, ?, 'inbox', ?, ?)`,
      id, body.title, body.rawIdea, now, now,
    );

    const ticket: Ticket = {
      id,
      projectId: '',
      title: body.title,
      rawIdea: body.rawIdea,
      spec: null,
      status: 'inbox',
      assigneeRole: null,
      iterations: 0,
      createdAt: now,
      updatedAt: now,
      costSpentUsd: 0,
      prUrl: null,
      finalCommitSha: null,
      stuckReason: null,
    };

    this.broadcast({ type: 'ticket-created', ticket });
    this.logActivity('ticket', `Created: ${body.title}`, id);
    this.autoAdvance();
    return json(ticket, 201);
  }

  private async updateTicket(id: string, request: Request): Promise<Response> {
    const body = (await request.json()) as Partial<Ticket>;
    const now = Date.now();

    const sets: string[] = ['updated_at = ?'];
    const vals: unknown[] = [now];

    if (body.title !== undefined) { sets.push('title = ?'); vals.push(body.title); }
    if (body.rawIdea !== undefined) { sets.push('raw_idea = ?'); vals.push(body.rawIdea); }
    if (body.spec !== undefined) { sets.push('spec_json = ?'); vals.push(JSON.stringify(body.spec)); }
    if (body.prUrl !== undefined) { sets.push('pr_url = ?'); vals.push(body.prUrl); }
    if (body.finalCommitSha !== undefined) { sets.push('final_commit_sha = ?'); vals.push(body.finalCommitSha); }

    vals.push(id);
    this.state.storage.sql.exec(
      `UPDATE tickets SET ${sets.join(', ')} WHERE id = ?`,
      ...vals,
    );

    this.broadcast({ type: 'ticket-updated', ticketId: id });
    return this.getTicket(id);
  }

  // Delete a ticket and its messages. Activity/cost-ledger rows are kept as an
  // audit trail. Broadcasts so open boards/panels drop it live.
  private deleteTicket(id: string): Response {
    const row = this.state.storage.sql
      .exec('SELECT title FROM tickets WHERE id = ?', id)
      .toArray()[0] as { title: string } | undefined;
    if (!row) return json({ error: 'not_found' }, 404);
    this.state.storage.sql.exec('DELETE FROM messages WHERE ticket_id = ?', id);
    this.state.storage.sql.exec('DELETE FROM tickets WHERE id = ?', id);
    this.logActivity('control', `Ticket deleted: ${row.title}`, null);
    this.broadcast({ type: 'ticket-deleted', ticketId: id });
    return json({ ok: true });
  }

  private async transitionTicket(id: string, request: Request): Promise<Response> {
    const body = (await request.json()) as {
      to: TicketStatus;
      trigger: 'po' | Role | 'system';
      reason?: string;
    };

    const row = this.state.storage.sql
      .exec('SELECT * FROM tickets WHERE id = ?', id)
      .toArray()[0];
    if (!row) return json({ error: 'ticket_not_found' }, 404);

    const ticket = rowToTicket(row);

    if (!canTransition(ticket.status, body.to, body.trigger)) {
      return json({
        error: 'invalid_transition',
        from: ticket.status,
        to: body.to,
        trigger: body.trigger,
      }, 400);
    }

    // Check iteration cap for qa-failed → dev-active
    if (ticket.status === 'qa-failed' && body.to === 'dev-active') {
      if (ticket.iterations >= MAX_ITERATIONS) {
        // Auto-fail instead
        this.state.storage.sql.exec(
          `UPDATE tickets SET status = 'failed', stuck_reason = ?, updated_at = ? WHERE id = ?`,
          `Iteration cap reached (${MAX_ITERATIONS})`, Date.now(), id,
        );
        this.broadcast({ type: 'ticket-failed', ticketId: id, reason: 'iteration_cap' });
        return this.getTicket(id);
      }
    }

    const now = Date.now();
    const assignee = assigneeForStatus(body.to);
    const iterationBump = (ticket.status === 'qa-failed' && body.to === 'dev-active') ? 1 : 0;

    this.state.storage.sql.exec(
      `UPDATE tickets SET status = ?, assignee_role = ?, iterations = iterations + ?,
       stuck_reason = ?, updated_at = ? WHERE id = ?`,
      body.to, assignee, iterationBump, body.reason ?? null, now, id,
    );

    this.broadcast({
      type: 'ticket-transition',
      ticketId: id,
      from: ticket.status,
      to: body.to,
      trigger: body.trigger,
    });

    return this.getTicket(id);
  }

  // ── Messages ──────────────────────────────────────────────

  private listMessages(ticketId: string): Response {
    const rows = this.state.storage.sql
      .exec('SELECT * FROM messages WHERE ticket_id = ? ORDER BY created_at', ticketId)
      .toArray();
    return json({ messages: rows.map(rowToMessage) });
  }

  private async addMessage(ticketId: string, request: Request): Promise<Response> {
    const body = (await request.json()) as {
      author: string;
      body: string;
      toolCalls?: ToolCall[];
      costUsd?: number;
      tokensIn?: number;
      tokensOut?: number;
    };

    // Validate non-negative cost/token values
    if ((body.costUsd ?? 0) < 0 || (body.tokensIn ?? 0) < 0 || (body.tokensOut ?? 0) < 0) {
      return json({ error: 'cost and token values must be non-negative' }, 400);
    }
    if (!body.body || !body.author) {
      return json({ error: 'author and body required' }, 400);
    }

    const id = await this.storeMessage({
      ticketId,
      author: body.author,
      body: body.body,
      toolCalls: body.toolCalls,
      costUsd: body.costUsd ?? 0,
      tokensIn: body.tokensIn ?? 0,
      tokensOut: body.tokensOut ?? 0,
      model: 'unknown',
    });
    return json({ id }, 201);
  }

  /**
   * Persist a message + roll up its cost. Shared by the public addMessage
   * route and autonomous agent runs. Offloads bodies > 8KB to R2, updates the
   * ticket + monthly project cost (with month reset), records the cost ledger,
   * and auto-fails active tickets when the monthly cap is hit. Returns the id.
   */
  private async storeMessage(opts: {
    ticketId: string;
    author: string;
    body: string;
    toolCalls?: ToolCall[] | undefined;
    costUsd?: number | undefined;
    tokensIn?: number | undefined;
    tokensOut?: number | undefined;
    model?: string | undefined;
  }): Promise<string> {
    const id = uuid();
    const now = Date.now();
    const costUsd = opts.costUsd ?? 0;
    const tokensIn = opts.tokensIn ?? 0;
    const tokensOut = opts.tokensOut ?? 0;

    // Offload large bodies to R2
    let storedBody = opts.body;
    let offloadKey: string | null = null;
    if (opts.body.length > 8192) {
      offloadKey = `messages/${opts.ticketId}/${id}`;
      await this.env.AGENT_STORAGE.put(offloadKey, opts.body);
      storedBody = opts.body.slice(0, 200) + '... [offloaded]';
    }

    this.state.storage.sql.exec(
      `INSERT INTO messages (id, ticket_id, author, body, tool_calls_json, created_at, cost_usd, tokens_in, tokens_out, body_offload_key)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id, opts.ticketId, opts.author, storedBody,
      opts.toolCalls ? JSON.stringify(opts.toolCalls) : null,
      now, costUsd, tokensIn, tokensOut, offloadKey,
    );

    // Update cost on ticket and project (with monthly reset)
    if (costUsd > 0) {
      this.state.storage.sql.exec(
        'UPDATE tickets SET cost_spent_usd = cost_spent_usd + ? WHERE id = ?',
        costUsd, opts.ticketId,
      );

      // Monthly cost reset: check if we're in a new month
      const currentMonth = new Date().toISOString().slice(0, 7); // YYYY-MM
      const proj = this.state.storage.sql
        .exec('SELECT cost_month, cost_cap_monthly_usd, cost_spent_monthly_usd FROM project LIMIT 1')
        .toArray()[0] as { cost_month: string; cost_cap_monthly_usd: number; cost_spent_monthly_usd: number } | undefined;

      if (proj && proj.cost_month !== currentMonth) {
        // New month: reset counter
        this.state.storage.sql.exec(
          'UPDATE project SET cost_spent_monthly_usd = ?, cost_month = ?',
          costUsd, currentMonth,
        );
      } else {
        this.state.storage.sql.exec(
          'UPDATE project SET cost_spent_monthly_usd = cost_spent_monthly_usd + ?, cost_month = ?',
          costUsd, currentMonth,
        );
      }

      // Record in cost ledger (permanent, never reset)
      this.state.storage.sql.exec(
        `INSERT INTO cost_ledger (ticket_id, role, cost_usd, tokens_in, tokens_out, model, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        opts.ticketId, opts.author, costUsd, tokensIn, tokensOut, opts.model ?? 'unknown', now,
      );

      // Re-read after update for cap check
      const updated = this.state.storage.sql
        .exec('SELECT cost_cap_monthly_usd, cost_spent_monthly_usd FROM project LIMIT 1')
        .toArray()[0] as { cost_cap_monthly_usd: number; cost_spent_monthly_usd: number } | undefined;

      if (updated && updated.cost_spent_monthly_usd >= updated.cost_cap_monthly_usd) {
        // Auto-fail all active tickets
        this.state.storage.sql.exec(
          `UPDATE tickets SET status = 'failed', stuck_reason = 'Monthly cost cap reached', updated_at = ?
           WHERE status IN ('ba-refining', 'dev-active', 'qa-active', 'qa-failed')`,
          now,
        );
        this.broadcast({ type: 'cost-cap-reached', spent: updated.cost_spent_monthly_usd, cap: updated.cost_cap_monthly_usd });
      }
    }

    // Bump the ticket's updated_at so the console's open-ticket panel detects the
    // new message and reloads (the client uses updatedAt as the change signature).
    this.state.storage.sql.exec('UPDATE tickets SET updated_at = ? WHERE id = ?', now, opts.ticketId);
    this.broadcast({ type: 'message', ticketId: opts.ticketId, messageId: id, author: opts.author });
    return id;
  }

  // ── Chat (PO agent triage) ──────────────────────────────────

  // Wipe the chat history (start the conversation from scratch). Tickets/messages
  // are unaffected — this only clears the founder↔PO chat panel.
  private clearChat(): Response {
    this.state.storage.sql.exec('DELETE FROM chat_history');
    this.chatWindow = [];
    this.broadcast({ type: 'chat-cleared' });
    return json({ ok: true });
  }

  private getChatHistory(): Response {
    const rows = this.state.storage.sql
      .exec('SELECT * FROM chat_history ORDER BY created_at ASC')
      .toArray();
    return json({
      messages: rows.map((r) => ({
        id: r.id as string,
        role: r.role as string,
        body: r.body as string,
        toolCall: r.tool_call_json ? JSON.parse(r.tool_call_json as string) : undefined,
        createdAt: r.created_at as number,
      })),
    });
  }

  private async handleChat(request: Request): Promise<Response> {
    const body = (await request.json()) as { message: string; apiKey?: string };
    if (!body.message?.trim()) return json({ error: 'message required' }, 400);
    if (body.message.length > 8192) return json({ error: 'message too long (max 8KB)' }, 413);

    // Per-project chat throttle (each message triggers a PO LLM call).
    const limit = slidingWindowAllow(this.chatWindow, Date.now(), CHAT_LIMIT, CHAT_WINDOW_MS);
    this.chatWindow = limit.times;
    if (!limit.allowed) return json({ error: 'Too many messages — please slow down.' }, 429);

    const userText = body.message.trim();
    const now = Date.now();

    // Record user activity (resets idle timeout)
    this.touchUserActivity();

    // Sync the working tree with GitHub so the PO answers from the latest code.
    await this.syncFromGitHub('PO chat');

    // Check if any tickets are in needs-input — user's message might be the answer
    const blockedTickets = this.state.storage.sql
      .exec("SELECT id, assignee_role FROM tickets WHERE status = 'needs-input' ORDER BY updated_at LIMIT 1")
      .toArray() as { id: string; assignee_role: string }[];

    if (blockedTickets.length > 0) {
      const blocked = blockedTickets[0]!;
      // Save the user's answer as a message on the ticket
      this.state.storage.sql.exec(
        'INSERT INTO messages (id, ticket_id, author, body, created_at) VALUES (?, ?, ?, ?, ?)',
        uuid(), blocked.id, 'po', userText, now,
      );
      // Resume to a "pending" state so autoAdvance picks it up and re-assigns
      // Don't go directly to an active state — the agent needs to restart
      const resumeStatus = blocked.assignee_role === 'BA' ? 'ba-refining'
        : blocked.assignee_role === 'QA' ? 'qa-active'
        : 'dev-active';
      this.state.storage.sql.exec(
        'UPDATE tickets SET status = ?, updated_at = ? WHERE id = ?',
        resumeStatus, now, blocked.id,
      );
      this.broadcast({ type: 'transition', ticketId: blocked.id, from: 'needs-input', to: resumeStatus, reason: 'user-answered' });
      this.autoAdvance();
    }

    // Save user message to chat history
    const userMsgId = uuid();
    this.state.storage.sql.exec(
      'INSERT INTO chat_history (id, role, body, created_at) VALUES (?, ?, ?, ?)',
      userMsgId, 'user', userText, now,
    );
    this.broadcast({ type: 'chat', role: 'user', body: userText, id: userMsgId });

    // Get current project state for context
    const ticketRows = this.state.storage.sql
      .exec('SELECT id, title, status, assignee_role FROM tickets ORDER BY created_at DESC LIMIT 20')
      .toArray();
    const backlogSummary = ticketRows.map((t) =>
      `- [${t.status}] ${t.title}${t.assignee_role ? ` (${t.assignee_role})` : ''}`
    ).join('\n');

    // The app's current files — so the PO can answer questions about the actual
    // app ("do we use google or github?") instead of guessing generically.
    const fileList = [...this.loadFiles().keys()].sort();

    // App identity — the PO must reason about THIS app, not the ProAppStore
    // platform it's hosted on. Name from the project; "what it is" from the
    // founding idea (oldest ticket) when present.
    const proj = this.state.storage.sql
      .exec('SELECT name, slug FROM project LIMIT 1')
      .toArray()[0] as { name: string; slug: string } | undefined;
    const founding = this.state.storage.sql
      .exec('SELECT raw_idea FROM tickets ORDER BY created_at ASC LIMIT 1')
      .toArray()[0] as { raw_idea: string } | undefined;
    const appName = proj?.name ?? proj?.slug ?? 'this app';
    const appIdea = founding?.raw_idea?.trim();

    // Get recent chat history for context
    const recentChat = this.state.storage.sql
      .exec('SELECT role, body FROM chat_history ORDER BY created_at DESC LIMIT 20')
      .toArray()
      .reverse()
      .map((r) => ({ role: r.role as string, body: r.body as string }));

    // Resolve the PO's model key: prefer a client-supplied key, else fall back
    // to the owner's BYO key in the vault. Only drop to the rule-based PO if
    // neither is available.
    let apiKey = body.apiKey;
    if (!apiKey) {
      const owner = this.state.storage.sql
        .exec('SELECT owner_id FROM project LIMIT 1')
        .toArray()[0] as { owner_id: string } | undefined;
      if (owner) {
        apiKey = (await resolveByoKey(this.env, owner.owner_id, 'anthropic')) ?? undefined;
      }
    }
    if (!apiKey) {
      return this.poTriageWithoutAI(userText, backlogSummary, now);
    }

    const memoryBlock = formatMemory(this.recallMemory());

    // Call Anthropic for real PO agent response
    const systemPrompt = `${PO_PERSONA}

You are the PO (Product Owner) agent for the app "${appName}" (id: ${proj?.slug ?? 'app'}).

${appIdea ? `What "${appName}" is:\n${appIdea}\n` : `You don't have a description of "${appName}" yet. If the founder asks something that depends on what the app is, ASK them what they're building rather than guessing.\n`}
${memoryBlock ? `${memoryBlock}\n\n` : ''}CRITICAL CONTEXT: "${appName}" is an app a founder is building ON the ProAppStore platform (ProAppStore is just the hosting + SDK provider). ProAppStore is NOT this app. Never assume "${appName}" is ProAppStore, a developer tool, or that its users are developers — reason ONLY about "${appName}" using its files, backlog, founding idea, and what the founder tells you.

You read the founder's messages and decide what to do.

You have read-only tools to inspect the app's code: list_files, read_file, search_files. USE them. You also have a "remember" tool — call it to record durable decisions/facts (e.g. {key:"auth", value:"GitHub OAuth"}) whenever the founder decides something, so the whole team keeps it as ground truth.

Your job:
- If the founder asks a FACTUAL question about the app ("does it use google or github sign-in?", "is there a settings page?") → check project memory above first, then investigate with your tools (search_files / read_file) and answer from the actual code. Don't guess, and don't ask the founder things memory or the code already answers.
- If the founder asks for a DECISION that isn't decided yet → give a concrete recommendation; once they decide, record it with the remember tool.
- If the founder describes a feature or something to build → respond with the create_ticket JSON (the BA/Dev/QA team will pick it up).
- If the founder gives feedback on existing work → acknowledge and create a ticket to address it.
- If the founder is just chatting → respond naturally.

Current backlog:
${backlogSummary || '(empty)'}

Current app files (${fileList.length}):
${fileList.length ? fileList.join('\n') : '(none yet — nothing built)'}

When creating a ticket, respond with EXACTLY this JSON on its own line:
{"tool":"create_ticket","title":"short title","rawIdea":"full description"}

Otherwise just respond in plain text. Be concise and decisive. You're a PO, not a chatbot.`;

    // Read-only code tools + a memory-write tool for the PO.
    const poTools: { name: string; description: string; input_schema: unknown }[] = (['list_files', 'read_file', 'search_files'] as const).map((name) => ({
      name, description: TOOL_SCHEMAS[name]!.description, input_schema: TOOL_SCHEMAS[name]!.parameters,
    }));
    poTools.push({
      name: 'remember',
      description: 'Record a durable decision or fact about this app (e.g. auth provider, target users, tech choice) so the whole team treats it as ground truth. Upserts by key.',
      input_schema: {
        type: 'object',
        properties: {
          key: { type: 'string', description: 'short stable label, e.g. "auth" or "target_users"' },
          value: { type: 'string', description: 'the decision/fact' },
          category: { type: 'string', description: 'decision | fact | preference | architecture' },
        },
        required: ['key', 'value'],
      },
    });
    const poFiles = this.loadFiles();
    const messages: { role: 'user' | 'assistant'; content: unknown }[] = recentChat.map((m) => ({
      role: m.role === 'user' ? 'user' as const : 'assistant' as const,
      content: m.body,
    }));

    try {
      let text = '';
      // Tool loop: let the PO read/search the code, capped to keep it cheap.
      for (let turn = 0; turn < 6; turn++) {
        const res = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: {
            'x-api-key': apiKey,
            'anthropic-version': '2023-06-01',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            model: 'claude-sonnet-4-6',
            max_tokens: 2048,
            system: systemPrompt,
            tools: poTools,
            messages,
          }),
        });

        if (!res.ok) {
          const safeError = res.status === 401 ? 'API key invalid'
            : res.status === 429 ? 'Rate limited'
            : `AI error (${res.status})`;
          return this.savePOResponse(`Sorry, I couldn't process that: ${safeError}`, now, undefined);
        }

        const aiRes = (await res.json()) as { content?: unknown; stop_reason?: string };
        const contentArr = aiRes.content;
        if (!Array.isArray(contentArr)) {
          return this.savePOResponse('I got an unexpected response format. Try again?', now, undefined);
        }
        messages.push({ role: 'assistant', content: contentArr });
        text = (contentArr as { type: string; text?: string }[]).filter((c) => c.type === 'text').map((c) => c.text ?? '').join('');

        const toolUses = (contentArr as { type: string; id?: string; name?: string; input?: unknown }[]).filter((c) => c.type === 'tool_use');
        if (toolUses.length === 0 || aiRes.stop_reason !== 'tool_use') break;

        // Execute tool calls: remember → memory write; everything else → read-only file tools.
        const toolResults = toolUses.map((tu) => {
          if (tu.name === 'remember') {
            const a = (tu.input ?? {}) as { key?: string; value?: string; category?: string };
            if (a.key && a.value) {
              this.rememberFact(a.category ?? 'decision', a.key, a.value);
              return { type: 'tool_result' as const, tool_use_id: tu.id!, content: `Remembered: ${a.key} = ${a.value}` };
            }
            return { type: 'tool_result' as const, tool_use_id: tu.id!, content: 'remember needs key and value' };
          }
          const r = executeFileTool({ id: tu.id!, name: tu.name!, args: tu.input }, poFiles);
          const out = (r.ok ? (typeof r.data === 'string' ? r.data : JSON.stringify(r.data)) : (r.errorMessage ?? 'error')) || '(no output)';
          this.logActivity('tool', `PO: ${toolActivityDetail(tu.name!, tu.input)}`, null,
            JSON.stringify({ args: tu.input, ok: r.ok, result: out }));
          return { type: 'tool_result' as const, tool_use_id: tu.id!, content: out };
        });
        messages.push({ role: 'user', content: toolResults });
      }

      // Check if PO wants to create a ticket
      const toolMatch = text.match(/\{"tool":"create_ticket".*?\}/);
      if (toolMatch) {
        try {
          const tool = JSON.parse(toolMatch[0]) as { title: string; rawIdea: string };
          // Create the ticket
          const ticketId = uuid();
          const ticketNow = Date.now();
          this.state.storage.sql.exec(
            `INSERT INTO tickets (id, title, raw_idea, status, created_at, updated_at) VALUES (?, ?, ?, 'inbox', ?, ?)`,
            ticketId, tool.title, tool.rawIdea, ticketNow, ticketNow,
          );
          this.broadcast({ type: 'ticket-created', ticket: { id: ticketId, title: tool.title, status: 'inbox', rawIdea: tool.rawIdea, assigneeRole: null, iterations: 0, costSpentUsd: 0, createdAt: ticketNow, updatedAt: ticketNow, stuckReason: null } });
          this.autoAdvance();

          // Clean response (remove JSON, add confirmation)
          const cleanText = text.replace(toolMatch[0], '').trim();
          const poText = cleanText || `Got it. I created a ticket: "${tool.title}". It's in the inbox.`;
          return this.savePOResponse(poText, ticketNow, { name: 'create_ticket', args: tool.title });
        } catch {
          // JSON parse failed, just return the text
        }
      }

      // Regular response
      return this.savePOResponse(text, Date.now(), undefined);

    } catch (err) {
      return this.savePOResponse(
        `I had trouble processing that. Error: ${err instanceof Error ? err.message : 'unknown'}`,
        Date.now(), undefined,
      );
    }
  }

  /** Rule-based PO when no API key is provided */
  private poTriageWithoutAI(userText: string, backlogSummary: string, now: number): Response {
    const lower = userText.toLowerCase();

    // Detect intent
    if (lower.includes('show') && (lower.includes('board') || lower.includes('ticket') || lower.includes('backlog'))) {
      const text = backlogSummary
        ? `Here's the current backlog:\n${backlogSummary}`
        : 'The backlog is empty. Tell me what you want to build!';
      return this.savePOResponse(text, now, undefined);
    }

    if (lower.includes('?') && (lower.includes('how') || lower.includes('what') || lower.includes('can') || lower.includes('why'))) {
      return this.savePOResponse(
        `That's a good question. I'll route it to the Dev agent once one is connected. For now, I've noted it.`,
        now, undefined,
      );
    }

    // Default: create a ticket
    const title = userText.length > 100 ? userText.slice(0, 97) + '...' : userText;
    const ticketId = uuid();
    this.state.storage.sql.exec(
      `INSERT INTO tickets (id, title, raw_idea, status, created_at, updated_at) VALUES (?, ?, ?, 'inbox', ?, ?)`,
      ticketId, title, userText, now, now,
    );
    this.broadcast({ type: 'ticket-created', ticket: { id: ticketId, title, status: 'inbox', rawIdea: userText, assigneeRole: null, iterations: 0, costSpentUsd: 0, createdAt: now, updatedAt: now, stuckReason: null } });
    this.autoAdvance();

    return this.savePOResponse(
      `Got it. I created a ticket: "${title}". It's in the inbox — BA will refine it into a spec when connected.`,
      now,
      { name: 'create_ticket', args: title },
    );
  }

  private savePOResponse(
    text: string,
    now: number,
    toolCall: { name: string; args: string } | undefined,
  ): Response {
    const msgId = uuid();
    this.state.storage.sql.exec(
      'INSERT INTO chat_history (id, role, body, tool_call_json, created_at) VALUES (?, ?, ?, ?, ?)',
      msgId, 'po', text, toolCall ? JSON.stringify(toolCall) : null, now,
    );
    this.broadcast({ type: 'chat', role: 'po', body: text, id: msgId, toolCall });

    return json({
      id: msgId,
      role: 'po',
      body: text,
      toolCall,
      createdAt: now,
    });
  }

  // ── Agent run (explicit trigger) ────────────────────────────
  // Dispatches a single agent turn for a ticket that's in an active state.
  // The run proceeds in the background; clients observe progress over the
  // WebSocket and by polling the ticket. autoAdvance() drives autonomous runs.

  private runAgent(ticketId: string, _request: Request): Response {
    const row = this.state.storage.sql
      .exec('SELECT * FROM tickets WHERE id = ?', ticketId)
      .toArray()[0];
    if (!row) return json({ error: 'ticket_not_found' }, 404);

    const ticket = rowToTicket(row);
    if (isTerminal(ticket.status)) {
      return json({ error: 'ticket_is_terminal', status: ticket.status }, 400);
    }

    const role = assigneeForStatus(ticket.status);
    if (!role) {
      return json({ error: 'no_assignee_for_status', status: ticket.status }, 400);
    }

    if (this.running.has(ticketId)) {
      return json({ status: 'already_running', ticketId, role }, 409);
    }

    const rcRow = this.state.storage.sql
      .exec('SELECT runtime FROM role_configs WHERE role = ?', role)
      .toArray()[0] as { runtime: string } | undefined;

    this.dispatchRun(ticketId);

    return json({ status: 'started', ticketId, role, runtime: rcRow?.runtime ?? null }, 202);
  }

  // ── Cost summary ──────────────────────────────────────────

  private getCostSummary(): Response {
    const proj = this.state.storage.sql
      .exec('SELECT cost_cap_monthly_usd, cost_spent_monthly_usd FROM project LIMIT 1')
      .toArray()[0] as { cost_cap_monthly_usd: number; cost_spent_monthly_usd: number } | undefined;

    const byRole = this.state.storage.sql
      .exec('SELECT role, SUM(cost_usd) as total, SUM(tokens_in) as tokens_in, SUM(tokens_out) as tokens_out FROM cost_ledger GROUP BY role')
      .toArray();

    const byTicket = this.state.storage.sql
      .exec('SELECT ticket_id, SUM(cost_usd) as total FROM cost_ledger GROUP BY ticket_id ORDER BY total DESC LIMIT 10')
      .toArray();

    return json({
      cap: proj?.cost_cap_monthly_usd ?? 0,
      spent: proj?.cost_spent_monthly_usd ?? 0,
      byRole,
      topTickets: byTicket,
    });
  }
}
