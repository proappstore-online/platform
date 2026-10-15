-- #391: incident counts that do not depend on retained detail rows.
--
-- app_logs rows are capped per app per day (client `count`, server
-- `server_count`, #372) and by a per-key burst limit, so alerts that count rows
-- undercount exactly when an app is failing hardest. Every recorder now adds to
-- these counters BEFORE its detail budget is checked (lib/metric-aggregates.ts).
--
-- Bounded by construction: one row per app, 5-minute bucket and signal, where
-- `signal` is one of a fixed set named in code — never a user, trace, game or
-- path. Public (untrusted) ingestion may only add `client_*` signals; server
-- signals are written by the API and the host's HostApi report only.
CREATE TABLE IF NOT EXISTS app_metric_buckets (
  app_id       TEXT    NOT NULL,
  bucket_start INTEGER NOT NULL, -- epoch ms, a multiple of 5 minutes
  signal       TEXT    NOT NULL,
  n            INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (app_id, bucket_start, signal)
);
-- The evaluator reads every app's buckets in a time range.
CREATE INDEX IF NOT EXISTS idx_app_metric_buckets_time ON app_metric_buckets (bucket_start);

-- #391: the telemetry pipeline's own health, so "no events" can be told apart
-- from "the collector, evaluator or prune has not run". app_id '' is
-- platform-wide (evaluator, prune); a per-app component names its app.
CREATE TABLE IF NOT EXISTS telemetry_health (
  component       TEXT    NOT NULL,
  app_id          TEXT    NOT NULL DEFAULT '',
  last_ok_at      INTEGER,
  last_failure_at INTEGER,
  last_error      TEXT, -- a short code, never a message with data in it
  updated_at      INTEGER NOT NULL,
  PRIMARY KEY (component, app_id)
);
