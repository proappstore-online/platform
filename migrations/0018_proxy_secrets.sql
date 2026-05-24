-- Proxy, secrets, and allowlist tables — vendored from FAS.
-- PAS owns its own copy so proxy/secrets work without cross-store dependency.

CREATE TABLE IF NOT EXISTS app_secrets (
  app_id          TEXT NOT NULL,
  name            TEXT NOT NULL,
  key_ciphertext  BLOB NOT NULL,
  dek_wrapped     BLOB NOT NULL,
  iv              BLOB NOT NULL,
  created_at      INTEGER NOT NULL,
  last_used_at    INTEGER,
  PRIMARY KEY (app_id, name)
);

CREATE TABLE IF NOT EXISTS app_proxy_allowlist (
  app_id        TEXT NOT NULL,
  pattern       TEXT NOT NULL,
  inject_kind   TEXT NOT NULL,
  inject_name   TEXT NOT NULL,
  secret_name   TEXT NOT NULL,
  secret_name_2 TEXT,
  token_url     TEXT,
  methods       TEXT NOT NULL,
  created_at    INTEGER NOT NULL,
  PRIMARY KEY (app_id, pattern)
);

CREATE INDEX IF NOT EXISTS app_proxy_allowlist_app_idx ON app_proxy_allowlist (app_id);

CREATE TABLE IF NOT EXISTS app_proxy_usage (
  app_id        TEXT NOT NULL,
  day           TEXT NOT NULL,
  count         INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (app_id, day)
);
