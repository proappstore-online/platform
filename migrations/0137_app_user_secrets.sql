-- Refs #587: per-user app secrets (BYO keys). Additive only.
--
-- A user's own API key for one app, sealed like app_secrets (envelope AES-256-GCM
-- under APP_SECRET_KEK) plus AES-GCM associated data "app_id|user_id|name", so a
-- row copied to another user or app fails to decrypt. Write-only: no route returns
-- a value. Deleted with the user's account in the app and with the app.
CREATE TABLE IF NOT EXISTS app_user_secrets (
  app_id          TEXT NOT NULL,
  user_id         TEXT NOT NULL,
  name            TEXT NOT NULL,
  key_ciphertext  BLOB NOT NULL,
  dek_wrapped     BLOB NOT NULL,
  iv              BLOB NOT NULL,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL,
  last_used_at    INTEGER,
  PRIMARY KEY (app_id, user_id, name)
);

-- The names an app accepts, from mcp.json `user_secrets`. Replaced with the
-- manifest on every registration; a write to an undeclared name is refused.
CREATE TABLE IF NOT EXISTS app_user_secret_decls (
  app_id       TEXT NOT NULL,
  name         TEXT NOT NULL,
  label        TEXT NOT NULL,
  description  TEXT NOT NULL,
  created_at   INTEGER NOT NULL,
  PRIMARY KEY (app_id, name)
);

-- Which secret a proxy rule injects: the app's (app_secrets, every existing rule)
-- or the calling user's own (app_user_secrets).
ALTER TABLE app_proxy_allowlist ADD COLUMN secret_scope TEXT NOT NULL DEFAULT 'app' CHECK (secret_scope IN ('app', 'user'));
