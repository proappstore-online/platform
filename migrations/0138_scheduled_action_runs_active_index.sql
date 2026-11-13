-- Refs #593: the live-run check in claimDue (lib/scheduled-actions.ts) matched on
-- (app_id, action_name) through the UNIQUE (app_id, action_name, due_at) index and
-- walked every past run of the action, about 5K rows per call and growing by one
-- per scheduled minute. This partial index holds only live runs. Additive only.
CREATE INDEX IF NOT EXISTS idx_scheduled_action_runs_active
  ON scheduled_action_runs (app_id, action_name) WHERE status IN ('claimed', 'queued');
