-- Console operator-view contract (#240). Declared in an app's mcp.json
-- (`operator_view: { version, resources, actions }`), validated against the
-- app's registered tools and replaced with them at registration
-- (lib/operator-contract.ts), read by GET /v1/apps/:appId/operator for the
-- app's owner. No row = the app declares nothing and gets the baseline view.
CREATE TABLE IF NOT EXISTS app_operator_view (
  app_id     TEXT PRIMARY KEY,
  version    INTEGER NOT NULL,  -- contract version (1)
  contract   TEXT NOT NULL,     -- the validated, normalized contract JSON
  created_at INTEGER NOT NULL
);
