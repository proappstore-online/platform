-- App logs: client-side log entries uploaded by the SDK logger.
-- Same schema as FAS (0013_app_logs.sql) — vendored, not shared.

CREATE TABLE IF NOT EXISTS app_logs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  app_id      TEXT    NOT NULL,
  user_id     TEXT    NOT NULL,
  ts          INTEGER NOT NULL,
  level       TEXT    NOT NULL,
  category    TEXT    NOT NULL DEFAULT 'app',
  message     TEXT    NOT NULL,
  data        TEXT,
  build_meta  TEXT,
  ingested_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_app_logs_app_ts ON app_logs (app_id, ts DESC);
CREATE INDEX IF NOT EXISTS idx_app_logs_app_level ON app_logs (app_id, level);
