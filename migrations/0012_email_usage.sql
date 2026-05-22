CREATE TABLE email_usage (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  app_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  sent_at INTEGER NOT NULL
);
CREATE INDEX idx_email_usage_rate ON email_usage (app_id, sent_at);
