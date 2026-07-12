-- QA test flows + runs (#38). Flow specs live HERE, never in app repos —
-- automation must be zero burden on product code. Runs are written by the
-- observable runner page (trigger 'browser'), the qa-worker ('deploy'/'cron'/
-- 'manual'), and read by owners + the PAGS QA agent.
CREATE TABLE IF NOT EXISTS app_test_flows (
  app_id     TEXT    NOT NULL,
  flow_id    TEXT    NOT NULL,
  name       TEXT    NOT NULL,
  spec       TEXT    NOT NULL,             -- validated qa-spec JSON
  updated_by TEXT    NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (app_id, flow_id)
);

CREATE TABLE IF NOT EXISTS app_test_runs (
  run_id           TEXT    PRIMARY KEY,
  app_id           TEXT    NOT NULL,
  flow_id          TEXT    NOT NULL,
  trigger_kind     TEXT    NOT NULL,       -- 'manual' | 'deploy' | 'cron' | 'browser'
  status           TEXT    NOT NULL,       -- 'queued' | 'running' | 'passed' | 'failed' | 'error'
  steps_total      INTEGER,
  steps_passed     INTEGER,
  failed_step      INTEGER,
  error            TEXT,
  artifacts_prefix TEXT,                   -- R2 prefix for screenshots
  started_at       INTEGER NOT NULL,
  finished_at      INTEGER
);
CREATE INDEX IF NOT EXISTS idx_app_test_runs_app ON app_test_runs(app_id, started_at DESC);

-- Scoped QA API keys: the PAGS QA agent authenticates with one of these, not
-- an owner session token (which would be full-power + 30-day expiry). Keys
-- are accepted ONLY by the /v1/apps/:appId/qa/* routes for their app.
CREATE TABLE IF NOT EXISTS qa_api_keys (
  key_hash   TEXT    PRIMARY KEY,          -- SHA-256 hex of the key
  app_id     TEXT    NOT NULL,
  created_by TEXT    NOT NULL,
  created_at INTEGER NOT NULL,
  revoked_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_qa_api_keys_app ON qa_api_keys(app_id);
