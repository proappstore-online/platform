-- Operational alerts (#107): the scheduled evaluator (lib/error-alerts.ts)
-- aggregates app_logs + QA runs per app over a rolling window and records a
-- row per detected spike. The console reads them (GET /v1/apps/:id/alerts);
-- delivery elsewhere goes through app_webhooks (event 'app.alert') only when
-- an owner has registered one — console-first, zero egress by default
-- (ADR-008 decision 6). Payloads carry counts, categories, operations,
-- fingerprints and build metadata: never messages, bodies, tokens or PII.
CREATE TABLE IF NOT EXISTS app_alerts (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  app_id          TEXT    NOT NULL,
  kind            TEXT    NOT NULL,   -- 'error_spike' | 'action_failures' | 'server_5xx' | 'qa_failures'
  window_start    INTEGER NOT NULL,
  window_end      INTEGER NOT NULL,
  count           INTEGER NOT NULL,
  affected_users  INTEGER NOT NULL DEFAULT 0,
  baseline        INTEGER NOT NULL DEFAULT 0,   -- the same measure in the previous window
  top             TEXT    NOT NULL DEFAULT '{}', -- JSON: {categories, operations, fingerprints}
  build_meta      TEXT,                          -- latest build metadata seen in the window
  created_at      INTEGER NOT NULL,
  acknowledged_at INTEGER,
  acknowledged_by TEXT
);
-- One row per app, kind and window bucket: the cron may re-run without doubling alerts.
CREATE UNIQUE INDEX IF NOT EXISTS idx_app_alerts_bucket ON app_alerts (app_id, kind, window_start);
CREATE INDEX IF NOT EXISTS idx_app_alerts_app ON app_alerts (app_id, created_at DESC);
