-- #358: a provisioning request can outlive its MCP/client response.  Keep a
-- durable, owner-bound receipt before the MCP worker performs any GitHub work
-- so a retry joins the same operation instead of treating the new repo as an
-- unknown orphan.
CREATE TABLE IF NOT EXISTS provision_operations (
  receipt_id   TEXT PRIMARY KEY,
  creator_id   TEXT NOT NULL,
  app_id       TEXT NOT NULL,
  status       TEXT NOT NULL CHECK (status IN ('pending', 'completed', 'failed')),
  steps_json   TEXT NOT NULL DEFAULT '[]',
  result_json  TEXT,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL,
  completed_at INTEGER,
  UNIQUE (creator_id, app_id),
  -- App ids are globally claimed. This also closes the race where two callers
  -- attempt to create the same as-yet-unclaimed GitHub repository.
  UNIQUE (app_id)
);

CREATE INDEX IF NOT EXISTS idx_provision_operations_owner_updated
  ON provision_operations(creator_id, updated_at DESC);
