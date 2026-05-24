-- App tool manifests registered via mcp.json during `pas publish`.
-- Each row is one tool for one app. The MCP server reads these to
-- dynamically register tools for AI agents.
CREATE TABLE IF NOT EXISTS app_tools (
  app_id TEXT NOT NULL,
  name TEXT NOT NULL,
  manifest TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (app_id, name)
);
