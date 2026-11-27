-- #541: preserve existing recruitment unless the current owner closes it.
-- No row means accepting requests; this table never publishes a person's identity.
CREATE TABLE app_team_recruitment (
  app_id TEXT PRIMARY KEY REFERENCES apps(id) ON DELETE CASCADE,
  accepting_requests INTEGER NOT NULL CHECK (accepting_requests IN (0, 1)),
  updated_by TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
