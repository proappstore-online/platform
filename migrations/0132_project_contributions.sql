-- #545 (epic #544): the project contribution ledger. Additive only; no existing row is touched.
--
-- Records per-person source-line activity for one app's repository, as code-activity metrics. They change no
-- access, role, ownership, payout or identity link. Every fact is keyed by the repository's IMMUTABLE GitHub id and
-- the commit SHA, so a renamed login, a renamed or transferred repository, a replayed webhook or a concurrent worker
-- can never count a commit twice.

-- The repository a project's contribution data is read from. The platform derives it (the app's own repository, or
-- a pinned transferred one); a caller never supplies one. `github_repo_id` is recorded when the platform first sees
-- the repository and is the identity from then on: a different id under the same name is `identity_changed`, never
-- silently re-bound.
CREATE TABLE IF NOT EXISTS project_repositories (
  app_id TEXT PRIMARY KEY REFERENCES apps(id) ON DELETE CASCADE,
  github_repo_id INTEGER,
  full_name TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('convention', 'pinned')),
  default_branch TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'verified', 'identity_changed', 'access_lost', 'unavailable')),
  status_detail TEXT,
  verified_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- One row per commit ever read. A merge commit is recorded (counted = 0) so it is never fetched again, and its
-- combined diff is never added on top of the commits it merges. `reachable` says whether the commit is on the default
-- branch NOW; a rewritten history makes old commits unreachable but keeps the facts. author_github_id is the numeric
-- GitHub account GitHub linked to the commit's author; NULL means GitHub linked none ('unlinked'). Raw author emails
-- are never stored.
CREATE TABLE IF NOT EXISTS project_commits (
  github_repo_id INTEGER NOT NULL,
  sha TEXT NOT NULL,
  app_id TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  author_github_id INTEGER,
  author_login TEXT,
  author_kind TEXT NOT NULL CHECK (author_kind IN ('user', 'bot', 'unlinked')),
  authored_at INTEGER NOT NULL,
  parent_count INTEGER NOT NULL,
  counted INTEGER NOT NULL CHECK (counted IN (0, 1)),
  additions INTEGER NOT NULL DEFAULT 0,
  deletions INTEGER NOT NULL DEFAULT 0,
  files_counted INTEGER NOT NULL DEFAULT 0,
  files_excluded INTEGER NOT NULL DEFAULT 0,
  co_authors INTEGER NOT NULL DEFAULT 0,
  files_truncated INTEGER NOT NULL DEFAULT 0 CHECK (files_truncated IN (0, 1)),
  policy_version INTEGER NOT NULL,
  reachable INTEGER NOT NULL DEFAULT 1 CHECK (reachable IN (0, 1)),
  walk_id TEXT,
  ingested_at INTEGER NOT NULL,
  PRIMARY KEY (github_repo_id, sha)
);
CREATE INDEX IF NOT EXISTS idx_project_commits_stats ON project_commits (app_id, github_repo_id, reachable, counted, authored_at);
CREATE INDEX IF NOT EXISTS idx_project_commits_author ON project_commits (app_id, author_kind, author_github_id);

-- Freshness, backfill completion, errors and rewrite state, kept apart so a reader can tell "no commits" from
-- "not read yet" from "could not read". `lease_until` is the single-writer claim; `walk_*` is the checkpoint a
-- resumed run continues from.
CREATE TABLE IF NOT EXISTS project_contribution_sync (
  app_id TEXT PRIMARY KEY REFERENCES apps(id) ON DELETE CASCADE,
  github_repo_id INTEGER,
  policy_version INTEGER NOT NULL,
  state TEXT NOT NULL DEFAULT 'idle' CHECK (state IN ('idle', 'running', 'complete', 'incomplete', 'error')),
  backfill_complete INTEGER NOT NULL DEFAULT 0 CHECK (backfill_complete IN (0, 1)),
  head_sha TEXT,
  default_branch TEXT,
  walk_id TEXT,
  walk_head_sha TEXT,
  walk_page INTEGER NOT NULL DEFAULT 1,
  walk_full INTEGER NOT NULL DEFAULT 0 CHECK (walk_full IN (0, 1)),
  last_attempt_at INTEGER,
  last_success_at INTEGER,
  last_error TEXT,
  error_count INTEGER NOT NULL DEFAULT 0,
  rate_limited_until INTEGER,
  rewrite_detected_at INTEGER,
  lease_until INTEGER,
  next_refresh_at INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_project_contribution_sync_due ON project_contribution_sync (next_refresh_at);

-- What the ingestion did and why, never rewritten. No author names, emails or tokens.
CREATE TABLE IF NOT EXISTS project_contribution_events (
  id TEXT PRIMARY KEY,
  app_id TEXT NOT NULL,
  github_repo_id INTEGER,
  action TEXT NOT NULL,
  detail TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_project_contribution_events_app ON project_contribution_events (app_id, created_at DESC);

CREATE TRIGGER IF NOT EXISTS project_contribution_events_immutable
BEFORE UPDATE ON project_contribution_events
BEGIN
  SELECT RAISE(ABORT, 'project_contribution_events is append-only');
END;
