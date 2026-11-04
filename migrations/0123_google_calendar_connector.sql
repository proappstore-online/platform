-- Platform-held Google accounts; app grants never contain credentials.
CREATE TABLE google_calendar_accounts (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  version INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'disconnected' CHECK(status IN ('connected','disconnected')),
  google_subject TEXT,
  email TEXT,
  credential_ct BLOB,
  credential_dek BLOB,
  credential_iv BLOB,
  updated_at INTEGER NOT NULL
);
CREATE TABLE google_calendar_oauth_states (
  state_hash TEXT PRIMARY KEY,
  app_id TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  account_version INTEGER NOT NULL,
  callback_url TEXT NOT NULL,
  return_to TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  consumed_at INTEGER
);
CREATE INDEX google_calendar_oauth_expiry ON google_calendar_oauth_states(expires_at);
CREATE TABLE google_calendar_grants (
  id TEXT PRIMARY KEY,
  app_id TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES google_calendar_accounts(user_id) ON DELETE CASCADE,
  account_version INTEGER NOT NULL,
  calendar_id TEXT NOT NULL,
  calendar_name TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  revoked_at INTEGER
);
CREATE INDEX google_calendar_grants_app ON google_calendar_grants(app_id, user_id);
-- A user connecting Google in one app does not authorize any other app.
CREATE TABLE google_calendar_app_authorizations (
  app_id TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES google_calendar_accounts(user_id) ON DELETE CASCADE,
  account_version INTEGER NOT NULL,
  PRIMARY KEY (app_id, user_id)
);
-- Changing publisher must not silently transfer users' Google access.
CREATE TRIGGER google_calendar_app_owner_changed
AFTER UPDATE OF creator_id ON apps WHEN OLD.creator_id <> NEW.creator_id
BEGIN
  DELETE FROM google_calendar_app_authorizations WHERE app_id = NEW.id;
  DELETE FROM google_calendar_oauth_states WHERE app_id = NEW.id;
  UPDATE google_calendar_grants SET revoked_at = CAST(strftime('%s','now') AS INTEGER) * 1000
    WHERE app_id = NEW.id AND revoked_at IS NULL;
END;
