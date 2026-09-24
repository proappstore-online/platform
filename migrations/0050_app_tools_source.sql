-- Console-defined API endpoints (#155). A row in app_tools is either
-- 'code' (registered from the repo's mcp.json on deploy) or 'console' (built
-- from a structured config in the console). Deploys replace only 'code' rows,
-- so console endpoints survive a push; console rows are removed only through
-- the endpoints route, where every change is audited below.
ALTER TABLE app_tools ADD COLUMN source TEXT NOT NULL DEFAULT 'code';
ALTER TABLE app_tools ADD COLUMN config TEXT;      -- the structured EndpointConfig (console rows only)
ALTER TABLE app_tools ADD COLUMN updated_by TEXT;  -- user id of the last console edit

-- Who changed which console endpoint, when — the operation log records failures
-- only, so it cannot answer that. Same shape as deploy_audit / migration_audit.
CREATE TABLE IF NOT EXISTS app_endpoint_audit (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  app_id     TEXT    NOT NULL,
  name       TEXT    NOT NULL,
  action     TEXT    NOT NULL,   -- 'create' | 'update' | 'delete'
  user_id    TEXT    NOT NULL,
  config     TEXT,               -- JSON config after the change (NULL on delete)
  at         INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_app_endpoint_audit_app ON app_endpoint_audit (app_id, at DESC);
