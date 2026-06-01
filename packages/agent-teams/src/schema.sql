-- ProjectDO SQLite schema (runs inside Durable Object storage).
-- Each ProjectDO instance = one PAS Agent Teams project.

CREATE TABLE IF NOT EXISTS project (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  name TEXT NOT NULL,
  slug TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  cost_cap_monthly_usd REAL NOT NULL DEFAULT 50.0,
  cost_spent_monthly_usd REAL NOT NULL DEFAULT 0.0,
  repo_url TEXT,
  repo_provisioned_at INTEGER,
  registry_entry_id TEXT
);

CREATE TABLE IF NOT EXISTS role_configs (
  role TEXT NOT NULL,
  runtime TEXT NOT NULL,
  model TEXT NOT NULL,
  system_prompt_override TEXT,
  spine_tools TEXT NOT NULL DEFAULT '[]',
  vendor_tools TEXT NOT NULL DEFAULT '[]',
  PRIMARY KEY (role)
);

CREATE TABLE IF NOT EXISTS tickets (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  raw_idea TEXT NOT NULL,
  spec_json TEXT,
  status TEXT NOT NULL DEFAULT 'inbox',
  assignee_role TEXT,
  iterations INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  cost_spent_usd REAL NOT NULL DEFAULT 0.0,
  pr_url TEXT,
  final_commit_sha TEXT,
  stuck_reason TEXT
);

CREATE INDEX IF NOT EXISTS idx_tickets_status ON tickets(status);

CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  ticket_id TEXT NOT NULL REFERENCES tickets(id),
  author TEXT NOT NULL,
  body TEXT NOT NULL,
  tool_calls_json TEXT,
  created_at INTEGER NOT NULL,
  cost_usd REAL NOT NULL DEFAULT 0.0,
  tokens_in INTEGER NOT NULL DEFAULT 0,
  tokens_out INTEGER NOT NULL DEFAULT 0,
  body_offload_key TEXT
);

CREATE INDEX IF NOT EXISTS idx_messages_ticket ON messages(ticket_id, created_at);

CREATE TABLE IF NOT EXISTS cost_ledger (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ticket_id TEXT NOT NULL,
  role TEXT NOT NULL,
  cost_usd REAL NOT NULL,
  tokens_in INTEGER NOT NULL,
  tokens_out INTEGER NOT NULL,
  model TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_cost_ticket ON cost_ledger(ticket_id);
