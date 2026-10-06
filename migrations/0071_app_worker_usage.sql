-- #275 (ADR-009 §4): per-app app-worker usage, daily quotas, and the account guard.
--
-- Additive only.
--
-- app_worker_usage: one row per app per UTC day, mirroring app_log_usage.
--   `invocations` is reserved atomically before every invoke (schedule, hook and
--   http alike) and is the quota gate. `cpu_ms` is wall-clock time of the
--   invocation (the loader returns no CPU time; labelled `wall` on the usage
--   route). `pas_calls` comes from each invocation's own D1 counter (#254).
--   `hook_deliveries` counts accepted (verified, non-duplicate) deliveries.
CREATE TABLE IF NOT EXISTS app_worker_usage (
  app_id          TEXT    NOT NULL,
  day             TEXT    NOT NULL,
  invocations     INTEGER NOT NULL DEFAULT 0,
  cpu_ms          INTEGER NOT NULL DEFAULT 0,
  hook_deliveries INTEGER NOT NULL DEFAULT 0,
  pas_calls       INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (app_id, day)
);
CREATE INDEX IF NOT EXISTS idx_app_worker_usage_day ON app_worker_usage (day);

-- Admin per-app quota override: JSON { invocations?, cpu_ms?, hook_deliveries? }.
ALTER TABLE app_workers ADD COLUMN quota_overrides TEXT;

-- APP_WORKER_OPEN: a runtime platform flag, flipped without a deploy. Closed by
-- the account-ceiling guard; reopened only by an admin. Gates new enables only.
CREATE TABLE IF NOT EXISTS app_worker_platform (
  id            INTEGER PRIMARY KEY CHECK (id = 1),
  open          INTEGER NOT NULL DEFAULT 1,
  closed_reason TEXT,
  closed_at     INTEGER
);
INSERT OR IGNORE INTO app_worker_platform (id, open) VALUES (1, 1);
