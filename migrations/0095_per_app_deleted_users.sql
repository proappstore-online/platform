-- Per-app deleted-users marker (#379).
-- Records that a user deleted their account in one app, so that app can refuse
-- them. Does NOT affect the shared ProAppStore identity or any other app.
CREATE TABLE IF NOT EXISTS per_app_deleted_users (
  app_id     TEXT NOT NULL,
  user_id    TEXT NOT NULL,
  deleted_by TEXT NOT NULL,
  deleted_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
  PRIMARY KEY (app_id, user_id)
);
