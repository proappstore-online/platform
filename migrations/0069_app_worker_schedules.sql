-- #255 (ADR-009 §3, §4): an app worker's schedules, from mcp.json
-- `worker.schedules`, registered with the tools and replaced with them like
-- app_operator_gate. Runs reuse #123's scheduled_action_runs and
-- scheduled_action_state under action_name 'worker:<name>' (no new run tables).
-- `last_manual_run_at` backs the owner's run-now limit (one per 60 s).
-- Additive only: one new table.
CREATE TABLE IF NOT EXISTS app_worker_schedules (
  app_id             TEXT NOT NULL,
  name               TEXT NOT NULL,
  cron               TEXT NOT NULL,
  params             TEXT NOT NULL DEFAULT '{}',
  last_manual_run_at INTEGER,
  created_at         INTEGER NOT NULL,
  PRIMARY KEY (app_id, name)
);
