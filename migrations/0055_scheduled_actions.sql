-- Scheduled registered actions (#123). A run is durable before it is sent to
-- an app data worker, so overlapping cron invocations cannot execute the same
-- due minute twice and an abandoned claim can be recovered safely.
CREATE TABLE IF NOT EXISTS scheduled_action_runs (
  run_id       TEXT PRIMARY KEY,
  app_id       TEXT NOT NULL,
  action_name  TEXT NOT NULL,
  source       TEXT NOT NULL DEFAULT 'code',
  due_at       INTEGER NOT NULL,
  claimed_at   INTEGER,
  finished_at  INTEGER,
  status       TEXT NOT NULL, -- due | claimed | succeeded | failed
  changes      INTEGER,
  error        TEXT,
  UNIQUE (app_id, action_name, due_at)
);
CREATE INDEX IF NOT EXISTS idx_scheduled_action_runs_app ON scheduled_action_runs (app_id, finished_at DESC);
CREATE INDEX IF NOT EXISTS idx_scheduled_action_runs_claim ON scheduled_action_runs (status, claimed_at);

-- State is intentionally separate from the manifest: re-registering an app's
-- code manifest deletes its code state, which is the explicit owner action
-- that resets a five-failure breaker. Run history remains intact.
CREATE TABLE IF NOT EXISTS scheduled_action_state (
  app_id               TEXT NOT NULL,
  action_name          TEXT NOT NULL,
  source               TEXT NOT NULL DEFAULT 'code',
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  schedule_disabled_at INTEGER,
  PRIMARY KEY (app_id, action_name)
);
