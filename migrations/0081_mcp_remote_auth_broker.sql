-- #355: short-lived, owner-approved remote MCP authentication requests.
-- Neither the machine proof nor the returned session is stored in plaintext.
CREATE TABLE IF NOT EXISTS mcp_remote_auth_requests (
  request_id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  agent_label TEXT NOT NULL,
  machine_id TEXT NOT NULL,
  machine_label TEXT NOT NULL,
  resource TEXT NOT NULL,
  scopes TEXT NOT NULL,
  code_challenge TEXT NOT NULL,
  machine_proof_hash TEXT NOT NULL,
  status TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  approved_at INTEGER,
  consumed_at INTEGER,
  connected_at INTEGER,
  terminal_at INTEGER,
  result_iv TEXT,
  result_ciphertext TEXT
);

CREATE INDEX IF NOT EXISTS idx_mcp_remote_auth_expiry
  ON mcp_remote_auth_requests(status, expires_at);
