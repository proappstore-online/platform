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
  assigneeForStatus,
  canTransition,
  isTerminal,
  baVerdict,
} from './ticket-machine.ts';
import { executeFileTool, isFileTool } from './spine.ts';
import {
  SCHEMA,
  MIGRATIONS,
  json,
  rowToMessage,
  rowToRoleConfig,
  rowToTicket,
  uuid,
  insertChatMessage,
} from './store.ts';
import { runDeployStage } from './deploy-stage.ts';
import { handlePOChat } from './po-chat.ts';
import { handleArchitectChat } from './architect-chat.ts';
import { runAgentTurn } from './agent-runner.ts';
import { validateRoleConfig } from './role-config.ts';
import { buildAgentCatalog } from './agents-catalog.ts';
import { loadFiles, saveFiles, recallMemory, upsertMemory } from './project-store.ts';
import { insertActivity, updateActivityMeta, clearActivityLog, readActivity, costSummary } from './activity-log.ts';
import { DEFAULT_PERSONAS, type MemoryEntry } from './memory.ts';
import { DOCS_SKILLS_URL, sliceDocs } from './platform-skill.ts';

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
  /** Cached official docs (skills.md), TTL'd, so read_docs doesn't refetch each call. */
  private docsCache: { text: string; at: number } | null = null;

  constructor(state: DurableObjectState, env: Bindings) {
    this.state = state;
    this.env = env;
  }

  private async ensureSchema(): Promise<void> {
    if (this.initialized) return;
    this.state.storage.sql.exec(SCHEMA);
    // Additive column migrations for older DOs (see store.ts MIGRATIONS). Each
    // group is best-effort: if the column already exists the ALTER throws and the
    // group is skipped.
    for (const stmts of MIGRATIONS) {
      try { for (const s of stmts) this.state.storage.sql.exec(s); } catch { /* already applied */ }
    }
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
    const { id, createdAt, meta: metaStr } = insertActivity(this.state.storage.sql, { type, detail, ticketId, ...(meta !== undefined ? { meta } : {}) });
    this.broadcast({ type: 'activity', entry: { id, ticketId, type, detail, createdAt, meta: metaStr ?? undefined } });
    return id;
  }

  /** Attach the output of a tool call to its already-logged activity row (audit). */
  private setActivityMeta(id: string, meta: string): void {
    const metaStr = updateActivityMeta(this.state.storage.sql, id, meta);
    this.broadcast({ type: 'activity-meta', id, meta: metaStr });
  }

  // Wipe the persisted activity trail (start fresh). Audit-only data; safe to clear.
  private clearActivity(): Response {
    clearActivityLog(this.state.storage.sql);
    this.broadcast({ type: 'activity-cleared' });
    return json({ ok: true });
  }

  private getActivity(): Response {
    return json({ activity: readActivity(this.state.storage.sql) });
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
    if (path === '/project/research' && request.method === 'POST') return this.buildKnowledgeBase();

    if (path === '/roles' && request.method === 'GET') return this.getRoles();
    if (path === '/roles' && request.method === 'PUT') return this.setRoles(request);
    if (path === '/agents' && request.method === 'GET') return this.getAgents();
    if (path === '/budget' && request.method === 'PUT') return this.setBudget(request);

    if (path === '/chat' && request.method === 'POST') return this.handleChat(request);
    if (path === '/chat/history' && request.method === 'GET') return this.getChatHistory(request);
    if (path === '/chat/history' && request.method === 'DELETE') return this.clearChat(request);

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
        // null assignee means a deploy-infra block (deploy-stage.infraFail) →
        // retry the deploy directly, not Dev/BA.
        const resume = t.assignee_role === 'QA' ? 'qa-active'
          : t.assignee_role === 'Dev' ? 'dev-active'
          : t.assignee_role === 'BA' ? 'ba-refining'
          : 'deploying';
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
        const msgId = insertChatMessage(this.state.storage.sql, { role: 'po', body: msg, at: now });
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
      const idleId = insertChatMessage(this.state.storage.sql, { role: 'system', body: idleMsg, at: now });
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

    // Research lane (non-blocking): route any inbox research ticket to the
    // Architect immediately — independent of the build concurrency cap and the
    // needs-input halt, so the KB is built alongside (not gated by) the build loop.
    const researchInbox = this.state.storage.sql
      .exec("SELECT id FROM tickets WHERE status = 'inbox' AND kind = 'research'")
      .toArray() as { id: string }[];
    for (const t of researchInbox) {
      this.state.storage.sql.exec(
        "UPDATE tickets SET status = 'architect-active', assignee_role = 'Architect', updated_at = ? WHERE id = ?",
        now, t.id,
      );
      this.broadcast({ type: 'transition', ticketId: t.id, from: 'inbox', to: 'architect-active', auto: true });
    }

    // Check if any tickets need user input — don't start new work until user responds
    const needsInput = this.state.storage.sql
      .exec("SELECT COUNT(*) as c FROM tickets WHERE status = 'needs-input'")
      .toArray()[0] as { c: number };
    if (needsInput.c > 0) {
      // Agents are waiting for user — don't advance anything else (the research
      // lane above already ran, so the KB still progresses).
      this.runPendingAgents();
      return;
    }

    const tickets = this.state.storage.sql
      .exec("SELECT id, status, iterations FROM tickets WHERE status NOT IN ('done','failed','cancelled','needs-input','architect-active','ba-refining','dev-active','qa-active') ORDER BY created_at")
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
      .exec("SELECT id FROM tickets WHERE status IN ('architect-active','ba-refining','dev-active','qa-active') ORDER BY updated_at")
      .toArray() as { id: string }[];

    for (const t of active) {
      if (this.running.has(t.id)) continue;
      this.dispatchRun(t.id);
    }

    // Deterministic deploy stage (no LLM): push + verify the CI build, then route
    // done | back-to-dev. "done" is only reachable through a verified green build.
    const deploying = this.state.storage.sql
      .exec("SELECT id FROM tickets WHERE status = 'deploying' ORDER BY updated_at")
      .toArray() as { id: string }[];
    for (const t of deploying) {
      if (this.running.has(t.id)) continue;
      this.dispatchDeploy(t.id);
    }
  }

  /** One agent turn — see agent-runner.ts. The DO supplies storage + callbacks. */
  private runAgentInternal(ticketId: string): Promise<void> {
    return runAgentTurn({
      sql: this.state.storage.sql,
      env: this.env,
      broadcast: (e) => this.broadcast(e),
      logActivity: (type, detail, tid, meta) => this.logActivity(type, detail, tid, meta),
      setActivityMeta: (id, meta) => this.setActivityMeta(id, meta),
      syncFromGitHub: (reason) => this.syncFromGitHub(reason),
      loadFiles: () => this.loadFiles(),
      saveFiles: (files) => this.saveFiles(files),
      recallMemory: () => this.recallMemory(),
      storeMessage: (opts) => this.storeMessage(opts),
      makeDispatch: (files) => this.makeDispatch(files),
      failTicket: (tid, from, reason) => this.failTicket(tid, from, reason),
      blockForInput: (tid, role, message) => this.blockForInput(tid, role, message),
      applyAgentOutcome: (tid, role, output) => this.applyAgentOutcome(tid, role, output),
    }, ticketId);
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

  /** Fire-and-forget the deterministic deploy stage for a `deploying` ticket. */
  private dispatchDeploy(ticketId: string): void {
    this.running.add(ticketId);
    void this.runDeploy(ticketId)
      .catch((e) => {
        const msg = e instanceof Error ? e.message : String(e);
        try { this.logActivity('error', `Deploy crashed: ${msg}`, ticketId); } catch { /* noop */ }
      })
      .finally(() => {
        this.running.delete(ticketId);
        this.touchUserActivity();
        try { this.autoAdvance(); } catch { /* watchdog backstop */ }
      });
  }

  /** Deploy stage (no LLM) — see deploy-stage.ts. The DO just supplies storage +
   *  the few callbacks; runDeployStage does push + CI-verify + routing. */
  private runDeploy(ticketId: string): Promise<void> {
    return runDeployStage({
      sql: this.state.storage.sql,
      env: this.env,
      broadcast: (e) => this.broadcast(e),
      logActivity: (type, detail, tid, meta) => this.logActivity(type, detail, tid, meta),
      storeMessage: (opts) => this.storeMessage(opts),
      loadFiles: () => this.loadFiles(),
    }, ticketId);
  }

  // ── Project working tree (file map) ──────────────────────────
  // The Dev/QA file tools edit this map (in spine.ts). It persists between runs
  // so Dev's output survives into the QA run and back into a qa-failed re-run.

  /** Fetch the official platform docs (skills.md) — the same reference users see.
   *  Cached for an hour; UA header avoids the docs WAF 403. */
  private async fetchDocs(): Promise<string> {
    const now = Date.now();
    if (this.docsCache && now - this.docsCache.at < 3_600_000) return this.docsCache.text;
    try {
      const res = await fetch(DOCS_SKILLS_URL, { headers: { 'User-Agent': 'proappstore-agent-teams/1.0' } });
      if (!res.ok) return this.docsCache?.text ?? '';
      const text = await res.text();
      this.docsCache = { text, at: now };
      return text;
    } catch {
      return this.docsCache?.text ?? '';
    }
  }

  // ── Project memory (durable decisions/facts the team reads each run) ───────

  private recallMemory(): MemoryEntry[] {
    return recallMemory(this.state.storage.sql);
  }

  /** Upsert a memory by key (so a decision can be revised, not duplicated), then
   *  log + broadcast the change. Persistence lives in project-store. */
  private rememberFact(category: string, key: string, value: string): void {
    const k = upsertMemory(this.state.storage.sql, category, key, value);
    if (!k) return;
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
    return loadFiles(this.state.storage.sql);
  }

  private saveFiles(files: Map<string, string>): void {
    saveFiles(this.state.storage.sql, files);
  }

  /**
   * Publish the Knowledge Base as a shareable Zensical site at
   * kb.proappstore.online/<slug>/ — INDEPENDENT of an app build. Pushes just the
   * KB markdown (+ kb.yml) to the repo via admin, which builds + uploads to R2.
   * Best-effort + non-blocking, so a brainstorm-first KB is shareable the moment
   * the Architect finishes writing it (no need to build the app first).
   */
  private async publishKb(): Promise<void> {
    const env = this.env;
    if (!env.ADMIN || !env.INTERNAL_TOKEN) return; // no admin binding (dev)
    const proj = this.state.storage.sql
      .exec('SELECT slug, name FROM project LIMIT 1')
      .toArray()[0] as { slug: string; name: string } | undefined;
    if (!proj) return;
    const kb: Record<string, string> = {};
    for (const [p, c] of this.loadFiles()) {
      if (p === 'KNOWLEDGE.md' || /^docs\/.+\.(md|markdown)$/i.test(p)) kb[p] = c;
    }
    if (Object.keys(kb).length === 0) return; // nothing written yet
    try {
      const res = await env.ADMIN.fetch(new Request('https://admin.proappstore.online/api/publish-kb', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Internal-Token': env.INTERNAL_TOKEN },
        body: JSON.stringify({ id: proj.slug, name: proj.name, files: kb }),
      }));
      if (res.ok) this.logActivity('control', `Knowledge Base published → kb.proappstore.online/${proj.slug}/`, null);
      else this.logActivity('control', `KB publish skipped (admin ${res.status}) — retries on next KB change`, null);
    } catch (e) {
      this.logActivity('control', `KB publish error (non-fatal): ${e instanceof Error ? e.message : 'unknown'}`, null);
    }
  }

  /** Build the tool executor injected into a runtime for one run. Agents get
   *  file tools + read_docs only; deployment is a system stage (runDeploy), not
   *  an agent tool, so anything else is rejected. */
  private makeDispatch(files: Map<string, string>): (call: ToolCall) => Promise<ToolResult> {
    return async (call) => {
      if (call.name === 'read_docs') {
        const topic = (call.args as { topic?: string } | undefined)?.topic;
        const out = sliceDocs(await this.fetchDocs(), topic) || 'docs unavailable';
        return { callId: call.id, ok: true, data: out, durationMs: 0 };
      }
      if (isFileTool(call.name)) return executeFileTool(call, files);
      return { callId: call.id, ok: false, errorMessage: `Tool not available to agents: ${call.name}. Deployment is automatic after QA.`, durationMs: 0 };
    };
  }

  /** Transition a ticket forward after a successful agent run. */
  private applyAgentOutcome(ticketId: string, role: Role, output: string): void {
    const now = Date.now();
    if (role === 'Architect') {
      // Research ticket: the KB was written to the working tree (KNOWLEDGE.md +
      // docs/). Mark done — no deploy stage (docs aren't a build; they ride along
      // on the next app deploy). It rode its own lane the whole way.
      this.state.storage.sql.exec(
        "UPDATE tickets SET status = 'done', assignee_role = NULL, updated_at = ? WHERE id = ?",
        now, ticketId,
      );
      this.broadcast({ type: 'transition', ticketId, from: 'architect-active', to: 'done', trigger: 'Architect' });
      this.logActivity('transition', 'Architect finished the Knowledge Base → done', ticketId);
      void this.publishKb(); // publish the shareable KB site (non-blocking)
      return;
    }
    if (role === 'BA') {
      // BA can block on the founder when a buildable spec needs a product/scope
      // decision — park in needs-input with the questions instead of loosing Dev
      // on an unspecced ticket (which just burns Dev/QA/deploy iterations).
      if (baVerdict(output) === 'blocked') {
        this.blockForInput(ticketId, 'BA', output.slice(0, 8000));
        return;
      }
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
      // First pass → QA authors the E2E specs. On a re-fix (Dev addressing a
      // failed CI build or E2E run) the specs already exist, so skip QA and go
      // straight to the deploy stage to re-run them against the fixed code.
      const hasSpecs = [...this.loadFiles().keys()].some((p) => /^e2e\/specs\/.+\.spec\.[tj]sx?$/i.test(p));
      if (hasSpecs) {
        this.state.storage.sql.exec(
          "UPDATE tickets SET status = 'deploying', assignee_role = NULL, deploy_pushed_at = NULL, deploy_pushed_sha = NULL, updated_at = ? WHERE id = ?",
          now, ticketId,
        );
        this.broadcast({ type: 'transition', ticketId, from: 'dev-active', to: 'deploying', trigger: 'system' });
        this.logActivity('transition', 'Dev finished (E2E specs exist) → deploying', ticketId);
      } else {
        this.state.storage.sql.exec(
          "UPDATE tickets SET status = 'qa-active', assignee_role = 'QA', updated_at = ? WHERE id = ?",
          now, ticketId,
        );
        this.broadcast({ type: 'transition', ticketId, from: 'dev-active', to: 'qa-active', trigger: 'Dev' });
        this.logActivity('transition', 'Dev finished → QA (write E2E specs)', ticketId);
      }
    } else if (role === 'QA') {
      // QA's job is to AUTHOR E2E specs (to e2e/specs/), not to opine. It can
      // still block on a genuine untestable-without-a-decision case (READY/BLOCKED,
      // same parser as the BA). Otherwise hand to the deploy stage, which pushes +
      // runs the specs against the live app; a failing spec routes back to Dev.
      if (baVerdict(output) === 'blocked') {
        this.blockForInput(ticketId, 'QA', output.slice(0, 8000));
        return;
      }
      this.state.storage.sql.exec(
        "UPDATE tickets SET status = 'deploying', assignee_role = NULL, deploy_pushed_at = NULL, deploy_pushed_sha = NULL, updated_at = ? WHERE id = ?",
        now, ticketId,
      );
      this.broadcast({ type: 'transition', ticketId, from: 'qa-active', to: 'deploying', trigger: 'QA' });
      this.logActivity('transition', 'QA wrote E2E specs → deploying', ticketId);
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
    const blockId = insertChatMessage(this.state.storage.sql, { role: 'system', body: message, at: now });
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
      `INSERT INTO project (id, owner_id, name, slug, created_at, cost_cap_monthly_usd, app_idea)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      id, body.ownerId, body.name, body.slug, now, body.costCapMonthlyUsd ?? 50.0, body.idea?.trim() ?? null,
    );

    // Set default role configs
    const defaults: RoleConfig[] = [
      { role: 'Architect', runtime: 'cf-native', model: 'claude-sonnet-4-6', maxTokens: 16384, spineTools: ['write_file', 'batch_write_files', 'read_file', 'list_files', 'search_files', 'read_docs'], vendorTools: [] },
      { role: 'BA', runtime: 'cf-native', model: 'claude-sonnet-4-6', maxTokens: 8192, spineTools: ['read_file', 'list_files', 'search_files', 'read_docs'], vendorTools: [] },
      { role: 'Dev', runtime: 'cf-native', model: 'claude-sonnet-4-6', maxTokens: 16384, spineTools: ['write_file', 'read_file', 'list_files', 'batch_write_files', 'search_files', 'read_docs'], vendorTools: [] },
      { role: 'QA', runtime: 'cf-native', model: 'claude-sonnet-4-6', maxTokens: 16384, spineTools: ['write_file', 'read_file', 'list_files', 'search_files', 'read_docs'], vendorTools: [] },
    ];

    for (const rc of defaults) {
      this.state.storage.sql.exec(
        `INSERT OR REPLACE INTO role_configs (role, runtime, model, spine_tools, vendor_tools, max_tokens, persona)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        rc.role, rc.runtime, rc.model, JSON.stringify(rc.spineTools), JSON.stringify(rc.vendorTools), rc.maxTokens ?? null,
        DEFAULT_PERSONAS[rc.role] ?? null,
      );
    }

    // Brainstorm-first: do NOT auto-seed any tickets. The founder brainstorms with
    // the PO, presses "Build Knowledge Base" when ready (Architect runs once), and
    // building only starts when the founder asks the PO to build something. The
    // idea is persisted on the project (above) so the PO + Architect have it.

    this.broadcast({ type: 'project-created', projectId: id });
    return json({ id, slug: body.slug, seededTicket: false });
  }

  /**
   * Founder-triggered, one-time KB build (brainstorm-first flow): seed a research
   * ticket so the Architect writes KNOWLEDGE.md + docs/ from the (brainstormed)
   * idea + project memory. Idempotent — refuses if a research ticket already
   * exists (KB is built once; later changes go through memory/tickets).
   */
  private buildKnowledgeBase(): Response {
    const now = Date.now();
    const existing = this.state.storage.sql
      .exec("SELECT id, status FROM tickets WHERE kind = 'research' LIMIT 1")
      .toArray()[0] as { id: string; status: string } | undefined;
    if (existing) {
      // Already written, or a run is genuinely in flight → nothing to do.
      if (existing.status === 'done' || this.running.has(existing.id)) {
        return json({ ok: false, error: 'Knowledge Base already built (or in progress).' }, 409);
      }
      // Otherwise it's STUCK — created but never dispatched (e.g. seeded while the
      // project was paused by older code), or its run died. Recover it: (re)route
      // to the Architect and dispatch now, regardless of play-state. This is why
      // "Build KB" was a no-op on projects with an old stuck research ticket.
      this.state.storage.sql.exec(
        "UPDATE tickets SET status = 'architect-active', assignee_role = 'Architect', updated_at = ? WHERE id = ?",
        now, existing.id,
      );
      this.broadcast({ type: 'transition', ticketId: existing.id, from: existing.status, to: 'architect-active', auto: true });
      this.logActivity('control', 'Re-dispatched the Knowledge Base build (was stuck)', null);
      this.dispatchRun(existing.id);
      return json({ ok: true, ticketId: existing.id, redispatched: true });
    }

    const proj = this.state.storage.sql
      .exec('SELECT app_idea FROM project LIMIT 1')
      .toArray()[0] as { app_idea: string | null } | undefined;
    const idea = proj?.app_idea?.trim() || 'See the project memory + chat for what this app is.';
    const id = uuid();
    // Seed the research ticket STRAIGHT into architect-active and dispatch it now.
    // The research lane is founder-triggered and runs independent of the build
    // loop, so "Build KB" must start the Architect even when the project is paused
    // (e.g. idle auto-pause) — autoAdvance/runPendingAgents both bail when the
    // project isn't 'running', which previously left the ticket stuck in inbox
    // with nothing happening. dispatchRun is not play-gated; its post-run
    // autoAdvance is, so the (paused) build loop stays paused.
    this.state.storage.sql.exec(
      `INSERT INTO tickets (id, seq, title, raw_idea, status, kind, assignee_role, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'architect-active', 'research', 'Architect', ?, ?)`,
      id, this.nextSeq(),
      'Research & write the project Knowledge Base',
      `Research this app and write KNOWLEDGE.md + docs/ as the team's source of truth (read project memory for any decisions made while brainstorming). App idea:\n${idea}`,
      now, now,
    );
    this.broadcast({ type: 'ticket-created', ticket: { id, seq: 0, title: 'Research & write the project Knowledge Base', status: 'architect-active', rawIdea: idea, assigneeRole: 'Architect', iterations: 0, costSpentUsd: 0, createdAt: now, updatedAt: now, stuckReason: null, kind: 'research' } });
    this.broadcast({ type: 'transition', ticketId: id, from: 'inbox', to: 'architect-active', auto: true });
    this.dispatchRun(id);
    return json({ ok: true, ticketId: id });
  }

  // ── Role configs ──────────────────────────────────────────

  private getRoles(): Response {
    const rows = this.state.storage.sql
      .exec('SELECT * FROM role_configs ORDER BY role')
      .toArray();
    const configs = rows.map(rowToRoleConfig);
    return json({ roles: configs });
  }

  /**
   * The resolved catalog of EVERY agent on this project — identity, base system
   * prompt, granted skills/tools, model/runtime — with defaults applied. Powers
   * "see all prompts / skills / identities" in the console and over MCP. Pure
   * resolution lives in agents-catalog.ts; this just feeds it the stored configs.
   */
  private getAgents(): Response {
    const rows = this.state.storage.sql
      .exec('SELECT * FROM role_configs ORDER BY role')
      .toArray();
    const configs = rows.map(rowToRoleConfig);
    const po = this.state.storage.sql
      .exec("SELECT persona FROM role_configs WHERE role = 'PO'")
      .toArray()[0] as { persona: string | null } | undefined;
    const agents = buildAgentCatalog(configs.filter((c) => c.role !== ('PO' as Role)), { poPersona: po?.persona ?? null });
    return json({ agents });
  }

  /** Update the project's monthly cost cap (the budget that auto-pauses the loop). */
  private async setBudget(request: Request): Promise<Response> {
    const body = (await request.json()) as { costCapMonthlyUsd?: number };
    const cap = body.costCapMonthlyUsd;
    if (typeof cap !== 'number' || !Number.isFinite(cap) || cap < 1 || cap > 1000) {
      return json({ error: 'costCapMonthlyUsd must be a number between 1 and 1000' }, 400);
    }
    this.state.storage.sql.exec('UPDATE project SET cost_cap_monthly_usd = ? WHERE id = (SELECT id FROM project LIMIT 1)', cap);
    this.logActivity('control', `Monthly budget set to $${cap.toFixed(2)}`);
    return json({ ok: true, costCapMonthlyUsd: cap });
  }

  private async setRoles(request: Request): Promise<Response> {
    const body = (await request.json()) as { roles: RoleConfig[] };

    for (const rc of body.roles) {
      const err = validateRoleConfig(rc);
      if (err) return json({ error: err }, 400);

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

  /** Next short per-project ticket number (#N). DO is single-threaded, so MAX+1 is race-free. */
  private nextSeq(): number {
    const row = this.state.storage.sql
      .exec('SELECT COALESCE(MAX(seq), 0) + 1 AS n FROM tickets')
      .toArray()[0] as { n: number } | undefined;
    return row?.n ?? 1;
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
    const seq = this.nextSeq();

    this.state.storage.sql.exec(
      `INSERT INTO tickets (id, seq, title, raw_idea, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'inbox', ?, ?)`,
      id, seq, body.title, body.rawIdea, now, now,
    );

    const ticket: Ticket = {
      id,
      seq,
      projectId: '',
      title: body.title,
      rawIdea: body.rawIdea,
      spec: null,
      status: 'inbox',
      kind: 'build',
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
  private clearChat(request: Request): Response {
    const thread = new URL(request.url).searchParams.get('thread') ?? 'build';
    this.state.storage.sql.exec('DELETE FROM chat_history WHERE thread = ?', thread);
    this.chatWindow = [];
    this.broadcast({ type: 'chat-cleared', thread });
    return json({ ok: true });
  }

  private getChatHistory(request: Request): Response {
    const thread = new URL(request.url).searchParams.get('thread') ?? 'build';
    const rows = this.state.storage.sql
      .exec('SELECT * FROM chat_history WHERE thread = ? ORDER BY created_at ASC', thread)
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

  /** Founder chat. Two separate threads/agents: 'research' → the Architect (KB),
   *  anything else → the PO (build). Peek the thread off a clone so the chosen
   *  handler can still read the body. */
  private async handleChat(request: Request): Promise<Response> {
    const peek = await request.clone().json().catch(() => ({})) as { thread?: string };
    if (peek.thread === 'research') {
      return handleArchitectChat({
        sql: this.state.storage.sql,
        env: this.env,
        getChatWindow: () => this.chatWindow,
        setChatWindow: (w) => { this.chatWindow = w; },
        touchUserActivity: () => this.touchUserActivity(),
        syncFromGitHub: (reason) => this.syncFromGitHub(reason),
        broadcast: (e) => this.broadcast(e),
        loadFiles: () => this.loadFiles(),
        saveFiles: (files) => this.saveFiles(files),
        recallMemory: () => this.recallMemory(),
        rememberFact: (c, k, v) => this.rememberFact(c, k, v),
        fetchDocs: () => this.fetchDocs(),
        logActivity: (type, detail, tid, meta) => this.logActivity(type, detail, tid, meta),
        publishKb: () => { void this.publishKb(); },
      }, request);
    }
    return handlePOChat({
      sql: this.state.storage.sql,
      env: this.env,
      getChatWindow: () => this.chatWindow,
      setChatWindow: (w) => { this.chatWindow = w; },
      touchUserActivity: () => this.touchUserActivity(),
      syncFromGitHub: (reason) => this.syncFromGitHub(reason),
      broadcast: (e) => this.broadcast(e),
      autoAdvance: () => this.autoAdvance(),
      loadFiles: () => this.loadFiles(),
      recallMemory: () => this.recallMemory(),
      rememberFact: (c, k, v) => this.rememberFact(c, k, v),
      fetchDocs: () => this.fetchDocs(),
      logActivity: (type, detail, tid, meta) => this.logActivity(type, detail, tid, meta),
      nextSeq: () => this.nextSeq(),
    }, request);
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
    return json(costSummary(this.state.storage.sql));
  }
}
