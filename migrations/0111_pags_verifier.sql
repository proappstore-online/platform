-- #456 (trial): browser verifier runs executed by a ProAgentStore agent under the
-- subscriber's subscription, with the platform's headless executor as the fallback.
--
-- The platform never runs the engine: it queues a job on the agent instance bound
-- here, and is told how it went by a signed callback (routes/pags.ts). Logins stay on
-- the subscriber's machines.
--
-- app_pags_bindings: which ProAgentStore agent instance verifies this app's flows.
-- app_test_runs gains the run's engine ('headless' = qa-worker, the default and the
--   fallback; 'pags' = a ProAgentStore job), the job id, why a pags run fell back,
--   the last state the agent reported (queued|running|needs-you|done|failed), when it
--   last reported, and a small JSON detail (note, question, report url, screenshots).
-- pags_callback_events: one row per callback event id, so a redelivered event does nothing.
CREATE TABLE IF NOT EXISTS app_pags_bindings (
  app_id      TEXT PRIMARY KEY REFERENCES apps(id) ON DELETE CASCADE,
  instance_id TEXT NOT NULL,
  repo        TEXT,
  enabled     INTEGER NOT NULL DEFAULT 1,
  updated_by  TEXT NOT NULL,
  updated_at  INTEGER NOT NULL
);

ALTER TABLE app_test_runs ADD COLUMN engine TEXT NOT NULL DEFAULT 'headless' CHECK (engine IN ('headless', 'pags'));
ALTER TABLE app_test_runs ADD COLUMN pags_job_id TEXT;
ALTER TABLE app_test_runs ADD COLUMN fallback_reason TEXT;
ALTER TABLE app_test_runs ADD COLUMN pags_state TEXT;
ALTER TABLE app_test_runs ADD COLUMN last_event_at INTEGER;
ALTER TABLE app_test_runs ADD COLUMN pags_detail TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_app_test_runs_pags_job ON app_test_runs (pags_job_id) WHERE pags_job_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_app_test_runs_pags_open ON app_test_runs (last_event_at) WHERE engine = 'pags' AND status IN ('queued', 'running');

CREATE TABLE IF NOT EXISTS pags_callback_events (
  job_id      TEXT NOT NULL,
  event_id    TEXT NOT NULL,
  received_at INTEGER NOT NULL,
  PRIMARY KEY (job_id, event_id)
);
