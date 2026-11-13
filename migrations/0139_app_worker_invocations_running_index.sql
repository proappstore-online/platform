-- Refs #594: stale invocation recovery (lib/scheduled-actions.ts) filters on
-- status = 'running' AND started_at < ?, which had no index and scanned the whole
-- table (about 14.7K rows) on every scheduler tick. This partial index holds only
-- invocations still in flight. Additive only.
CREATE INDEX IF NOT EXISTS idx_app_worker_invocations_running
  ON app_worker_invocations (started_at) WHERE status = 'running';
