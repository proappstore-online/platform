-- Centralized build service: one row per build (ADR-006 Phase 3).
-- The build orchestrator writes a row when a push is queued and updates it as
-- the build moves queued → running → success|failed. The console reads recent
-- rows per app to show build status/history (replacing the GitHub Actions UI).
CREATE TABLE IF NOT EXISTS builds (
  id          TEXT PRIMARY KEY,   -- GitHub delivery id (unique per webhook) or uuid
  app_id      TEXT NOT NULL,
  repo        TEXT NOT NULL,      -- owner/name
  sha         TEXT NOT NULL,      -- pinned commit
  status      TEXT NOT NULL,      -- queued | running | success | failed
  reason      TEXT,               -- failure reason / note (e.g. NOT_WIRED)
  created_at  INTEGER NOT NULL,   -- ms epoch, when queued
  started_at  INTEGER,            -- ms epoch, when the container began
  finished_at INTEGER,            -- ms epoch, when it ended
  duration_ms INTEGER             -- finished_at - started_at
);

-- Recent-builds-per-app lookup for the console.
CREATE INDEX IF NOT EXISTS builds_app_idx ON builds (app_id, created_at DESC);
