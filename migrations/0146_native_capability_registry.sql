-- #629 / ADR-018: native_grants may hold any reviewed native capability, not only location.background.
-- The column CHECK now enforces the id FORMAT only (lowercase letters, '_' and '.', 3-64 chars); membership is
-- enforced in code, because every grant insert takes its capability from a reviewed registry entry, never
-- from the request. Every other column, constraint and UNIQUE(device_id, app_id, capability) is unchanged.
--
-- SQLite cannot alter a CHECK, so the table is rebuilt. NOT the textbook rebuild: DROP TABLE native_grants
-- performs an implicit DELETE that fires native_locations' ON DELETE CASCADE (deferring foreign keys does
-- not stop it), which would erase every buffered location point. So the points are copied aside first and
-- restored after the rename. native_locations' REFERENCES native_grants(id) is by name and resolves to the
-- rebuilt table. The two revocation triggers from 0134 (on apps and per_app_deleted_users) name native_grants
-- in their bodies, and D1 refuses the RENAME while they point at a missing table ("error in trigger
-- native_revoke_on_publisher_change: no such table"), so they are dropped first and recreated verbatim.
-- Proven on workerd + real D1 by packages/runtime-tests/test/backend/native-registry-migration.test.ts.
--
-- Rollback: the same rebuild with the old CHECK(capability = 'location.background'), copying only
-- location.background rows into the new table (and restoring native_locations only for grants that remain).
CREATE TABLE native_locations_keep AS SELECT * FROM native_locations;
CREATE TABLE native_grants_new (
  id TEXT PRIMARY KEY,
  device_id TEXT NOT NULL REFERENCES native_devices(id) ON DELETE CASCADE,
  app_id TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  publisher_id TEXT NOT NULL,
  capability TEXT NOT NULL CHECK(length(capability) BETWEEN 3 AND 64 AND capability NOT GLOB '*[^a-z_.]*'),
  contract_version TEXT NOT NULL,
  consent_at INTEGER NOT NULL,
  UNIQUE(device_id, app_id, capability)
);
INSERT INTO native_grants_new (id, device_id, app_id, publisher_id, capability, contract_version, consent_at)
  SELECT id, device_id, app_id, publisher_id, capability, contract_version, consent_at FROM native_grants;
DROP TRIGGER native_revoke_on_publisher_change;
DROP TRIGGER native_revoke_on_app_account_delete;
DROP TABLE native_grants;
ALTER TABLE native_grants_new RENAME TO native_grants;
-- 0134's triggers, unchanged: irreversible revocations, not filters that could resurrect consent on a later rollback.
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
INSERT INTO native_locations (grant_id, point_id, recorded_at, latitude, longitude, accuracy)
  SELECT grant_id, point_id, recorded_at, latitude, longitude, accuracy FROM native_locations_keep;
DROP TABLE native_locations_keep;
