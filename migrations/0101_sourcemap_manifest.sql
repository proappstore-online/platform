-- #393 (ADR-008 decision 7): one row per uploaded browser source-map release.
--
-- The bundle itself lives in the PRIVATE `STORAGE` bucket at `storage_key`
-- (`_sourcemaps/{app_id}/{commit_sha}/…`), never in the public `pas-apps`
-- bucket. Symbolication looks a release up by the event's exact `build.sha`
-- (= commit_sha) and checks `asset_digest`; it never falls back to another
-- release. A release is uploaded once (UNIQUE below) and kept until
-- `expires_at` (uploaded_at + 30 days, the log-detail retention), after which
-- it reads as `unavailable`.
CREATE TABLE IF NOT EXISTS release_sourcemap_manifests (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  app_id        TEXT    NOT NULL,
  commit_sha    TEXT    NOT NULL, -- immutable: VITE_COMMIT_SHA at build time, the SDK's build.sha
  asset_digest  TEXT    NOT NULL, -- sha256 hex of the uploaded source-map bundle
  storage_key   TEXT    NOT NULL, -- R2 key in the private STORAGE bucket
  uploaded_at   INTEGER NOT NULL, -- epoch ms
  expires_at    INTEGER NOT NULL, -- epoch ms: uploaded_at + 30 days
  status        TEXT    NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'expired')),
  UNIQUE (app_id, commit_sha)     -- also the (app_id, commit_sha) lookup index
);
-- The retention sweep finds expired releases by time across all apps.
CREATE INDEX IF NOT EXISTS idx_release_sourcemap_expires ON release_sourcemap_manifests (expires_at);
