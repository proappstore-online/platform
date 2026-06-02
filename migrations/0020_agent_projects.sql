-- Index of agent-teams projects per owner. Each project is an isolated Durable
-- Object (keyed by slug = app id), so there's no way to enumerate a user's
-- projects from the DOs alone. This table is written by the agent-teams Worker
-- on project create and queried by GET /v1/projects to merge in-progress apps
-- into the creator console's app list.

CREATE TABLE IF NOT EXISTS agent_projects (
  slug       TEXT PRIMARY KEY,   -- = app id
  owner_id   TEXT NOT NULL,
  name       TEXT NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);

CREATE INDEX IF NOT EXISTS idx_agent_projects_owner ON agent_projects (owner_id);
