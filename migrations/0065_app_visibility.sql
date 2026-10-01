-- Private apps (#259, part of #251). Declared in an app's mcp.json
-- (`visibility: { mode, roles }`), validated and replaced with its tools at
-- registration exactly like app_operator_gate (0060). Read by the host on every
-- request: a `private` app's whole origin — `/`, assets, /.pas/api/*,
-- /.pas/data/* — is served only to the app's owner and to holders of one of
-- `roles`; the backend applies the same check to actions, the per-app MCP and
-- the storefront listings.
--
-- No row (or mode 'public') means public: every app registered before this
-- migration keeps its behaviour.
CREATE TABLE IF NOT EXISTS app_visibility (
  app_id     TEXT PRIMARY KEY,
  mode       TEXT NOT NULL CHECK (mode IN ('public', 'private')),
  roles      TEXT NOT NULL DEFAULT '[]', -- JSON array of 0-5 app role names, never 'member'
  created_at INTEGER NOT NULL
);
