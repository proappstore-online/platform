-- #351: room authorization and worker publishing.
--
-- app_room_rules: the `rooms` section of an app's mcp.json. A room whose id
-- starts with `prefix` (e.g. `chat:`) admits a signed-in user only when the
-- registered query action `authorize` returns a row for them. Replaced with the
-- manifest on every registration. Rooms matching no rule stay open, as before.
CREATE TABLE IF NOT EXISTS app_room_rules (
  app_id     TEXT    NOT NULL,
  prefix     TEXT    NOT NULL,
  authorize  TEXT    NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (app_id, prefix)
);

-- app_room_publish_usage: one fixed one-minute window per app for app-worker
-- publishes (`PAS.rooms.publish`), claimed atomically per publish.
CREATE TABLE IF NOT EXISTS app_room_publish_usage (
  app_id       TEXT    PRIMARY KEY,
  window_start INTEGER NOT NULL,
  count        INTEGER NOT NULL
);
