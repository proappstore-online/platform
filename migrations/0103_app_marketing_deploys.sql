-- #399: one row per marketing-site artifact the trusted storefront workflow
-- uploads to R2 (marketing/<app_id>/revisions/<revision>/). The row is the
-- deploy receipt; app_marketing_sites.active_revision (0099) stays the only
-- serving pointer, and it changes only after the artifact is re-verified.
-- A revision is immutable: once uploaded, the same id cannot carry other bytes.
CREATE TABLE IF NOT EXISTS app_marketing_deploys (
  app_id TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  revision TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('uploading', 'uploaded', 'failed')),
  manifest_sha256 TEXT NOT NULL,
  file_count INTEGER NOT NULL,
  total_bytes INTEGER NOT NULL,
  repository TEXT NOT NULL,
  workflow_ref TEXT,
  run_id TEXT,
  commit_sha TEXT,
  error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  -- Last time this revision became the active one (activation or rollback).
  activated_at INTEGER,
  PRIMARY KEY (app_id, revision)
);
