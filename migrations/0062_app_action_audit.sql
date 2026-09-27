-- Success audit of role-gated actions (#232, part of #228). One row per
-- successful call of a registered action gated by `auth.app_roles`: who, which
-- app, which action, under which role, when. No params, no SQL, no results —
-- the trail says what was done, never with what data. Failures stay in
-- app_logs (operation-log.ts).
CREATE TABLE IF NOT EXISTS app_action_audit (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  app_id      TEXT NOT NULL,
  action_name TEXT NOT NULL,
  actor_id    TEXT NOT NULL,     -- users.id of the caller (session or personal app token)
  role_name   TEXT NOT NULL,     -- the app role that granted the call
  status      INTEGER NOT NULL,  -- HTTP status returned (2xx/3xx)
  created_at  INTEGER NOT NULL   -- epoch ms
);
CREATE INDEX IF NOT EXISTS idx_app_action_audit_app ON app_action_audit (app_id, created_at);
CREATE INDEX IF NOT EXISTS idx_app_action_audit_actor ON app_action_audit (app_id, actor_id, created_at);
