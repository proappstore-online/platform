-- Rate-limit tracking for maps API. 100 requests per user per hour.
-- Rows older than 2 hours can be pruned by cron.

CREATE TABLE IF NOT EXISTS maps_usage (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  ts INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_maps_usage_rate ON maps_usage (user_id, ts);
