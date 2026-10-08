-- The app that provisioned a credential account, if any. This is the durable
-- authority boundary for app-scoped staff operations: an action belonging to
-- one app must never operate on a student provisioned for another app.
--
-- Existing accounts deliberately remain unbound. Their provisioning adult (or
-- a platform admin) can still recover them, but an app-defined policy cannot
-- claim them retroactively.
ALTER TABLE users ADD COLUMN credential_app_id TEXT;

CREATE INDEX IF NOT EXISTS idx_users_credential_app_id
  ON users(credential_app_id) WHERE credential_app_id IS NOT NULL;
