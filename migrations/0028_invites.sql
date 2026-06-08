-- Platform-level invite links for app-level role assignment.
-- One invite code → one or many redemptions (configurable max_uses).
-- On redeem, the platform assigns the specified role via the roles system.

CREATE TABLE IF NOT EXISTS invites (
  id          TEXT    PRIMARY KEY,
  app_id      TEXT    NOT NULL,
  code        TEXT    NOT NULL UNIQUE,
  role        TEXT    NOT NULL DEFAULT 'member',
  group_id    TEXT,
  metadata    TEXT,
  max_uses    INTEGER NOT NULL DEFAULT 1,
  used_count  INTEGER NOT NULL DEFAULT 0,
  expires_at  INTEGER NOT NULL,
  created_by  TEXT    NOT NULL,
  created_at  INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_invites_code   ON invites(code);
CREATE INDEX IF NOT EXISTS idx_invites_app    ON invites(app_id);
CREATE INDEX IF NOT EXISTS idx_invites_app_active
  ON invites(app_id) WHERE used_count < max_uses;
