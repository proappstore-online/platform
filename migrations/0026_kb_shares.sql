-- KB sharing: access-controlled share links for Knowledge Bases.

CREATE TABLE IF NOT EXISTS kb_shares (
  id            TEXT PRIMARY KEY,
  project_slug  TEXT NOT NULL,
  created_by    TEXT NOT NULL,
  access_type   TEXT NOT NULL DEFAULT 'open',
  allowlist     TEXT,
  password_hash TEXT,
  label         TEXT,
  expires_at    INTEGER,
  revoked       INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL,
  view_count    INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_kb_shares_project ON kb_shares(project_slug);
