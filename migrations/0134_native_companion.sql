-- Consumer devices have their own narrow, revocable credentials. No PAS session is stored here.
CREATE TABLE native_devices (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  label TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX native_devices_user ON native_devices(user_id);
CREATE TABLE native_pairings (
  id TEXT PRIMARY KEY,
  challenge TEXT NOT NULL,
  label TEXT NOT NULL,
  user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
  browser_hash TEXT,
  approved INTEGER NOT NULL DEFAULT 0 CHECK(approved IN (0,1)),
  expires_at INTEGER NOT NULL
);
CREATE TABLE native_grants (
  id TEXT PRIMARY KEY,
  device_id TEXT NOT NULL REFERENCES native_devices(id) ON DELETE CASCADE,
  app_id TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  publisher_id TEXT NOT NULL,
  capability TEXT NOT NULL CHECK(capability = 'location.background'),
  contract_version TEXT NOT NULL,
  consent_at INTEGER NOT NULL,
  UNIQUE(device_id, app_id, capability)
);
CREATE TABLE native_locations (
  grant_id TEXT NOT NULL REFERENCES native_grants(id) ON DELETE CASCADE,
  point_id TEXT NOT NULL,
  recorded_at INTEGER NOT NULL,
  latitude REAL NOT NULL CHECK(latitude BETWEEN -90 AND 90),
  longitude REAL NOT NULL CHECK(longitude BETWEEN -180 AND 180),
  accuracy REAL NOT NULL CHECK(accuracy >= 0),
  PRIMARY KEY(grant_id, point_id)
);
CREATE INDEX native_locations_time ON native_locations(recorded_at);
CREATE INDEX native_locations_grant_time ON native_locations(grant_id, recorded_at, point_id);

-- These are irreversible revocations, not filters that could resurrect consent on a later rollback.
CREATE TRIGGER native_revoke_on_publisher_change
AFTER UPDATE OF creator_id ON apps WHEN OLD.creator_id <> NEW.creator_id
BEGIN
  DELETE FROM native_grants WHERE app_id = NEW.id;
END;
CREATE TRIGGER native_revoke_on_app_account_delete
AFTER INSERT ON per_app_deleted_users
BEGIN
  DELETE FROM native_grants WHERE app_id = NEW.app_id
    AND device_id IN (SELECT id FROM native_devices WHERE user_id = NEW.user_id);
END;
