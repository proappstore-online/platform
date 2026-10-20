-- #437: the browser permissions each app will ask for, for its storefront listing.
--
-- declared_json: the app's mcp.json `permissions` ([{ id, reason? }]), replaced on
--   every registration.
-- detected_json: the catalogue ids the deploy pipeline found in the app's source
--   (@proappstore/compliance detectPermissions), replaced on every deploy that
--   reports.
-- The listing shows declared ∪ detected. An app with no row asks for nothing special.
CREATE TABLE IF NOT EXISTS app_permissions (
  app_id        TEXT PRIMARY KEY REFERENCES apps(id) ON DELETE CASCADE,
  declared_json TEXT NOT NULL DEFAULT '[]',
  detected_json TEXT NOT NULL DEFAULT '[]',
  declared_at   INTEGER,
  detected_at   INTEGER
);

-- Backfill (#437): what each app's current source uses, detected on 2026-10-20 from
-- every org app repo with the same detector, so existing listings show permissions
-- before their next deploy. Apps not listed here use none. A row is written only
-- for an app the registry knows.
INSERT OR IGNORE INTO app_permissions (app_id, declared_json, detected_json, detected_at)
  SELECT id, '[]', '["location","notifications"]', CAST(strftime('%s', 'now') AS INTEGER) * 1000 FROM apps WHERE id = 'dating';
INSERT OR IGNORE INTO app_permissions (app_id, declared_json, detected_json, detected_at)
  SELECT id, '[]', '["location","notifications","wake-lock"]', CAST(strftime('%s', 'now') AS INTEGER) * 1000 FROM apps WHERE id = 'doordrop';
INSERT OR IGNORE INTO app_permissions (app_id, declared_json, detected_json, detected_at)
  SELECT id, '[]', '["notifications"]', CAST(strftime('%s', 'now') AS INTEGER) * 1000 FROM apps WHERE id = 'interns';
INSERT OR IGNORE INTO app_permissions (app_id, declared_json, detected_json, detected_at)
  SELECT id, '[]', '["location"]', CAST(strftime('%s', 'now') AS INTEGER) * 1000 FROM apps WHERE id = 'loopride';
INSERT OR IGNORE INTO app_permissions (app_id, declared_json, detected_json, detected_at)
  SELECT id, '[]', '["microphone","camera","screen-capture","notifications"]', CAST(strftime('%s', 'now') AS INTEGER) * 1000 FROM apps WHERE id = 'meet';
INSERT OR IGNORE INTO app_permissions (app_id, declared_json, detected_json, detected_at)
  SELECT id, '[]', '["location"]', CAST(strftime('%s', 'now') AS INTEGER) * 1000 FROM apps WHERE id = 'meetup';
INSERT OR IGNORE INTO app_permissions (app_id, declared_json, detected_json, detected_at)
  SELECT id, '[]', '["microphone"]', CAST(strftime('%s', 'now') AS INTEGER) * 1000 FROM apps WHERE id = 'prolang';
INSERT OR IGNORE INTO app_permissions (app_id, declared_json, detected_json, detected_at)
  SELECT id, '[]', '["notifications"]', CAST(strftime('%s', 'now') AS INTEGER) * 1000 FROM apps WHERE id = 'stash';
INSERT OR IGNORE INTO app_permissions (app_id, declared_json, detected_json, detected_at)
  SELECT id, '[]', '["location"]', CAST(strftime('%s', 'now') AS INTEGER) * 1000 FROM apps WHERE id = 'tennis-clubs';
INSERT OR IGNORE INTO app_permissions (app_id, declared_json, detected_json, detected_at)
  SELECT id, '[]', '["notifications"]', CAST(strftime('%s', 'now') AS INTEGER) * 1000 FROM apps WHERE id = 'tradeport';
