-- Refs #686 (Phase 1): an app ID that was renamed away is retired, never freed.
-- 0150 left `loopride.proappstore.online` as a NON-canonical alias of rideshare,
-- and 0136 reserves only canonical ones, so `loopride` was claimable: a new app
-- would win the host from the alias and inherit the old app's links.
-- `appClaim` (build-core) refuses a retired ID before any side effect; these
-- triggers enforce it for every writer, as 0136 does for canonical hosts.
CREATE TABLE app_id_retirements (
  old_id     TEXT PRIMARY KEY,
  new_id     TEXT NOT NULL,
  retired_at INTEGER NOT NULL,
  reason     TEXT NOT NULL
);

-- No row may be inserted under a retired ID. An UPDATE may move a row back to a
-- retired ID only from the app it was retired to (OLD = new_id): that is how a
-- rename is rolled back. NEW.id is the retired ID itself, so it cannot be the test.
CREATE TRIGGER app_id_retired_app_insert BEFORE INSERT ON apps
WHEN EXISTS (SELECT 1 FROM app_id_retirements WHERE old_id = NEW.id)
BEGIN SELECT RAISE(ABORT, 'app ID retired'); END;
CREATE TRIGGER app_id_retired_app_update BEFORE UPDATE OF id ON apps
WHEN EXISTS (SELECT 1 FROM app_id_retirements WHERE old_id = NEW.id AND new_id <> OLD.id)
BEGIN SELECT RAISE(ABORT, 'app ID retired'); END;

CREATE TRIGGER app_id_retired_route_insert BEFORE INSERT ON routes
WHEN NEW.zone = 'proappstore.online' AND EXISTS (SELECT 1 FROM app_id_retirements WHERE old_id = NEW.slug)
BEGIN SELECT RAISE(ABORT, 'app ID retired'); END;
CREATE TRIGGER app_id_retired_route_update BEFORE UPDATE OF slug, zone ON routes
WHEN NEW.zone = 'proappstore.online' AND EXISTS (SELECT 1 FROM app_id_retirements WHERE old_id = NEW.slug AND new_id <> OLD.slug)
BEGIN SELECT RAISE(ABORT, 'app ID retired'); END;

-- Fail closed if `loopride` was claimed again between 0150 and now: retiring an
-- ID that a live app holds is a decision for an operator, not a migration.
CREATE TABLE _app_id_retirement_check (valid INTEGER CONSTRAINT no_live_retired_ids CHECK (valid = 1));
INSERT INTO _app_id_retirement_check (valid)
SELECT NOT EXISTS (SELECT 1 FROM apps WHERE id = 'loopride')
   AND NOT EXISTS (SELECT 1 FROM routes WHERE zone = 'proappstore.online' AND slug = 'loopride');
DROP TABLE _app_id_retirement_check;

INSERT INTO app_id_retirements (old_id, new_id, retired_at, reason)
VALUES ('loopride', 'rideshare', 1795564800000, 'renamed to rideshare by migration 0150 (#670)');
