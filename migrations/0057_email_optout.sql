-- Email channel for notify-user (#209). The platform resolves the recipient's
-- verified address itself; an app never sees it.
--
-- Per-app opt-out, written by the one-click unsubscribe link in every such email.
CREATE TABLE IF NOT EXISTS notification_email_optout (
  app_id     TEXT NOT NULL,
  user_id    TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (app_id, user_id)
);

-- notify-user emails share the app's daily budget in email_usage with
-- app.email.send; the recipient column adds the per-recipient daily cap.
-- NULL for app.email.send rows (their recipient is a caller-supplied address).
ALTER TABLE email_usage ADD COLUMN target_user_id TEXT;
CREATE INDEX IF NOT EXISTS idx_email_usage_target ON email_usage (app_id, target_user_id, sent_at);
