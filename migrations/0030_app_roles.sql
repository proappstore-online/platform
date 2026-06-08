-- PAS-owned app_roles table (de-FAS: roles no longer live on FAS)
CREATE TABLE IF NOT EXISTS app_roles (
  app_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  role_name TEXT NOT NULL,
  granted_by TEXT,
  granted_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
  PRIMARY KEY (app_id, user_id, role_name)
);
CREATE INDEX IF NOT EXISTS idx_app_roles_app ON app_roles(app_id);
CREATE INDEX IF NOT EXISTS idx_app_roles_user ON app_roles(user_id);
