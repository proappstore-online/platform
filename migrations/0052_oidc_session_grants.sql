-- Keyless e2e sessions (#146): a GitHub Actions workflow exchanges its OIDC
-- token for a short-lived platform session of a designated e2e account. The
-- authority is an explicit, revocable grant — "repository X (optionally one
-- workflow, on one ref) may mint sessions for user Y" — created by a platform
-- admin. No grant, no session. Every mint is recorded.
CREATE TABLE IF NOT EXISTS oidc_session_grants (
  id             TEXT PRIMARY KEY,
  repository     TEXT NOT NULL,                     -- 'proappstore-online/chess-academy'
  workflow       TEXT,                              -- optional: '.github/workflows/e2e-full.yml'; NULL = any workflow of the repo
  ref            TEXT NOT NULL DEFAULT 'refs/heads/main',
  user_id        TEXT NOT NULL,                     -- the designated e2e account
  label          TEXT,
  created_by     TEXT NOT NULL,
  created_at     INTEGER NOT NULL,
  revoked_at     INTEGER,
  last_minted_at INTEGER,
  mint_count     INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_oidc_session_grants_repo ON oidc_session_grants (repository, revoked_at);

CREATE TABLE IF NOT EXISTS oidc_session_mints (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  grant_id   TEXT    NOT NULL,
  repository TEXT    NOT NULL,
  workflow   TEXT,
  ref        TEXT,
  sha        TEXT,
  run_id     TEXT,
  user_id    TEXT    NOT NULL,
  minted_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_oidc_session_mints_grant ON oidc_session_mints (grant_id, minted_at DESC);
