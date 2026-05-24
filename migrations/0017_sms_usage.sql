-- Rate limiting table for SMS sends
CREATE TABLE IF NOT EXISTS sms_usage (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  app_id TEXT NOT NULL,
  sent_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sms_usage_app_day ON sms_usage (app_id, sent_at);
