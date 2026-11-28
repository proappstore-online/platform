-- #695: the app roles an app declares in mcp.json `roles`, replaced with the
-- manifest on every registration. The app's owner holds every declared role;
-- `requires` (a JSON array of declared role ids) is granted with the role and
-- revoked with it. An app with no rows here keeps role names as free strings.
CREATE TABLE IF NOT EXISTS app_declared_roles (
  app_id       TEXT NOT NULL,
  role_id      TEXT NOT NULL,
  position     INTEGER NOT NULL,
  label        TEXT NOT NULL,
  description  TEXT,
  requires     TEXT NOT NULL DEFAULT '[]',
  created_at   INTEGER NOT NULL,
  PRIMARY KEY (app_id, role_id)
);

-- Whether the role on a success-audit row (#232) came from app ownership
-- rather than an app_roles grant: 1 when the owner ran under a declared role
-- they were never granted. 0 for every grant-held role and for rows with no role.
ALTER TABLE app_action_audit ADD COLUMN role_via_owner INTEGER NOT NULL DEFAULT 0 CHECK (role_via_owner IN (0, 1));
