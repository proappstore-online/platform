-- Managed test principals and least-privilege CI OIDC grants (#432).
-- A test principal is a PAS-managed, non-human identity (user id 'test:<slug>')
-- that CI sessions are minted for. It has no provider login, so it can never be
-- used interactively; disabling it stops every grant bound to it at once.
CREATE TABLE IF NOT EXISTS test_principals (
  id          TEXT PRIMARY KEY,                    -- 'tp_<uuid>'
  slug        TEXT NOT NULL UNIQUE,                -- [a-z0-9-]{3,40}
  user_id     TEXT NOT NULL UNIQUE,                -- 'test:<slug>', row in users
  description TEXT,
  status      TEXT NOT NULL DEFAULT 'active',      -- 'active' | 'disabled'
  created_by  TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  disabled_at INTEGER
);

-- Grants gain optional least-privilege bindings. Existing (#146) rows keep NULLs
-- and behave exactly as before; only principal-backed grants are hardened.
ALTER TABLE oidc_session_grants ADD COLUMN principal_id TEXT;          -- NULL = legacy #146 grant
ALTER TABLE oidc_session_grants ADD COLUMN environment TEXT;           -- GitHub `environment` claim; NULL = any
ALTER TABLE oidc_session_grants ADD COLUMN expires_at INTEGER;         -- NULL = no expiry
ALTER TABLE oidc_session_grants ADD COLUMN session_ttl_seconds INTEGER; -- NULL = platform default
ALTER TABLE oidc_session_grants ADD COLUMN scope TEXT;                 -- 'user' (default) | 'creator'

-- Replay protection: a GitHub OIDC token (jti) can be exchanged once.
CREATE TABLE IF NOT EXISTS oidc_session_replays (
  jti        TEXT PRIMARY KEY,
  grant_id   TEXT NOT NULL,
  seen_at    INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_oidc_session_replays_exp ON oidc_session_replays (expires_at);

-- Durable, secret-free audit of principal and grant lifecycle.
CREATE TABLE IF NOT EXISTS test_principal_events (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  principal_id TEXT,
  grant_id     TEXT,
  action       TEXT NOT NULL,                      -- principal.create|disable|enable | grant.create|revoke
  actor        TEXT NOT NULL,
  detail       TEXT,                               -- JSON, never a token or secret
  at           INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_test_principal_events_at ON test_principal_events (at DESC);
