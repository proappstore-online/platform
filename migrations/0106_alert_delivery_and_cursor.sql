-- #389: restart-safe alert delivery and an explicit record of evaluation gaps.
--
-- The evaluator recorded an alert and only then dispatched it, so a run that died
-- between the two left an alert that the next run's INSERT OR IGNORE never sent.
-- Delivery is now claimed on the row with a lease and stamped when done; a later
-- tick sends whatever is still undispatched. Every existing row was already
-- dispatched (or never will be) under the old code, so it is stamped as done.
ALTER TABLE app_alerts ADD COLUMN dispatch_claimed_at INTEGER;
ALTER TABLE app_alerts ADD COLUMN dispatched_at INTEGER;
UPDATE app_alerts SET dispatched_at = created_at WHERE dispatched_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_app_alerts_undispatched ON app_alerts (created_at) WHERE dispatched_at IS NULL;

-- One row per scheduled evaluator: the end of the latest interval it evaluated, so a
-- tick can tell when intervals fell out of its catch-up horizon unevaluated. It
-- only ever moves forward; the last such gap is kept for operators.
CREATE TABLE IF NOT EXISTS alert_evaluator_cursor (
  id              TEXT    PRIMARY KEY,
  last_window_end INTEGER NOT NULL,
  gap_start       INTEGER,
  gap_end         INTEGER,
  gap_recorded_at INTEGER,
  updated_at      INTEGER NOT NULL
);
