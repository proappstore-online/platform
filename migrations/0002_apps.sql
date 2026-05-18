-- Track provisioned pro apps and their resources.
CREATE TABLE IF NOT EXISTS apps (
  id TEXT PRIMARY KEY,
  creator_id TEXT NOT NULL,
  d1_database_id TEXT,
  worker_name TEXT,
  pages_project TEXT,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_apps_creator ON apps(creator_id);
