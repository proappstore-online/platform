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

const SCHEMA = `
CREATE TABLE IF NOT EXISTS project (
  id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, name TEXT NOT NULL, slug TEXT NOT NULL,
  created_at INTEGER NOT NULL, cost_cap_monthly_usd REAL NOT NULL DEFAULT 50.0,
  cost_spent_monthly_usd REAL NOT NULL DEFAULT 0.0, repo_url TEXT,
  repo_provisioned_at INTEGER, registry_entry_id TEXT
);
CREATE TABLE IF NOT EXISTS role_configs (
  role TEXT PRIMARY KEY, runtime TEXT NOT NULL, model TEXT NOT NULL,
  system_prompt_override TEXT, spine_tools TEXT NOT NULL DEFAULT '[]',
  vendor_tools TEXT NOT NULL DEFAULT '[]'
);
CREATE TABLE IF NOT EXISTS tickets (
  id TEXT PRIMARY KEY, title TEXT NOT NULL, raw_idea TEXT NOT NULL, spec_json TEXT,
  status TEXT NOT NULL DEFAULT 'inbox', assignee_role TEXT, iterations INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, cost_spent_usd REAL NOT NULL DEFAULT 0.0,
  pr_url TEXT, final_commit_sha TEXT, stuck_reason TEXT
);
CREATE INDEX IF NOT EXISTS idx_tickets_status ON tickets(status);
CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY, ticket_id TEXT NOT NULL REFERENCES tickets(id),
  author TEXT NOT NULL, body TEXT NOT NULL, tool_calls_json TEXT,
  created_at INTEGER NOT NULL, cost_usd REAL NOT NULL DEFAULT 0.0,
  tokens_in INTEGER NOT NULL DEFAULT 0, tokens_out INTEGER NOT NULL DEFAULT 0,
  body_offload_key TEXT
);
CREATE INDEX IF NOT EXISTS idx_messages_ticket ON messages(ticket_id, created_at);
CREATE TABLE IF NOT EXISTS cost_ledger (
  id INTEGER PRIMARY KEY AUTOINCREMENT, ticket_id TEXT NOT NULL, role TEXT NOT NULL,
  cost_usd REAL NOT NULL, tokens_in INTEGER NOT NULL, tokens_out INTEGER NOT NULL,
  model TEXT NOT NULL, created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_cost_ticket ON cost_ledger(ticket_id);
CREATE TABLE IF NOT EXISTS chat_history (
  id TEXT PRIMARY KEY, role TEXT NOT NULL, body TEXT NOT NULL,
  tool_call_json TEXT, created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_chat_history ON chat_history(created_at);
CREATE TABLE IF NOT EXISTS project_files (
  path TEXT PRIMARY KEY, content TEXT NOT NULL, updated_at INTEGER NOT NULL
);
`;

function uuid(): string {
  return crypto.randomUUID();
}

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

    if (path === '/tickets' && request.method === 'GET') return this.listTickets();
    if (path === '/tickets' && request.method === 'POST') return this.createTicket(request);

    const ticketMatch = path.match(/^\/tickets\/([a-f0-9-]+)$/);
    if (ticketMatch) {
      const ticketId = ticketMatch[1]!;
      if (request.method === 'GET') return this.getTicket(ticketId);
      if (request.method === 'PATCH') return this.updateTicket(ticketId, request);
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
    }

    this.broadcast({ type: 'play-state', status: newStatus });

    if (newStatus === 'running') {
      this.scheduleWatchdog();
      this.autoAdvance();
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
      .exec("SELECT status, last_user_activity, cost_cap_monthly_usd, cost_spent_monthly_usd FROM project LIMIT 1")
      .toArray()[0] as { status: string; last_user_activity: number; cost_cap_monthly_usd: number; cost_spent_monthly_usd: number } | undefined;
    if (!proj || proj.status !== 'running') return;

    const now = Date.now();

    // Idle timeout: auto-pause after 30 min of no user chat
    const lastActivity = (proj.last_user_activity as number | null) ?? 0;
    const idleMs = lastActivity > 0 ? now - lastActivity : 0;
    if (lastActivity > 0 && idleMs > 30 * 60 * 1000) {
      this.state.storage.sql.exec("UPDATE project SET status = 'paused'");
      this.clearWatchdog();
      this.broadcast({ type: 'play-state', status: 'paused', reason: 'idle-timeout' });
      this.broadcast({ type: 'chat', role: 'system', body: 'Auto-paused: no activity for 30 minutes. Hit Play to resume.', id: uuid() });
      // Save to chat history
      this.state.storage.sql.exec(
        'INSERT INTO chat_history (id, role, body, created_at) VALUES (?, ?, ?, ?)',
        uuid(), 'system', 'Auto-paused: no activity for 30 minutes. Hit Play to resume.', now,
      );
      return;
    }

    // Cost cap check
    if (proj.cost_spent_monthly_usd >= proj.cost_cap_monthly_usd) {
      this.state.storage.sql.exec("UPDATE project SET status = 'paused'");
      this.clearWatchdog();
      this.broadcast({ type: 'play-state', status: 'paused', reason: 'cost-cap' });
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

    const runtime: AgentRuntime = roleConfig.runtime === 'openai-responses'
      ? new OpenAIResponsesRuntime()
      : new CFNativeRuntime();

    const messages = this.buildSeedMessages(role, ticket, proj.slug);
    const files = this.loadFiles();

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
      // and route the ticket to needs-input.
      const consume = (async () => {
        for await (const ev of runtime.run(handle, messages)) {
          switch (ev.type) {
            case 'text-delta':
              assistantText += ev.text;
              this.broadcast({ type: 'agent-text', ticketId, role, text: ev.text });
              break;
            case 'tool-call':
              toolCalls.push(ev.call);
              this.broadcast({ type: 'agent-tool-call', ticketId, role, name: ev.call.name });
              break;
            case 'tool-result':
              this.broadcast({ type: 'agent-tool-result', ticketId, role, ok: ev.result.ok });
              break;
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
    const p = this.runAgentInternal(ticketId)
      .catch(() => { /* swallow — outcome already persisted as needs-input */ })
      .finally(() => {
        this.running.delete(ticketId);
        try { this.autoAdvance(); } catch { /* keep the watchdog as backstop */ }
      });
    try {
      (this.state as unknown as { waitUntil?: (pr: Promise<unknown>) => void }).waitUntil?.(p);
    } catch { /* waitUntil unavailable — promise still runs */ }
  }

  // ── Project working tree (file map) ──────────────────────────
  // The Dev/QA file tools edit this map (in spine.ts). It persists between runs
  // so Dev's output survives into the QA run and back into a qa-failed re-run.

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

  /** Build the single seeded user message that frames one agent's turn. */
  private buildSeedMessages(role: Role, ticket: Ticket, slug: string): Message[] {
    const prior = this.state.storage.sql
      .exec('SELECT author, body FROM messages WHERE ticket_id = ? ORDER BY created_at', ticket.id)
      .toArray() as { author: string; body: string }[];
    const lastFrom = (a: string) => [...prior].reverse().find((m) => m.author === a)?.body;

    let context = `# Ticket: ${ticket.title}\n\n${ticket.rawIdea}`;
    if (ticket.spec?.summary) context += `\n\n## Approved spec\n${ticket.spec.summary}`;

    if (role === 'Dev') {
      const ba = lastFrom('BA');
      if (ba) context += `\n\n## BA analysis\n${ba}`;
      if (ticket.status === 'qa-failed' || ticket.iterations > 0) {
        const qa = lastFrom('QA');
        if (qa) context += `\n\n## QA found these issues — fix them\n${qa}`;
      }
      context += `\n\nThe app id is "${slug}". Implement or modify the app to satisfy the spec, using your tools.`;
    } else if (role === 'QA') {
      const ba = lastFrom('BA');
      if (ba) context += `\n\n## Spec to verify\n${ba}`;
      context += `\n\nThe app id is "${slug}". Review the implemented code and report PASS or FAIL with specific findings.`;
    }

    return [{
      id: uuid(),
      ticketId: ticket.id,
      author: 'po',
      body: context,
      createdAt: Date.now(),
      costUsd: 0,
      tokensIn: 0,
      tokensOut: 0,
    }];
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
    } else if (role === 'Dev') {
      this.state.storage.sql.exec(
        "UPDATE tickets SET status = 'qa-active', assignee_role = 'QA', updated_at = ? WHERE id = ?",
        now, ticketId,
      );
      this.broadcast({ type: 'transition', ticketId, from: 'dev-active', to: 'qa-active', trigger: 'Dev' });
    } else if (role === 'QA') {
      const failed = qaVerdict(output) === 'qa-failed';
      if (failed) {
        this.state.storage.sql.exec(
          "UPDATE tickets SET status = 'qa-failed', assignee_role = 'Dev', updated_at = ? WHERE id = ?",
          now, ticketId,
        );
        this.broadcast({ type: 'transition', ticketId, from: 'qa-active', to: 'qa-failed', trigger: 'QA' });
      } else {
        this.state.storage.sql.exec(
          "UPDATE tickets SET status = 'done', assignee_role = NULL, updated_at = ? WHERE id = ?",
          now, ticketId,
        );
        this.broadcast({ type: 'transition', ticketId, from: 'qa-active', to: 'done', trigger: 'QA' });
      }
    }
  }

  /** Park a ticket in needs-input with a message to the user. */
  private blockForInput(ticketId: string, role: Role, message: string): void {
    const now = Date.now();
    this.state.storage.sql.exec(
      "UPDATE tickets SET status = 'needs-input', updated_at = ? WHERE id = ?",
      now, ticketId,
    );
    this.state.storage.sql.exec(
      'INSERT INTO chat_history (id, role, body, created_at) VALUES (?, ?, ?, ?)',
      uuid(), 'system', message, now,
    );
    this.broadcast({ type: 'transition', ticketId, to: 'needs-input', reason: 'agent-blocked', role });
    this.broadcast({ type: 'chat', role: 'system', body: message, id: uuid() });
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
      { role: 'BA', runtime: 'cf-native', model: 'claude-sonnet-4-6', spineTools: [], vendorTools: [] },
      { role: 'Dev', runtime: 'cf-native', model: 'claude-sonnet-4-6', spineTools: ['scaffold_app', 'write_file', 'read_file', 'list_files', 'batch_write_files', 'search_files', 'get_deploy_status', 'provision_app'], vendorTools: [] },
      { role: 'QA', runtime: 'cf-native', model: 'claude-sonnet-4-6', spineTools: ['read_file', 'list_files', 'search_files', 'get_deploy_status'], vendorTools: [] },
    ];

    for (const rc of defaults) {
      this.state.storage.sql.exec(
        `INSERT OR REPLACE INTO role_configs (role, runtime, model, spine_tools, vendor_tools)
         VALUES (?, ?, ?, ?, ?)`,
        rc.role, rc.runtime, rc.model, JSON.stringify(rc.spineTools), JSON.stringify(rc.vendorTools),
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

      this.state.storage.sql.exec(
        `INSERT OR REPLACE INTO role_configs (role, runtime, model, system_prompt_override, spine_tools, vendor_tools)
         VALUES (?, ?, ?, ?, ?, ?)`,
        rc.role, rc.runtime, rc.model, rc.systemPromptOverride ?? null,
        JSON.stringify(rc.spineTools), JSON.stringify(rc.vendorTools),
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

    this.broadcast({ type: 'message', ticketId: opts.ticketId, messageId: id, author: opts.author });
    return id;
  }

  // ── Chat (PO agent triage) ──────────────────────────────────

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

    const userText = body.message.trim();
    const now = Date.now();

    // Record user activity (resets idle timeout)
    this.touchUserActivity();

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

    // Call Anthropic for real PO agent response
    const systemPrompt = `You are the PO (Product Owner) agent for a ProAppStore project. You read the founder's messages and decide what to do.

Your job:
- If the founder describes a feature or something to build → respond with a JSON tool call to create a ticket
- If the founder asks a technical question → answer it yourself or say you'll route it to Dev
- If the founder gives feedback on existing work → acknowledge and update the relevant ticket
- If the founder is just chatting → respond naturally

Current backlog:
${backlogSummary || '(empty)'}

When creating a ticket, respond with EXACTLY this JSON on its own line:
{"tool":"create_ticket","title":"short title","rawIdea":"full description"}

Otherwise just respond in plain text. Be concise. You're a PO, not a chatbot.`;

    const messages = [
      ...recentChat.map((m) => ({
        role: m.role === 'user' ? 'user' as const : 'assistant' as const,
        content: m.body,
      })),
    ];
    // The last message is already the user's current message from chat history

    try {
      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: 'claude-sonnet-4-6',
          max_tokens: 1024,
          system: systemPrompt,
          messages,
        }),
      });

      if (!res.ok) {
        const safeError = res.status === 401 ? 'API key invalid'
          : res.status === 429 ? 'Rate limited'
          : `AI error (${res.status})`;
        return this.savePOResponse(`Sorry, I couldn't process that: ${safeError}`, now, undefined);
      }

      const aiRes = (await res.json()) as Record<string, unknown>;
      const contentArr = aiRes.content;
      if (!Array.isArray(contentArr)) {
        return this.savePOResponse('I got an unexpected response format. Try again?', now, undefined);
      }

      const text = (contentArr as { type: string; text?: string }[]).find((c) => c.type === 'text')?.text ?? '';

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

// ── Row mappers ─────────────────────────────────────────────

function rowToTicket(row: Record<string, unknown>): Ticket {
  return {
    id: row.id as string,
    projectId: '',
    title: row.title as string,
    rawIdea: row.raw_idea as string,
    spec: row.spec_json ? JSON.parse(row.spec_json as string) as BaSpec : null,
    status: row.status as TicketStatus,
    assigneeRole: (row.assignee_role as Role) ?? null,
    iterations: row.iterations as number,
    createdAt: row.created_at as number,
    updatedAt: row.updated_at as number,
    costSpentUsd: row.cost_spent_usd as number,
    prUrl: (row.pr_url as string) ?? null,
    finalCommitSha: (row.final_commit_sha as string) ?? null,
    stuckReason: (row.stuck_reason as string) ?? null,
  };
}

function rowToMessage(row: Record<string, unknown>): Message {
  return {
    id: row.id as string,
    ticketId: row.ticket_id as string,
    author: row.author as MessageAuthor,
    body: row.body as string,
    toolCalls: row.tool_calls_json ? JSON.parse(row.tool_calls_json as string) : undefined,
    createdAt: row.created_at as number,
    costUsd: row.cost_usd as number,
    tokensIn: row.tokens_in as number,
    tokensOut: row.tokens_out as number,
    bodyOffloadKey: (row.body_offload_key as string) ?? undefined,
  };
}

function rowToRoleConfig(row: Record<string, unknown>): RoleConfig {
  return {
    role: row.role as Role,
    runtime: row.runtime as RuntimeKind,
    model: row.model as string,
    systemPromptOverride: (row.system_prompt_override as string) ?? undefined,
    spineTools: JSON.parse((row.spine_tools as string) || '[]'),
    vendorTools: JSON.parse((row.vendor_tools as string) || '[]'),
  };
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
