-- Refs #597: runScheduledActions (lib/scheduled-actions.ts) read the whole app_tools
-- table on every tick, about 2.8K rows per call, to find the handful of actions whose
-- manifest has a schedule. This partial index holds only those rows; the scheduler's
-- query repeats the same predicate so the planner can use it.
--
-- The CASE guards json_extract: it raises on malformed JSON, and a row whose manifest
-- does not parse is simply not scheduled (the scheduler skipped it before, too).
-- Additive only.
CREATE INDEX IF NOT EXISTS idx_app_tools_scheduled
  ON app_tools (app_id, name)
  WHERE CASE WHEN json_valid(manifest) THEN json_extract(manifest, '$.schedule') END IS NOT NULL;
