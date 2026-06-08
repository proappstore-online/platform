-- Per-user key-value store (vendored from FAS)
CREATE TABLE IF NOT EXISTS kv (
  app_id           TEXT NOT NULL,
  user_id          TEXT NOT NULL,
  key              TEXT NOT NULL,
  value            BLOB NOT NULL,
  value_size_bytes INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL,
  PRIMARY KEY (app_id, user_id, key)
);
CREATE INDEX IF NOT EXISTS kv_user_idx ON kv (app_id, user_id);

-- Shared atomic counters per app (vendored from FAS)
CREATE TABLE IF NOT EXISTS counters (
  app_id TEXT NOT NULL,
  key TEXT NOT NULL,
  value INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (app_id, key)
);
CREATE INDEX IF NOT EXISTS idx_counters_app ON counters(app_id);
