CREATE TABLE app_webhooks (
  id TEXT PRIMARY KEY,
  app_id TEXT NOT NULL,
  event TEXT NOT NULL,
  url TEXT NOT NULL,
  secret TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX idx_app_webhooks_app_event ON app_webhooks (app_id, event);
