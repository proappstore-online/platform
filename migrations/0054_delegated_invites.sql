-- Delegated invite administration is a fourth, deliberately separate authority:
-- app team roles operate the build; app_roles describe an app user; these tables
-- say which app role may create which invite role, and who administers each
-- opaque app group.  Neither table grants an app role or team membership.

CREATE TABLE IF NOT EXISTS app_invite_policies (
  app_id          TEXT NOT NULL,
  delegate_role   TEXT NOT NULL,
  grantable_role  TEXT NOT NULL,
  created_by      TEXT NOT NULL,
  created_at      INTEGER NOT NULL,
  PRIMARY KEY (app_id, delegate_role, grantable_role)
);
CREATE INDEX IF NOT EXISTS idx_app_invite_policies_app
  ON app_invite_policies(app_id);

CREATE TABLE IF NOT EXISTS app_group_admin_grants (
  app_id      TEXT NOT NULL,
  group_id    TEXT NOT NULL,
  user_id     TEXT NOT NULL,
  granted_by  TEXT NOT NULL,
  granted_at  INTEGER NOT NULL,
  PRIMARY KEY (app_id, group_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_app_group_admin_grants_user
  ON app_group_admin_grants(app_id, user_id, group_id);

-- A redemption row is the idempotency key.  The INSERT below is conditional on
-- availability; its triggers consume one use and grant the app role in the
-- same SQLite transaction, so a role grant cannot be returned without a use
-- being consumed (or vice versa).
CREATE TABLE IF NOT EXISTS invite_redemptions (
  invite_id   TEXT NOT NULL,
  user_id     TEXT NOT NULL,
  redeemed_at INTEGER NOT NULL,
  PRIMARY KEY (invite_id, user_id)
);

CREATE TRIGGER IF NOT EXISTS invite_redemptions_consume_use
AFTER INSERT ON invite_redemptions
BEGIN
  UPDATE invites
     SET used_count = used_count + 1
   WHERE id = NEW.invite_id
     AND used_count < max_uses;
END;

CREATE TRIGGER IF NOT EXISTS invite_redemptions_grant_role
AFTER INSERT ON invite_redemptions
BEGIN
  INSERT INTO app_roles (app_id, user_id, role_name, granted_by)
  SELECT app_id, NEW.user_id, role, 'invite:' || id
    FROM invites
   WHERE id = NEW.invite_id
  ON CONFLICT(app_id, user_id, role_name) DO NOTHING;
END;
