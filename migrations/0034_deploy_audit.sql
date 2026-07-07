-- Audit trail for keyless deploy-credential mints (routes/deploy.ts).
-- One row per successful mint: which repo/ref/sha got scoped R2 creds for which
-- app, and when. Lets us answer "who deployed app X and when" and spot anomalies.

CREATE TABLE IF NOT EXISTS deploy_audit (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  app_id      TEXT    NOT NULL,
  repository  TEXT    NOT NULL,
  ref         TEXT    NOT NULL,
  sha         TEXT,
  prefix      TEXT    NOT NULL,
  minted_at   INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_deploy_audit_app ON deploy_audit (app_id, minted_at DESC);
