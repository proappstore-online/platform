-- Review uploads (#208): a user's private document that holders of the app's
-- declared reviewer roles may read, e.g. business-registration evidence.

-- Which app roles may review. Declared by the app team (admin); read on every
-- review request, never cached, so removing a role takes effect immediately.
CREATE TABLE IF NOT EXISTS app_storage_config (
  app_id       TEXT PRIMARY KEY,
  review_roles TEXT NOT NULL DEFAULT '[]', -- JSON array of app role names
  updated_by   TEXT NOT NULL,
  updated_at   INTEGER NOT NULL
);

-- Every read or delete of a review upload by someone other than its uploader,
-- written before the object is served: no unaudited reviewer access.
CREATE TABLE IF NOT EXISTS storage_review_access (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  app_id       TEXT NOT NULL,
  owner_id     TEXT NOT NULL,  -- the uploader
  path         TEXT NOT NULL,  -- path under the uploader's review namespace
  actor_id     TEXT NOT NULL,  -- the reviewer
  action       TEXT NOT NULL,  -- read | delete
  created_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_storage_review_access_app ON storage_review_access (app_id, created_at);
