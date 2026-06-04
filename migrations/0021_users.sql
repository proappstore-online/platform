-- PAS-owned user identity. Created when PAS runs its own OAuth (de-FAS): the
-- auth service upserts a row on every sign-in and mints a PAS session token.
-- id is "<provider>:<provider_id>", e.g. "gh:1234" or "google:<sub>".
CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,
  provider      TEXT NOT NULL,            -- 'github' | 'google'
  provider_id   TEXT NOT NULL,
  login         TEXT NOT NULL,            -- display handle
  email         TEXT,
  avatar_url    TEXT,
  date_of_birth TEXT,                     -- 'YYYY-MM-DD', set-once
  created_at    INTEGER NOT NULL,
  last_login_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_users_provider ON users (provider, provider_id);
