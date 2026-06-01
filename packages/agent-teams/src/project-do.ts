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
} from './types.ts';
import {
  MAX_ITERATIONS,
  assigneeForStatus,
  canTransition,
  isTerminal,
} from './ticket-machine.ts';

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
`;

function uuid(): string {
  return crypto.randomUUID();
}

export class ProjectDO implements DurableObject {
  private state: DurableObjectState;
  private env: Bindings;
  private initialized = false;

  constructor(state: DurableObjectState, env: Bindings) {
    this.state = state;
    this.env = env;
  }

  private async ensureSchema(): Promise<void> {
    if (this.initialized) return;
    this.state.storage.sql.exec(SCHEMA);
    // Schema versioning: add columns that may not exist in older DOs
    try {
      this.state.storage.sql.exec(
        `ALTER TABLE project ADD COLUMN cost_month TEXT DEFAULT ''`,
      );
    } catch { /* column already exists */ }
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

    if (path === '/roles' && request.method === 'GET') return this.getRoles();
    if (path === '/roles' && request.method === 'PUT') return this.setRoles(request);

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
    return json(row);
  }

  private async initProject(request: Request): Promise<Response> {
    const body = (await request.json()) as Partial<Project>;
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

    this.broadcast({ type: 'project-created', projectId: id });
    return json({ id, slug: body.slug });
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

    const id = uuid();
    const now = Date.now();

    // Offload large bodies to R2
    let storedBody = body.body;
    let offloadKey: string | null = null;
    if (body.body.length > 8192) {
      offloadKey = `messages/${ticketId}/${id}`;
      await this.env.AGENT_STORAGE.put(offloadKey, body.body);
      storedBody = body.body.slice(0, 200) + '... [offloaded]';
    }

    this.state.storage.sql.exec(
      `INSERT INTO messages (id, ticket_id, author, body, tool_calls_json, created_at, cost_usd, tokens_in, tokens_out, body_offload_key)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id, ticketId, body.author, storedBody,
      body.toolCalls ? JSON.stringify(body.toolCalls) : null,
      now, body.costUsd ?? 0, body.tokensIn ?? 0, body.tokensOut ?? 0, offloadKey,
    );

    // Update cost on ticket and project (with monthly reset)
    if (body.costUsd && body.costUsd > 0) {
      this.state.storage.sql.exec(
        'UPDATE tickets SET cost_spent_usd = cost_spent_usd + ? WHERE id = ?',
        body.costUsd, ticketId,
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
          body.costUsd, currentMonth,
        );
      } else {
        this.state.storage.sql.exec(
          'UPDATE project SET cost_spent_monthly_usd = cost_spent_monthly_usd + ?, cost_month = ?',
          body.costUsd, currentMonth,
        );
      }

      // Record in cost ledger (permanent, never reset)
      this.state.storage.sql.exec(
        `INSERT INTO cost_ledger (ticket_id, role, cost_usd, tokens_in, tokens_out, model, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        ticketId, body.author, body.costUsd, body.tokensIn ?? 0, body.tokensOut ?? 0, 'unknown', now,
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

    this.broadcast({ type: 'message', ticketId, messageId: id, author: body.author });
    return json({ id }, 201);
  }

  // ── Agent run (placeholder — runtime adapters plug in here) ──

  private async runAgent(ticketId: string, _request: Request): Promise<Response> {
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

    // Load role config
    const rcRow = this.state.storage.sql
      .exec('SELECT * FROM role_configs WHERE role = ?', role)
      .toArray()[0];
    if (!rcRow) {
      return json({ error: 'role_not_configured', role }, 400);
    }

    // Load message history for context
    const msgRows = this.state.storage.sql
      .exec('SELECT * FROM messages WHERE ticket_id = ? ORDER BY created_at', ticketId)
      .toArray();

    this.broadcast({
      type: 'agent-run-started',
      ticketId,
      role,
      runtime: (rcRow as Record<string, unknown>).runtime,
    });

    // TODO: dispatch to runtime adapter (CFNativeRuntime or OpenAIResponsesRuntime)
    // For now, return the context that would be passed to the adapter
    return json({
      status: 'ready',
      ticketId,
      role,
      runtime: (rcRow as Record<string, unknown>).runtime,
      model: (rcRow as Record<string, unknown>).model,
      messageCount: msgRows.length,
      note: 'Runtime adapter not wired yet. Schema, state machine, and message log are live.',
    });
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
