-- #428 follow-up (#429 sweep): an app's go-live is recorded, not derived.
--
-- Registration decided "is this app live?" from its current rows (a live code
-- action, or an enabled worker). Clearing an app's tools — DELETE …/tools, or a
-- deploy without mcp.json — erased that evidence, so the next deploy registered
-- every action staged and the app's users got 403 until the owner promoted.
--
-- went_live_at is set when the app worker is enabled or the owner promotes, and
-- never cleared by a deploy. Every app that exists today is live: #428 promised
-- existing apps would be unaffected, including the ones with no actions yet.
CREATE TABLE IF NOT EXISTS app_go_live (
  app_id       TEXT PRIMARY KEY REFERENCES apps(id) ON DELETE CASCADE,
  went_live_at INTEGER NOT NULL,
  went_live_by TEXT
);

INSERT OR IGNORE INTO app_go_live (app_id, went_live_at, went_live_by)
  SELECT id, CAST(strftime('%s', 'now') AS INTEGER) * 1000, 'migration-0109' FROM apps;
