-- #254 (ADR-009 §2): the `worker` section of an app's mcp.json, registered with
-- its tools and replaced with them like page_meta, operator_view and visibility.
-- `secrets` is a JSON array of app-secret names (app_secrets.name) the app's
-- worker may read through PAS.secrets.get; any other name reads as null.
-- Additive only: one new table.
CREATE TABLE IF NOT EXISTS app_worker_manifest (
  app_id     TEXT PRIMARY KEY,
  secrets    TEXT NOT NULL DEFAULT '[]',
  created_at INTEGER NOT NULL
);
