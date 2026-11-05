-- Preserve existing access as explicitly legacy grants; never invent a consent receipt.
ALTER TABLE google_calendar_accounts ADD COLUMN scopes_json TEXT NOT NULL DEFAULT '[]';
ALTER TABLE google_calendar_accounts ADD COLUMN credential_revision INTEGER NOT NULL DEFAULT 0;
UPDATE google_calendar_accounts SET scopes_json = '["https://www.googleapis.com/auth/calendar.events.readonly","https://www.googleapis.com/auth/calendar.calendarlist.readonly","https://www.googleapis.com/auth/meetings.space.readonly"]' WHERE status = 'connected';

ALTER TABLE app_connectors ADD COLUMN capabilities_json TEXT NOT NULL DEFAULT '[]';
ALTER TABLE app_connectors ADD COLUMN disclosure_json TEXT;
ALTER TABLE app_connectors ADD COLUMN contract_hash TEXT NOT NULL DEFAULT 'legacy';
UPDATE app_connectors SET capabilities_json = '["calendar.read","meet.read"]' WHERE kind = 'google_calendar';

ALTER TABLE google_calendar_app_authorizations ADD COLUMN authorization_version INTEGER NOT NULL DEFAULT 1;
ALTER TABLE google_calendar_app_authorizations ADD COLUMN capabilities_json TEXT NOT NULL DEFAULT '["calendar.read","meet.read"]';
ALTER TABLE google_calendar_app_authorizations ADD COLUMN contract_hash TEXT NOT NULL DEFAULT 'legacy';
ALTER TABLE google_calendar_app_authorizations ADD COLUMN disclosure_json TEXT;
ALTER TABLE google_calendar_app_authorizations ADD COLUMN consent_version INTEGER NOT NULL DEFAULT 0;
ALTER TABLE google_calendar_app_authorizations ADD COLUMN consented_at INTEGER;
ALTER TABLE google_calendar_grants ADD COLUMN authorization_version INTEGER NOT NULL DEFAULT 1;

-- Old in-flight requests lack browser-bound platform consent and must restart.
DELETE FROM google_calendar_oauth_states;
ALTER TABLE google_calendar_oauth_states ADD COLUMN authorization_version INTEGER NOT NULL DEFAULT 0;
ALTER TABLE google_calendar_oauth_states ADD COLUMN capabilities_json TEXT NOT NULL DEFAULT '["calendar.read"]';
ALTER TABLE google_calendar_oauth_states ADD COLUMN contract_hash TEXT NOT NULL DEFAULT 'legacy';
ALTER TABLE google_calendar_oauth_states ADD COLUMN disclosure_json TEXT;
ALTER TABLE google_calendar_oauth_states ADD COLUMN browser_hash TEXT;
ALTER TABLE google_calendar_oauth_states ADD COLUMN consented_at INTEGER;

-- A per-app revocation also invalidates in-flight callbacks and saved resource receipts.
CREATE TRIGGER google_calendar_authorization_removed
AFTER DELETE ON google_calendar_app_authorizations
BEGIN
  DELETE FROM google_calendar_grants WHERE app_id = OLD.app_id AND user_id = OLD.user_id;
  DELETE FROM google_calendar_oauth_states WHERE app_id = OLD.app_id AND user_id = OLD.user_id;
END;

CREATE TRIGGER google_calendar_global_disconnect
AFTER UPDATE OF version ON google_calendar_accounts
WHEN NEW.status = 'disconnected' AND OLD.version <> NEW.version
BEGIN
  DELETE FROM google_calendar_app_authorizations WHERE user_id = NEW.user_id;
  DELETE FROM google_calendar_oauth_states WHERE user_id = NEW.user_id;
  DELETE FROM google_calendar_grants WHERE user_id = NEW.user_id;
END;

-- Removing/replacing a connector or changing its disclosure never resurrects
-- old consent, even if a later manifest returns to the old contract hash.
CREATE TRIGGER google_calendar_connector_removed AFTER DELETE ON app_connectors
WHEN OLD.kind = 'google_calendar'
BEGIN
  DELETE FROM google_calendar_app_authorizations WHERE app_id = OLD.app_id;
  DELETE FROM google_calendar_oauth_states WHERE app_id = OLD.app_id;
  DELETE FROM google_calendar_grants WHERE app_id = OLD.app_id;
END;
CREATE TRIGGER google_calendar_contract_changed AFTER UPDATE ON app_connectors
WHEN OLD.kind = 'google_calendar' AND (NEW.kind <> OLD.kind OR NEW.contract_hash <> OLD.contract_hash)
BEGIN
  DELETE FROM google_calendar_app_authorizations WHERE app_id = OLD.app_id;
  DELETE FROM google_calendar_oauth_states WHERE app_id = OLD.app_id;
  DELETE FROM google_calendar_grants WHERE app_id = OLD.app_id;
END;
