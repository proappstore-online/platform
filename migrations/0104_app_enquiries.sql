-- #412 (epic #411): enquiries sent from an app's about- marketing site. Stored in
-- the platform, per app, for the app owner only; never in the app's own data.
-- ip_hash (SHA-256 of app id + client IP) exists only for the per-IP rate limit.
CREATE TABLE IF NOT EXISTS app_enquiries (
  id TEXT PRIMARY KEY,
  app_id TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  email TEXT NOT NULL,
  message TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'handled')),
  ip_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  handled_at INTEGER,
  handled_by TEXT
);
CREATE INDEX IF NOT EXISTS idx_app_enquiries_app ON app_enquiries (app_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_app_enquiries_rate ON app_enquiries (app_id, ip_hash, created_at);
