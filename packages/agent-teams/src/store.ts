/**
 * Storage layer for ProjectDO: the SQLite schema + small pure helpers and the
 * row → domain-type mappers. Kept separate from the DO so the DO file holds
 * behavior, not table definitions and boilerplate.
 */

import type { BaSpec, Message, MessageAuthor, Role, RoleConfig, RuntimeKind, Ticket, TicketStatus } from './types.ts';

export const SCHEMA = `
CREATE TABLE IF NOT EXISTS project (
  id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, name TEXT NOT NULL, slug TEXT NOT NULL,
  created_at INTEGER NOT NULL, cost_cap_monthly_usd REAL NOT NULL DEFAULT 50.0,
  cost_spent_monthly_usd REAL NOT NULL DEFAULT 0.0, repo_url TEXT,
  repo_provisioned_at INTEGER, registry_entry_id TEXT, app_idea TEXT
);
CREATE TABLE IF NOT EXISTS role_configs (
  role TEXT PRIMARY KEY, runtime TEXT NOT NULL, model TEXT NOT NULL,
  system_prompt_override TEXT, spine_tools TEXT NOT NULL DEFAULT '[]',
  vendor_tools TEXT NOT NULL DEFAULT '[]', max_tokens INTEGER, persona TEXT
);
-- Project memory (OpenClaw-style MEMORY.md): durable decisions/facts the whole
-- team reads each run and the PO can write. Keyed for upsert/dedupe.
CREATE TABLE IF NOT EXISTS project_memory (
  id TEXT PRIMARY KEY, category TEXT NOT NULL DEFAULT 'decision',
  key TEXT NOT NULL UNIQUE, value TEXT NOT NULL,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS tickets (
  id TEXT PRIMARY KEY, seq INTEGER, title TEXT NOT NULL, raw_idea TEXT NOT NULL, spec_json TEXT,
  status TEXT NOT NULL DEFAULT 'inbox', assignee_role TEXT, iterations INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, cost_spent_usd REAL NOT NULL DEFAULT 0.0,
  pr_url TEXT, final_commit_sha TEXT, stuck_reason TEXT, kind TEXT NOT NULL DEFAULT 'build'
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
  tool_call_json TEXT, created_at INTEGER NOT NULL,
  thread TEXT NOT NULL DEFAULT 'build'
);
CREATE INDEX IF NOT EXISTS idx_chat_history ON chat_history(created_at);
CREATE TABLE IF NOT EXISTS project_files (
  path TEXT PRIMARY KEY, content TEXT NOT NULL, updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS activity_log (
  id TEXT PRIMARY KEY, ticket_id TEXT, type TEXT NOT NULL, detail TEXT NOT NULL, created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_activity ON activity_log(created_at);
`;

/**
 * Additive migrations for columns/backfills not in the base SCHEMA, applied after
 * it on every DO wake (older DOs may predate a column). Each entry is a group of
 * statements run in one try/catch — if the first throws (column already exists),
 * the rest of that group is skipped. Append-only; never reorder or remove.
 */
export const MIGRATIONS: string[][] = [
  [`ALTER TABLE project ADD COLUMN cost_month TEXT DEFAULT ''`],
  [`ALTER TABLE project ADD COLUMN status TEXT DEFAULT 'paused'`],
  // Owner session token, captured at play time, to authenticate spine/MCP tool
  // dispatch during autonomous runs (pre-launch: stored in the DO's SQLite).
  [`ALTER TABLE project ADD COLUMN owner_session_token TEXT`],
  // Per-role output token cap (configurable from the console agent settings).
  [`ALTER TABLE role_configs ADD COLUMN max_tokens INTEGER`],
  // Per-role persona ("soul").
  [`ALTER TABLE role_configs ADD COLUMN persona TEXT`],
  // Tool-call output captured on the activity row (full audit / inspection).
  [`ALTER TABLE activity_log ADD COLUMN meta TEXT`],
  // Last GitHub commit synced into the working tree (GitHub = source of truth).
  [`ALTER TABLE project ADD COLUMN repo_synced_sha TEXT`],
  [`ALTER TABLE project ADD COLUMN repo_synced_at INTEGER`],
  // Short, human-quotable per-project ticket number (#N), backfilled in
  // created_at order so old DOs get stable numbers too.
  [
    `ALTER TABLE tickets ADD COLUMN seq INTEGER`,
    `UPDATE tickets SET seq = (SELECT COUNT(*) FROM tickets t2 WHERE t2.created_at < tickets.created_at OR (t2.created_at = tickets.created_at AND t2.id <= tickets.id)) WHERE seq IS NULL`,
  ],
  // Deploy stage bookkeeping: push ONCE per attempt, then poll CI for that commit.
  [`ALTER TABLE tickets ADD COLUMN deploy_pushed_at INTEGER`],
  [`ALTER TABLE tickets ADD COLUMN deploy_pushed_sha TEXT`],
  // Data plane (D1 + data worker + app record) provisioned once, at first green
  // deploy, via the PAS backend. Timestamp gates re-provisioning every ticket.
  [`ALTER TABLE project ADD COLUMN data_provisioned_at INTEGER`],
  // Ticket kind: 'build' (BA→Dev→QA) or 'research' (Architect builds the KB).
  [`ALTER TABLE tickets ADD COLUMN kind TEXT NOT NULL DEFAULT 'build'`],
  // Persisted founding idea — so brainstorm-first projects (no seeded ticket)
  // still give the PO + Architect the idea.
  [`ALTER TABLE project ADD COLUMN app_idea TEXT`],
  // Chat thread: 'build' (PO ↔ founder, backlog) or 'research' (Architect ↔
  // founder, the Knowledge Base). Separate agents own separate threads so the KB
  // is authored + checked independently of the build. Old rows → 'build'.
  [`ALTER TABLE chat_history ADD COLUMN thread TEXT NOT NULL DEFAULT 'build'`],
];

export function uuid(): string {
  return crypto.randomUUID();
}

/**
 * Append a row to chat_history and return its id (for the matching broadcast).
 * One place owns the INSERT shape — system notices, user messages, and agent
 * replies all funnel through here. Pass `at` to share a handler's timestamp;
 * omit it to stamp now.
 */
export function insertChatMessage(
  sql: SqlStorage,
  msg: { role: string; body: string; toolCall?: { name: string; args: string } | null; at?: number; thread?: string },
): string {
  const id = uuid();
  sql.exec(
    'INSERT INTO chat_history (id, role, body, tool_call_json, created_at, thread) VALUES (?, ?, ?, ?, ?, ?)',
    id, msg.role, msg.body, msg.toolCall ? JSON.stringify(msg.toolCall) : null, msg.at ?? Date.now(), msg.thread ?? 'build',
  );
  return id;
}

export function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

export function rowToTicket(row: Record<string, unknown>): Ticket {
  return {
    id: row.id as string,
    seq: (row.seq as number) ?? 0,
    projectId: '',
    title: row.title as string,
    rawIdea: row.raw_idea as string,
    spec: row.spec_json ? JSON.parse(row.spec_json as string) as BaSpec : null,
    status: row.status as TicketStatus,
    kind: (row.kind as 'build' | 'research') ?? 'build',
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

export function rowToMessage(row: Record<string, unknown>): Message {
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

export function rowToRoleConfig(row: Record<string, unknown>): RoleConfig {
  return {
    role: row.role as Role,
    runtime: row.runtime as RuntimeKind,
    model: row.model as string,
    maxTokens: (row.max_tokens as number) ?? undefined,
    persona: (row.persona as string) ?? undefined,
    systemPromptOverride: (row.system_prompt_override as string) ?? undefined,
    spineTools: JSON.parse((row.spine_tools as string) || '[]'),
    vendorTools: JSON.parse((row.vendor_tools as string) || '[]'),
  };
}
