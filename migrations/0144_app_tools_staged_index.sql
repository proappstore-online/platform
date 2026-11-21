-- Refs #609: the MCP asks for an app's staged actions on every app tool call
-- (GET /v1/apps/:appId/tools?state=staged). Through the (app_id, name) primary key
-- that read walked every action of the app, about 250-320 rows per call for the
-- large apps, to find the few (usually zero) that are staged. This partial index
-- holds only staged rows. Additive only.
CREATE INDEX IF NOT EXISTS idx_app_tools_staged
  ON app_tools (app_id, name) WHERE state = 'staged';
