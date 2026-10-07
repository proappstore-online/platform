-- #258: the GitHub connector. Additive only: three new tables.
--
-- app_connectors: the mcp.json `connectors` section, replaced with the manifest
--   (like app_hooks). modes/events are JSON arrays; `hook` names an app_hooks row
--   whose verify kind is github-app.
-- app_connector_installations: which GitHub App installations an app has bound.
--   Written only by the setup callback after it proves the signed-in user controls
--   the installation; it survives a re-publish (it is not part of the manifest).
--   The platform webhook endpoint routes by installation_id (idx below).
-- github_installation_tokens: the encrypted installation-token cache, one row per
--   (installation, scope); scope is '' for an unscoped token or 'owner/name'.
--   A token minted for one repo must never answer a request for another.
--   expires_at is epoch milliseconds; the sealed token is envelope-encrypted
--   under APP_SECRET_KEK (lib/encryption.ts).
CREATE TABLE IF NOT EXISTS app_connectors (
  app_id      TEXT NOT NULL,
  name        TEXT NOT NULL,
  kind        TEXT NOT NULL,
  modes       TEXT NOT NULL,
  pat_secret  TEXT,
  events      TEXT NOT NULL,
  hook        TEXT,
  created_at  INTEGER NOT NULL,
  PRIMARY KEY (app_id, name)
);

CREATE TABLE IF NOT EXISTS app_connector_installations (
  app_id          TEXT NOT NULL,
  connector       TEXT NOT NULL,
  installation_id INTEGER NOT NULL,
  account_login   TEXT NOT NULL,
  account_type    TEXT NOT NULL,
  created_by      TEXT NOT NULL,
  created_at      INTEGER NOT NULL,
  PRIMARY KEY (app_id, connector, installation_id)
);
CREATE INDEX IF NOT EXISTS idx_app_connector_installations_installation ON app_connector_installations (installation_id);

CREATE TABLE IF NOT EXISTS github_installation_tokens (
  installation_id INTEGER NOT NULL,
  scope           TEXT NOT NULL DEFAULT '',
  token_ct        BLOB NOT NULL,
  token_dek       BLOB NOT NULL,
  token_iv        BLOB NOT NULL,
  expires_at      INTEGER NOT NULL,
  PRIMARY KEY (installation_id, scope)
);
