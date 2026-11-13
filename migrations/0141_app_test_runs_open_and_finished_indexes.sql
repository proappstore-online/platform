-- Refs #596: three recurring readers scanned all of app_test_runs. Additive only.
--
-- The QA failure streak (lib/error-alerts.ts) reads deploy and cron runs finished
-- in a 24h window: a covering range search here. trigger_kind never changes after
-- insert.
CREATE INDEX IF NOT EXISTS idx_app_test_runs_platform_finished
  ON app_test_runs (finished_at, app_id, status, trigger_kind) WHERE trigger_kind IN ('deploy', 'cron');
-- The qa-worker queue read (oldest queued first) and its stale running recovery:
-- each walks only the open rows, which are normally none.
CREATE INDEX IF NOT EXISTS idx_app_test_runs_queued
  ON app_test_runs (started_at) WHERE status = 'queued';
CREATE INDEX IF NOT EXISTS idx_app_test_runs_running
  ON app_test_runs (started_at) WHERE status = 'running';
