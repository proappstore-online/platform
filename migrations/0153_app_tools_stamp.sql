-- Refs #609: the MCP re-reads an app's whole signed-out tool list (250-320 rows for
-- the large apps) every time its 10-second per-isolate cache lapses, which on
-- 24 Nov 2026 was 2,450 reads and 603K of the database's ~1.3M rows. This stamp
-- changes whenever any of the app's app_tools rows does, so the MCP can revalidate
-- its cached list with If-None-Match (a 1-row read) and refetch only on a change.
--
-- Triggers, not application code, keep it current: every write to app_tools
-- (register, promote, delete, console endpoints, an app-ID rename) changes the
-- stamp, and no write path can forget to. The stamp is random, not a counter, so a
-- deleted-and-recreated row can never repeat a value a cache still holds.
-- No OR REPLACE / ON CONFLICT in the trigger bodies: SQLite applies the OUTER
-- statement's conflict policy to them, and registration's upsert turned an
-- INSERT OR REPLACE here into a UNIQUE failure on D1. UPDATE, then INSERT if absent.
-- Additive only: no existing row or query changes.
CREATE TABLE IF NOT EXISTS app_tools_stamp (
  app_id TEXT PRIMARY KEY,
  stamp TEXT NOT NULL
);

-- Apps that already have actions get a stamp now, not at their next registration.
INSERT OR IGNORE INTO app_tools_stamp (app_id, stamp)
  SELECT app_id, lower(hex(randomblob(8))) FROM app_tools GROUP BY app_id;

CREATE TRIGGER IF NOT EXISTS app_tools_stamp_on_insert
AFTER INSERT ON app_tools
BEGIN
  UPDATE app_tools_stamp SET stamp = lower(hex(randomblob(8))) WHERE app_id = NEW.app_id;
  INSERT INTO app_tools_stamp (app_id, stamp) SELECT NEW.app_id, lower(hex(randomblob(8)))
    WHERE NOT EXISTS (SELECT 1 FROM app_tools_stamp WHERE app_id = NEW.app_id);
END;

CREATE TRIGGER IF NOT EXISTS app_tools_stamp_on_update
AFTER UPDATE ON app_tools
BEGIN
  UPDATE app_tools_stamp SET stamp = lower(hex(randomblob(8))) WHERE app_id = OLD.app_id;
  INSERT INTO app_tools_stamp (app_id, stamp) SELECT OLD.app_id, lower(hex(randomblob(8)))
    WHERE NOT EXISTS (SELECT 1 FROM app_tools_stamp WHERE app_id = OLD.app_id);
  UPDATE app_tools_stamp SET stamp = lower(hex(randomblob(8))) WHERE app_id = NEW.app_id;
  INSERT INTO app_tools_stamp (app_id, stamp) SELECT NEW.app_id, lower(hex(randomblob(8)))
    WHERE NOT EXISTS (SELECT 1 FROM app_tools_stamp WHERE app_id = NEW.app_id);
END;

CREATE TRIGGER IF NOT EXISTS app_tools_stamp_on_delete
AFTER DELETE ON app_tools
BEGIN
  UPDATE app_tools_stamp SET stamp = lower(hex(randomblob(8))) WHERE app_id = OLD.app_id;
  INSERT INTO app_tools_stamp (app_id, stamp) SELECT OLD.app_id, lower(hex(randomblob(8)))
    WHERE NOT EXISTS (SELECT 1 FROM app_tools_stamp WHERE app_id = OLD.app_id);
END;
