-- Opt-in cross-origin isolation (#452). Declared in an app's mcp.json (`isolation:
-- "cross-origin" | "cross-origin-strict"`), validated and replaced with its tools at
-- registration exactly like app_embed (0116) and app_visibility (0065). Read by the host when it
-- serves an HTML page or a script: the app's documents get COOP same-origin + a COEP, its scripts
-- (workers need it) get the COEP, and nothing else changes. No row means the default: not isolated.
CREATE TABLE IF NOT EXISTS app_isolation (
  app_id     TEXT PRIMARY KEY,
  mode       TEXT NOT NULL CHECK (mode IN ('cross-origin', 'cross-origin-strict')),
  created_at INTEGER NOT NULL
);
