-- Rate-limit log for peer-to-peer push notifications.
-- Rows older than 5 minutes can be pruned by a cron job.

CREATE TABLE IF NOT EXISTS notification_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sender_id TEXT NOT NULL,
  app_id TEXT NOT NULL,
  target_user_id TEXT NOT NULL,
  sent_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_notification_log_rate ON notification_log (sender_id, app_id, sent_at);
