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
import { TOOL_SCHEMAS } from './tool-schemas.ts';
import { toolActivityDetail } from './tool-activity.ts';
import { parseAnthropicStream } from './runtimes/cf-native-stream.ts';
import { seedFiles } from './template-seed.ts';
import { RECIPES, getRecipe } from './recipes.ts';
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
import { handleArchitectChat, RESEARCH_THREAD } from './architect-chat.ts';
import { resolveByoKey } from './byo-key.ts';
import { runAgentTurn } from './agent-runner.ts';
import { validateRoleConfig } from './role-config.ts';
import { buildAgentCatalog } from './agents-catalog.ts';
import { loadFiles, saveFiles, recallMemory, upsertMemory } from './project-store.ts';
import { insertActivity, updateActivityMeta, clearActivityLog, readActivity, costSummary, costDetail } from './activity-log.ts';
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
  /** True while a chat-driven Knowledge Base build is in flight (the Architect is
   *  writing in the Research thread). Prevents overlapping "Build KB" runs. */
  private architectChatBusy = false;
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

    // KB share access is PUBLIC — the share ID is the auth token.
    // Must be checked before the ownership gate.
    const shareAccessMatch = path.match(/^\/kb\/share\/([a-zA-Z0-9_-]+)$/);
    if (shareAccessMatch) return this.accessKbViaShare(shareAccessMatch[1]!);
    const shareFileMatch = path.match(/^\/kb\/share\/([a-zA-Z0-9_-]+)\/file$/);
    if (shareFileMatch) return this.accessKbFileViaShare(shareFileMatch[1]!, new URL(request.url).searchParams.get('path') ?? '');

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

    if (path === '/generate-listing' && request.method === 'POST') return this.generateListing(request);
    if (path === '/run-tests' && request.method === 'POST') return this.triggerTestRun();
    if (path === '/test-history' && request.method === 'GET') return this.getTestHistory();
    if (path === '/test-history' && request.method === 'POST') return this.ingestTestResults(request);
    if (path === '/cost' && request.method === 'GET') return this.getCostSummary();
    if (path === '/cost/detail' && request.method === 'GET') return json(costDetail(this.state.storage.sql));
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

    // KB share link management (owner only)
    if (path === '/shares' && request.method === 'GET') return this.listShares();
    if (path === '/shares' && request.method === 'POST') return this.createShare(request);
    const shareDeleteMatch = path.match(/^\/shares\/([a-zA-Z0-9_-]+)$/);
    if (shareDeleteMatch && request.method === 'DELETE') return this.revokeShare(shareDeleteMatch[1]!);

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
    // Spend is stored against cost_month and only reset on the first spend of a
    // new month (storeMessage). Report 0 for a stale month so the UI/budget bar
    // doesn't show last month's total — matching the auto-pause gate in autoAdvance.
    const currentMonth = new Date().toISOString().slice(0, 7);
    const spent = row.cost_month === currentMonth ? (row.cost_spent_monthly_usd as number) : 0;
    return json({
      id: row.id,
      ownerId: row.owner_id,
      name: row.name,
      slug: row.slug,
      createdAt: row.created_at,
      costCapMonthlyUsd: row.cost_cap_monthly_usd,
      costSpentMonthlyUsd: spent,
      maxRunMinutes: (row.max_run_minutes as number) ?? 10,
      repoUrl: row.repo_url,
      status: row.status ?? 'paused',
    });
  }

  private setPlayState(newStatus: 'running' | 'paused', request?: Request): Response {
    const now = Date.now();
    this.state.storage.sql.exec('UPDATE project SET status = ?', newStatus);

    if (newStatus === 'running') {
      // Record when we started running (for idle timeout). The column is created
      // by a migration (store.ts), so no lazy ALTER needed.
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

    // Check if any tickets need user input — don't start new work until user responds
    const needsInput = this.state.storage.sql
      .exec("SELECT COUNT(*) as c FROM tickets WHERE status = 'needs-input'")
      .toArray()[0] as { c: number };
    if (needsInput.c > 0) {
      // Agents are waiting for user — don't advance anything else.
      this.runPendingAgents();
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
      syncFromGitHub: (reason) => this.syncFromGitHub(reason),
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

  // ── KB Share Links ──────────────────────────────────────────
  // Private by default. Owner creates share links with configurable access.

  private listShares(): Response {
    // Share data lives in the DO's SQLite (not D1) so it's co-located with the KB files.

    const rows = this.state.storage.sql
      .exec('SELECT * FROM kb_shares WHERE revoked = 0 ORDER BY created_at DESC')
      .toArray();
    return json({ shares: rows.map((r) => ({
      id: r.id, accessType: r.access_type, allowlist: r.allowlist,
      label: r.label, expiresAt: r.expires_at, createdAt: r.created_at, viewCount: r.view_count,
    })) });
  }

  private async createShare(request: Request): Promise<Response> {
    const body = (await request.json()) as { accessType?: string; allowlist?: string; label?: string; expiresAt?: number };
    const accessType = body.accessType ?? 'open';
    if (!['open', 'google', 'github', 'password'].includes(accessType)) {
      return json({ error: 'accessType must be open, google, github, or password' }, 400);
    }


    const id = crypto.randomUUID().replace(/-/g, '').slice(0, 16); // short URL-safe ID
    const now = Date.now();
    this.state.storage.sql.exec(
      'INSERT INTO kb_shares (id, access_type, allowlist, label, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      id, accessType, body.allowlist ?? null, body.label ?? null, body.expiresAt ?? null, now,
    );

    const proj = this.state.storage.sql.exec('SELECT slug FROM project LIMIT 1').toArray()[0] as { slug: string } | undefined;
    const url = `https://agents.proappstore.online/kb/${proj?.slug ?? 'unknown'}/s/${id}`;

    return json({ id, url, accessType }, 201);
  }

  private revokeShare(shareId: string): Response {
    this.state.storage.sql.exec('UPDATE kb_shares SET revoked = 1 WHERE id = ?', shareId);
    return json({ ok: true });
  }

  /** Public: serve KB content if the share link is valid. */
  private accessKbViaShare(shareId: string): Response {

    const share = this.state.storage.sql
      .exec('SELECT * FROM kb_shares WHERE id = ? AND revoked = 0', shareId)
      .toArray()[0] as { access_type: string; expires_at: number | null } | undefined;

    if (!share) return json({ error: 'Share link not found or revoked' }, 404);
    if (share.expires_at && Date.now() > share.expires_at) return json({ error: 'Share link expired' }, 410);

    // For 'open' type, serve immediately. Other types need additional auth (Phase 2).
    if (share.access_type !== 'open') {
      return json({ error: `This link requires ${share.access_type} authentication (coming soon)` }, 403);
    }

    // Bump view count
    this.state.storage.sql.exec('UPDATE kb_shares SET view_count = view_count + 1 WHERE id = ?', shareId);

    // Return KB file list
    const files = this.state.storage.sql
      .exec("SELECT path, length(content) AS size FROM project_files WHERE path = 'KNOWLEDGE.md' OR path LIKE 'docs/%' ORDER BY path")
      .toArray() as { path: string; size: number }[];

    return json({ files, accessType: share.access_type });
  }

  /** Public: serve a specific KB file if the share link is valid. */
  private accessKbFileViaShare(shareId: string, filePath: string): Response {

    const share = this.state.storage.sql
      .exec('SELECT * FROM kb_shares WHERE id = ? AND revoked = 0', shareId)
      .toArray()[0] as { access_type: string; expires_at: number | null } | undefined;

    if (!share) return json({ error: 'Share link not found or revoked' }, 404);
    if (share.expires_at && Date.now() > share.expires_at) return json({ error: 'Share link expired' }, 410);
    if (share.access_type !== 'open') return json({ error: `Requires ${share.access_type} auth` }, 403);

    // Only serve KB files (KNOWLEDGE.md + docs/*)
    if (filePath !== 'KNOWLEDGE.md' && !filePath.startsWith('docs/')) {
      return json({ error: 'Only KB files (KNOWLEDGE.md + docs/*) are accessible via share links' }, 403);
    }

    const row = this.state.storage.sql
      .exec('SELECT content FROM project_files WHERE path = ?', filePath)
      .toArray()[0] as { content: string } | undefined;

    if (!row) return json({ error: 'file not found' }, 404);
    return json({ path: filePath, content: row.content });
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
        // Check if the topic matches a recipe name first
        if (topic && RECIPES[topic.toLowerCase().replace(/\s+/g, '-')]) {
          return { callId: call.id, ok: true, data: getRecipe(topic), durationMs: 0 };
        }
        if (topic === 'recipes') {
          return { callId: call.id, ok: true, data: getRecipe(), durationMs: 0 };
        }
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
      // First pass → QA writes unit/integration tests. On a re-fix (Dev
      // addressing a failed CI build or test run) tests already exist, so
      // skip QA and go straight to the deploy stage to re-run them.
      const hasTests = [...this.loadFiles().keys()].some((p) => /^tests\/(unit|integration)\/.+\.test\.[tj]sx?$/i.test(p));
      if (hasTests) {
        this.state.storage.sql.exec(
          "UPDATE tickets SET status = 'deploying', assignee_role = NULL, deploy_pushed_at = NULL, deploy_pushed_sha = NULL, updated_at = ? WHERE id = ?",
          now, ticketId,
        );
        this.broadcast({ type: 'transition', ticketId, from: 'dev-active', to: 'deploying', trigger: 'system' });
        this.logActivity('transition', 'Dev finished (tests exist) → deploying', ticketId);
      } else {
        this.state.storage.sql.exec(
          "UPDATE tickets SET status = 'qa-active', assignee_role = 'QA', updated_at = ? WHERE id = ?",
          now, ticketId,
        );
        this.broadcast({ type: 'transition', ticketId, from: 'dev-active', to: 'qa-active', trigger: 'Dev' });
        this.logActivity('transition', 'Dev finished → QA (write unit/integration tests)', ticketId);
      }
    } else if (role === 'QA') {
      // QA's job is to WRITE unit/integration tests (to tests/), not to opine.
      // It can still block on a genuine untestable-without-a-decision case
      // (READY/BLOCKED, same parser as the BA). Otherwise hand to the deploy
      // stage, which pushes + runs CI; a failing test routes back to Dev.
      if (baVerdict(output) === 'blocked') {
        this.blockForInput(ticketId, 'QA', output.slice(0, 8000));
        return;
      }
      this.state.storage.sql.exec(
        "UPDATE tickets SET status = 'deploying', assignee_role = NULL, deploy_pushed_at = NULL, deploy_pushed_sha = NULL, updated_at = ? WHERE id = ?",
        now, ticketId,
      );
      this.broadcast({ type: 'transition', ticketId, from: 'qa-active', to: 'deploying', trigger: 'QA' });
      this.logActivity('transition', 'QA wrote tests → deploying', ticketId);
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
      { role: 'Architect', runtime: 'cf-native', model: 'claude-sonnet-4-6', maxTokens: 16384, spineTools: ['write_file', 'batch_write_files', 'read_file', 'list_files', 'search_files', 'read_docs'], vendorTools: ['web_search', 'web_fetch'] },
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

    // Seed the working tree from the platform template. This gives every new app
    // the correct infrastructure files (.gitignore, LICENSE, package.json with test
    // script, vite.config.ts, tsconfig.json, etc.) so the Dev agent writes INTO a
    // proper scaffold — not from scratch. Matches pas/templates/template-app/.
    const templateFiles = seedFiles(body.slug);
    this.saveFiles(templateFiles);

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
    if (this.architectChatBusy) {
      return json({ ok: false, error: 'The Architect is already writing the Knowledge Base.' }, 409);
    }
    // Self-heal: physically drop any legacy kind=research ticket here too. The
    // store migration only runs on a cold isolate, but a long-lived DO can stay
    // "initialized" across a deploy and skip it — so clean it at this reliable
    // runtime point as well (the board already hides it; this removes the row).
    this.state.storage.sql.exec("DELETE FROM tickets WHERE kind = 'research'");
    const hasKb = [...this.loadFiles().keys()].some(
      (p) => p === 'KNOWLEDGE.md' || /^docs\/.+\.(md|markdown)$/i.test(p),
    );
    const proj = this.state.storage.sql
      .exec('SELECT app_idea FROM project LIMIT 1')
      .toArray()[0] as { app_idea: string | null } | undefined;
    const idea = proj?.app_idea?.trim();
    const message = hasKb
      ? 'Re-research this app and refresh the Knowledge Base (KNOWLEDGE.md + docs/) — update anything stale and keep every SDK fact correct.'
      : `Research this app and write its Knowledge Base — KNOWLEDGE.md plus docs/ — as the team's source of truth.${idea ? ` The app idea: ${idea}` : ''}`;

    // Drive the Architect on the Research thread via the SAME guarded path as the
    // chat (runArchitectChat owns the architectChatBusy lock — it sets the flag
    // synchronously at its top, so this fire-and-forget can't race a chat send).
    // Its progress streams over the WS; we don't await the reply here.
    const chatReq = new Request('https://do/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ thread: RESEARCH_THREAD, message }),
    });
    void this.runArchitectChat(chatReq)
      .catch((e) => {
        try { this.logActivity('error', `KB build crashed: ${e instanceof Error ? e.message : String(e)}`, null); } catch { /* noop */ }
      })
      .finally(() => { this.touchUserActivity(); });
    return json({ ok: true, started: true });
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

  /** Update project settings: monthly cost cap and/or agent run timeout. */
  private async setBudget(request: Request): Promise<Response> {
    const body = (await request.json()) as { costCapMonthlyUsd?: number; maxRunMinutes?: number };
    const cap = body.costCapMonthlyUsd;
    const timeout = body.maxRunMinutes;
    if (cap !== undefined) {
      if (typeof cap !== 'number' || !Number.isFinite(cap) || cap < 1 || cap > 1000) {
        return json({ error: 'costCapMonthlyUsd must be a number between 1 and 1000' }, 400);
      }
      this.state.storage.sql.exec('UPDATE project SET cost_cap_monthly_usd = ? WHERE id = (SELECT id FROM project LIMIT 1)', cap);
      this.logActivity('control', `Monthly budget set to $${cap.toFixed(2)}`);
    }
    if (timeout !== undefined) {
      if (typeof timeout !== 'number' || !Number.isInteger(timeout) || timeout < 1 || timeout > 60) {
        return json({ error: 'maxRunMinutes must be an integer between 1 and 60' }, 400);
      }
      this.state.storage.sql.exec('UPDATE project SET max_run_minutes = ? WHERE id = (SELECT id FROM project LIMIT 1)', timeout);
      this.logActivity('control', `Agent run timeout set to ${timeout} min`);
    }
    return json({ ok: true, ...(cap !== undefined ? { costCapMonthlyUsd: cap } : {}), ...(timeout !== undefined ? { maxRunMinutes: timeout } : {}) });
  }

  private async setRoles(request: Request): Promise<Response> {
    const body = (await request.json()) as { roles: RoleConfig[] };

    // Validate the WHOLE batch first — otherwise an invalid role mid-list would
    // leave the earlier ones already written (partial update on a 400).
    for (const rc of body.roles ?? []) {
      const err = validateRoleConfig(rc);
      if (err) return json({ error: err }, 400);
    }

    for (const rc of body.roles ?? []) {
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
    // Build tickets only — the Knowledge Base is a conversation, not a ticket.
    // Excludes any legacy kind='research' row so it can never surface on the board.
    const rows = this.state.storage.sql
      .exec("SELECT * FROM tickets WHERE kind != 'research' ORDER BY created_at DESC")
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
  /**
   * Run the Architect (Research thread) for one message — the single serialized
   * entry point for ALL KB authoring (the Research-tab chat AND the "Build KB"
   * button). The architectChatBusy lock prevents two concurrent runs from each
   * snapshotting the file tree and clobbering the other's KB writes on save. The
   * check+set is synchronous (no await before it), so it's race-free in the DO's
   * single-threaded model even across the awaits inside handleArchitectChat.
   */
  private async runArchitectChat(request: Request): Promise<Response> {
    if (this.architectChatBusy) {
      return json({ error: 'The Architect is already writing the Knowledge Base — give it a moment.' }, 409);
    }
    this.architectChatBusy = true;
    try {
      return await handleArchitectChat({
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
        // KB publishing disabled — KB stays private in the working tree.
        // The Research tab reads from /files/content (auth-gated), not the public site.
        // Re-enable when there's a per-project "publish KB" toggle.
        publishKb: () => { /* disabled — KB is private */ },
      }, request);
    } finally {
      this.architectChatBusy = false;
    }
  }

  private async handleChat(request: Request): Promise<Response> {
    const peek = await request.clone().json().catch(() => ({})) as { thread?: string };
    if (peek.thread === 'research') {
      return this.runArchitectChat(request);
    }
    if (peek.thread === 'test') {
      return this.handleQAChat(request);
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

  // ── QA Chat (test thread) ──────────────────────────────────
  // AI-powered QA agent — uses the BYO Anthropic key (same as Dev/BA) to
  // generate real Playwright test code from done tickets + KB + app code.

  private async handleQAChat(request: Request): Promise<Response> {
    const body = (await request.json()) as { message: string; thread?: string };
    if (!body.message?.trim()) return json({ error: 'message required' }, 400);
    if (body.message.length > 8192) return json({ error: 'message too long (max 8KB)' }, 413);

    const thread = 'test';
    const userText = body.message.trim();
    const now = Date.now();
    this.touchUserActivity();

    // Save user message
    const userMsgId = insertChatMessage(this.state.storage.sql, { role: 'user', body: userText, at: now, thread });
    this.broadcast({ type: 'chat', thread, role: 'user', body: userText, id: userMsgId });

    // Resolve the BYO API key (same path as Dev/BA/Architect)
    const proj = this.state.storage.sql
      .exec('SELECT owner_id, slug, name FROM project LIMIT 1')
      .toArray()[0] as { owner_id: string; slug: string; name: string } | undefined;

    let apiKey: string | undefined;
    if (proj) apiKey = (await resolveByoKey(this.env, proj.owner_id, 'anthropic')) ?? undefined;

    // Gather context
    const doneTickets = this.state.storage.sql
      .exec("SELECT title, raw_idea, spec_json FROM tickets WHERE status = 'done' ORDER BY updated_at DESC LIMIT 20")
      .toArray() as { title: string; raw_idea: string; spec_json: string | null }[];

    const kbFile = this.state.storage.sql
      .exec("SELECT content FROM project_files WHERE path = 'KNOWLEDGE.md' LIMIT 1")
      .toArray()[0] as { content: string } | undefined;

    const existingSpecs = this.state.storage.sql
      .exec("SELECT path, content FROM project_files WHERE path LIKE 'e2e/specs/%'")
      .toArray() as { path: string; content: string }[];

    const appFiles = this.state.storage.sql
      .exec("SELECT path FROM project_files WHERE path LIKE 'src/%' ORDER BY path")
      .toArray() as { path: string }[];

    // If no API key, fall back to rule-based
    if (!apiKey) {
      const hint = proj ? `(owner ${proj.owner_id})` : '';
      const reply = `I need an Anthropic API key to generate real Playwright tests. Add one in your Profile. ${hint}\n\nIn the meantime, here's a summary: ${doneTickets.length} done tickets, ${existingSpecs.length} e2e spec file(s).`;
      const replyId = insertChatMessage(this.state.storage.sql, { role: 'QA', body: reply, at: Date.now(), thread });
      this.broadcast({ type: 'chat', thread, role: 'QA', body: reply, id: replyId });
      return json({ id: replyId, role: 'QA', body: reply, createdAt: Date.now() });
    }

    // Build context for the LLM
    const ticketSummaries = doneTickets.map(t => {
      let ac = '';
      if (t.spec_json) {
        try {
          const s = JSON.parse(t.spec_json);
          ac = s.summary || (Array.isArray(s.acceptanceCriteria) ? s.acceptanceCriteria.join('; ') : s.acceptanceCriteria) || '';
        } catch { /* */ }
      }
      return `- ${t.title}${ac ? `\n  Spec: ${ac}` : ''}`;
    }).join('\n');

    const existingSpecNames = existingSpecs.map(s => s.path).join(', ') || 'none';
    const appFileList = appFiles.map(f => f.path).join('\n');

    const systemPrompt = `You are a QA engineer for a ProAppStore web app called "${proj?.name ?? 'app'}" (slug: ${proj?.slug ?? 'app'}).
Your job is to generate Playwright end-to-end test specifications and WRITE THEM TO FILES.

The app is deployed at https://${proj?.slug ?? 'app'}.proappstore.online/
Test files go in e2e/specs/*.spec.ts using Playwright Test.
The test fixture at e2e/fixtures.ts provides an \`app\` fixture (a Playwright Page navigated to the app URL).

Done tickets (features to test):
${ticketSummaries || '(none)'}

${kbFile ? `Knowledge Base:\n${kbFile.content.slice(0, 3000)}` : ''}

Existing e2e specs: ${existingSpecNames}
App source files:\n${appFileList}

IMPORTANT: When generating tests, use the write_file or batch_write_files tool to SAVE them to e2e/specs/.
Do NOT just output code in chat — write it to files so it can be run.
When asked about coverage, analyze what's tested vs what's not.
Be concise. Write the files first, then briefly summarize what you wrote.`;

    const recentChat = this.state.storage.sql
      .exec("SELECT role, body FROM chat_history WHERE thread = 'test' ORDER BY created_at DESC LIMIT 10")
      .toArray()
      .reverse()
      .map((r) => ({ role: r.role as string, body: r.body as string }));

    const messages: { role: 'user' | 'assistant'; content: unknown }[] = recentChat.map(m => ({
      role: m.role === 'user' ? 'user' as const : 'assistant' as const,
      content: m.body as unknown,
    }));

    // QA tools: read + write e2e specs, read app source
    const tools = (['write_file', 'batch_write_files', 'read_file', 'list_files', 'search_files'] as const).map((name) => ({
      name, description: TOOL_SCHEMAS[name]!.description, input_schema: TOOL_SCHEMAS[name]!.parameters,
    }));

    const files = this.loadFiles();
    let wrote = false;

    try {
      let reply = '';
      for (let turn = 0; turn < 10; turn++) {
        this.broadcast({ type: 'agent-heartbeat', role: 'QA' });
        const res = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: 'claude-sonnet-4-6', max_tokens: 8192, system: systemPrompt, tools, messages, stream: true }),
        });

        if (!res.ok) {
          let detail = '';
          try { const t = await res.text(); const b = JSON.parse(t) as { error?: { message?: string } }; detail = b?.error?.message ?? t.slice(0, 200); } catch { /* */ }
          const safe = res.status === 401 ? 'API key rejected - check Profile > API Keys'
            : res.status === 429 ? 'Rate limited - wait a moment'
            : `Anthropic error: ${detail || `status ${res.status}`}`;
          const r = `Sorry: ${safe}`;
          const rid = insertChatMessage(this.state.storage.sql, { role: 'QA', body: r, at: Date.now(), thread });
          this.broadcast({ type: 'chat', thread, role: 'QA', body: r, id: rid });
          return json({ id: rid, role: 'QA', body: r, createdAt: Date.now() });
        }
        if (!res.body) break;

        const stream = parseAnthropicStream(res.body);
        let sr = await stream.next();
        while (!sr.done) {
          if (sr.value.type === 'text-delta') this.broadcast({ type: 'agent-text', role: 'QA', text: sr.value.text });
          sr = await stream.next();
        }
        const aiRes = sr.value;
        const contentArr = aiRes.content;
        messages.push({ role: 'assistant', content: contentArr });
        reply = (contentArr as { type: string; text?: string }[]).filter(c => c.type === 'text').map(c => c.text ?? '').join('');

        const toolUses = contentArr.filter(c => c.type === 'tool_use') as { type: 'tool_use'; id: string; name: string; input: unknown }[];
        if (toolUses.length === 0 || aiRes.stop_reason !== 'tool_use') break;

        const toolResults = toolUses.map(tu => {
          const r = executeFileTool({ id: tu.id, name: tu.name, args: tu.input }, files);
          if (r.ok && (tu.name === 'write_file' || tu.name === 'batch_write_files')) wrote = true;
          this.logActivity('tool', `QA: ${toolActivityDetail(tu.name, tu.input)}`, null, JSON.stringify({ args: tu.input, ok: r.ok, result: r.ok ? r.data : r.errorMessage }));
          return { type: 'tool_result' as const, tool_use_id: tu.id, content: (r.ok ? (typeof r.data === 'string' ? r.data : JSON.stringify(r.data)) : (r.errorMessage ?? 'error')) || '(no output)' };
        });
        messages.push({ role: 'user', content: toolResults });
      }

      if (wrote) { this.saveFiles(files); this.broadcast({ type: 'files-synced', count: files.size }); }
      reply = reply || 'Done.';
      const replyId = insertChatMessage(this.state.storage.sql, { role: 'QA', body: reply, at: Date.now(), thread });
      this.broadcast({ type: 'chat', thread, role: 'QA', body: reply, id: replyId });
      return json({ id: replyId, role: 'QA', body: reply, createdAt: Date.now() });
    } catch (err) {
      if (wrote) { this.saveFiles(files); this.broadcast({ type: 'files-synced', count: files.size }); }
      const reply = `Error: ${err instanceof Error ? err.message : String(err)}`;
      const replyId = insertChatMessage(this.state.storage.sql, { role: 'QA', body: reply, at: Date.now(), thread });
      this.broadcast({ type: 'chat', thread, role: 'QA', body: reply, id: replyId });
      return json({ id: replyId, role: 'QA', body: reply, createdAt: Date.now() });
    }
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

  /** AI-powered listing generator: reads the app's source, calls the owner's
   *  BYO Anthropic key to generate a tagline, description, and category. */
  private async generateListing(request: Request): Promise<Response> {
    const body = (await request.json().catch(() => ({}))) as { fields?: string[] };
    const fields = body.fields ?? ['tagline', 'longDescription', 'category'];
    const proj = this.state.storage.sql
      .exec('SELECT owner_id, slug, name FROM project LIMIT 1')
      .toArray()[0] as { owner_id: string; slug: string; name: string } | undefined;
    if (!proj) return json({ error: 'project not found' }, 404);

    const byoKey = await resolveByoKey(this.env, proj.owner_id, 'anthropic');
    if (!byoKey) return json({ error: 'No Anthropic API key configured. Add one in Profile > API Keys.' }, 400);

    // Gather app context from the working tree
    const files = loadFiles(this.state.storage.sql);
    const fileList = [...files.keys()].sort();
    const readme = files.get('README.md') ?? '';
    const kb = files.get('KNOWLEDGE.md') ?? '';
    const appTs = files.get('src/App.tsx') ?? files.get('src/App.jsx') ?? '';
    const pkgJson = files.get('package.json') ?? '';

    const prompt = `You are writing a store listing for a web app called "${proj.name}" (id: ${proj.slug}) on ProAppStore.

App context:
${kb ? `Knowledge Base:\n${kb.slice(0, 3000)}\n` : ''}${readme ? `README:\n${readme.slice(0, 1500)}\n` : ''}${appTs ? `App.tsx (first 100 lines):\n${appTs.split('\n').slice(0, 100).join('\n')}\n` : ''}${pkgJson ? `package.json deps:\n${pkgJson.slice(0, 500)}\n` : ''}
Files: ${fileList.slice(0, 30).join(', ')}

Generate a JSON object with these fields:
- "tagline": 1 sentence, max 60 chars, catchy — what the app does
- "longDescription": 2-3 paragraphs, markdown OK, what the app does + key features + who it's for
- "category": one of: productivity, social, marketplace, transport, finance, health, education, entertainment, tools, other

Respond with ONLY the JSON object, no markdown fences, no explanation.`;

    try {
      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'x-api-key': byoKey, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'claude-haiku-4-5', max_tokens: 1024, messages: [{ role: 'user', content: prompt }] }),
      });
      if (!res.ok) {
        const t = await res.text().catch(() => '');
        return json({ error: `Anthropic ${res.status}: ${t.slice(0, 200)}` }, 502);
      }
      const aiRes = (await res.json()) as { content?: { type: string; text?: string }[] };
      const text = aiRes.content?.find(c => c.type === 'text')?.text ?? '';
      try {
        const listing = JSON.parse(text);
        return json({ listing, tokensUsed: true });
      } catch {
        return json({ listing: { tagline: '', longDescription: text, category: 'other' }, tokensUsed: true });
      }
    } catch (e) {
      return json({ error: `AI generation failed: ${e instanceof Error ? e.message : 'unknown'}` }, 500);
    }
  }

  /** Trigger a Playwright E2E test run via GitHub Actions dispatch. */
  private async triggerTestRun(): Promise<Response> {
    const proj = this.state.storage.sql
      .exec('SELECT slug, owner_id FROM project LIMIT 1')
      .toArray()[0] as { slug: string; owner_id: string } | undefined;
    if (!proj) return json({ error: 'project not found' }, 404);
    if (!this.env.ADMIN || !this.env.INTERNAL_TOKEN) return json({ error: 'admin binding not available' }, 500);

    // Check if e2e specs exist in the working tree
    const specs = [...this.loadFiles().keys()].filter(p => p.startsWith('e2e/specs/') && p.endsWith('.spec.ts'));
    if (specs.length === 0) return json({ error: 'No test specs found in e2e/specs/. Ask the QA agent to generate them first.' }, 400);

    this.logActivity('test', `Test run triggered (${specs.length} spec file(s))`, null);
    this.broadcast({ type: 'test-run-started', specs: specs.length });

    // Trigger the workflow via the GitHub API (dispatch event)
    try {
      const ghToken = this.env.INTERNAL_TOKEN;
      const res = await this.env.ADMIN!.fetch(new Request('https://admin.proappstore.online/api/trigger-test-run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Internal-Token': ghToken },
        body: JSON.stringify({ repo: proj.slug, specs }),
      }));
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        this.logActivity('test', `Test run trigger failed: ${res.status} ${text.slice(0, 200)}`, null);
        return json({ error: `Could not trigger test run: ${text.slice(0, 200) || `admin ${res.status}`}` }, 502);
      }
      const result = await res.json() as { runId?: number; runUrl?: string };
      this.logActivity('test', `Test run started → ${result.runUrl ?? 'GitHub Actions'}`, null);
      return json({ ok: true, specs: specs.length, runUrl: result.runUrl });
    } catch (e) {
      this.logActivity('test', `Test run error: ${e instanceof Error ? e.message : 'unknown'}`, null);
      return json({ error: `Test run failed: ${e instanceof Error ? e.message : 'unknown'}` }, 500);
    }
  }

  /** Get test run history with per-test results. */
  private getTestHistory(): Response {
    const runs = this.state.storage.sql
      .exec('SELECT * FROM test_runs ORDER BY triggered_at DESC LIMIT 50')
      .toArray() as { id: string; triggered_at: number; source: string; commit_sha: string | null; status: string; passed: number; failed: number; skipped: number; flaky: number; duration_ms: number | null; coverage_pct: number | null }[];

    // Per-spec trending: success rate over last 20 runs
    const specStats = this.state.storage.sql
      .exec(`SELECT spec_file, status, COUNT(*) as cnt FROM test_results
             WHERE run_id IN (SELECT id FROM test_runs ORDER BY triggered_at DESC LIMIT 20)
             GROUP BY spec_file, status`)
      .toArray() as { spec_file: string; status: string; cnt: number }[];

    const specTrending: Record<string, { pass: number; fail: number; total: number; pct: number }> = {};
    for (const r of specStats) {
      const s = specTrending[r.spec_file] ?? { pass: 0, fail: 0, total: 0, pct: 0 };
      if (r.status === 'pass') s.pass += r.cnt;
      else if (r.status === 'fail') s.fail += r.cnt;
      s.total += r.cnt;
      s.pct = s.total > 0 ? Math.round((s.pass / s.total) * 100) : 0;
      specTrending[r.spec_file] = s;
    }

    // Overall stats
    const totalRuns = runs.length;
    const passedRuns = runs.filter(r => r.status === 'passed').length;
    const overallPct = totalRuns > 0 ? Math.round((passedRuns / totalRuns) * 100) : 0;

    return json({
      runs: runs.map(r => ({
        id: r.id, triggeredAt: r.triggered_at, source: r.source, commitSha: r.commit_sha,
        status: r.status, passed: r.passed, failed: r.failed, skipped: r.skipped,
        flaky: r.flaky, durationMs: r.duration_ms, coveragePct: r.coverage_pct,
      })),
      specTrending,
      stats: { totalRuns, passedRuns, overallPct },
    });
  }

  /** Ingest test results from CI or manual run. */
  private async ingestTestResults(request: Request): Promise<Response> {
    const body = (await request.json()) as {
      runId?: string; source?: string; commitSha?: string; status?: string;
      passed?: number; failed?: number; skipped?: number; flaky?: number;
      durationMs?: number; coveragePct?: number;
      results?: { specFile: string; testName: string; status: string; durationMs?: number; error?: string }[];
    };
    const sql = this.state.storage.sql;
    const runId = body.runId ?? crypto.randomUUID();
    const now = Date.now();

    sql.exec(
      `INSERT OR REPLACE INTO test_runs (id, triggered_at, source, commit_sha, status, passed, failed, skipped, flaky, duration_ms, coverage_pct)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      runId, now, body.source ?? 'ci', body.commitSha ?? null,
      body.status ?? (body.failed ? 'failed' : 'passed'),
      body.passed ?? 0, body.failed ?? 0, body.skipped ?? 0, body.flaky ?? 0,
      body.durationMs ?? null, body.coveragePct ?? null,
    );

    if (body.results) {
      for (const r of body.results.slice(0, 500)) { // cap at 500 results per run
        if (!r.specFile || !r.testName || !r.status) continue; // skip malformed entries
        sql.exec(
          'INSERT INTO test_results (id, run_id, spec_file, test_name, status, duration_ms, error_text) VALUES (?, ?, ?, ?, ?, ?, ?)',
          crypto.randomUUID(), runId,
          String(r.specFile).slice(0, 500), String(r.testName).slice(0, 500),
          String(r.status).slice(0, 20),
          r.durationMs ?? null, r.error ? String(r.error).slice(0, 5000) : null,
        );
      }
    }

    this.logActivity('test', `Test run ${body.status ?? 'completed'}: ${body.passed ?? 0} passed, ${body.failed ?? 0} failed`, null);
    this.broadcast({ type: 'test-run-completed', runId, status: body.status, passed: body.passed, failed: body.failed });
    return json({ ok: true, runId });
  }
}
