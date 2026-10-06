-- #253 (ADR-009): app workers — per-app server code the platform deploys and invokes.
--
-- Additive only: three new tables, nothing existing is altered. Every row starts
-- disabled; `enabled` is the admin-set `app_workers_enabled` flag (first-party
-- apps only, at most 5 enabled, enforced by routes/app-workers.ts).
--
-- Secrets are never stored in plaintext. PAS_WORKER_TOKEN is kept as its SHA-256
-- (`token_hash`, what PAS calls are checked against, #254) and sealed under
-- APP_SECRET_KEK (`token_*`, lib/encryption.ts), because the loader backend must
-- hand the plaintext to the worker on every cold load. PAS_EVENT_KEY is sealed
-- the same way. The `prev_*` columns hold the previous credential during the
-- 10-minute rotation overlap.
--
-- Rows are never deleted: `config_version` is part of the loader's isolate ID
-- and must only grow (lib/app-worker-host.ts `loaderId`).
CREATE TABLE IF NOT EXISTS app_workers (
  app_id            TEXT PRIMARY KEY,
  enabled           INTEGER NOT NULL DEFAULT 0,
  backend           TEXT,
  script_name       TEXT,
  token_hash        TEXT,
  token_ct          BLOB, token_dek BLOB, token_iv BLOB,
  prev_token_hash   TEXT, prev_token_until INTEGER,
  config_version    INTEGER NOT NULL DEFAULT 1,
  event_key_ct      BLOB, event_key_dek BLOB, event_key_iv BLOB,
  prev_event_key_ct BLOB, prev_event_key_dek BLOB, prev_event_key_iv BLOB, prev_key_until INTEGER,
  bundle_sha256     TEXT,
  deployed_sha      TEXT, deployed_ref TEXT, deployed_at INTEGER,
  enabled_by        TEXT, enabled_at INTEGER
);

-- One row per deploy attempt that passed OIDC verification, refused or not.
CREATE TABLE IF NOT EXISTS app_worker_deploys (
  id TEXT PRIMARY KEY, app_id TEXT NOT NULL, repository TEXT NOT NULL, ref TEXT, sha TEXT,
  bundle_sha256 TEXT, status TEXT NOT NULL, detail TEXT, created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_app_worker_deploys_app ON app_worker_deploys (app_id, created_at DESC);

-- One row per invocation, inserted `running` before the worker is called.
-- id = '<envelope id>:<attempt>'. Pruned after 30 days (routes/logs-prune.ts).
CREATE TABLE IF NOT EXISTS app_worker_invocations (
  id TEXT PRIMARY KEY, app_id TEXT NOT NULL, event_id TEXT NOT NULL, type TEXT NOT NULL, name TEXT,
  attempt INTEGER NOT NULL, status TEXT NOT NULL,
  http_status INTEGER, body_excerpt TEXT,
  pas_calls INTEGER NOT NULL DEFAULT 0, started_at INTEGER NOT NULL, finished_at INTEGER, error TEXT
);
CREATE INDEX IF NOT EXISTS idx_app_worker_invocations_app ON app_worker_invocations (app_id, started_at DESC);
