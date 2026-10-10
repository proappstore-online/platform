-- #358: the durable receipt admission consumes quota once. The matching
-- /v1/provision request atomically claims this lease, so it cannot charge a
-- second time or run the same remote provisioning attempt concurrently.
CREATE TABLE IF NOT EXISTS provision_admissions (
  operation_id    TEXT PRIMARY KEY,
  creator_id      TEXT NOT NULL,
  app_id          TEXT NOT NULL,
  intent_hash     TEXT NOT NULL,
  attempt_id      TEXT NOT NULL,
  lease_expires_at INTEGER NOT NULL,
  created_at      INTEGER NOT NULL,
  claimed_at      INTEGER,
  UNIQUE (app_id, attempt_id)
);

CREATE INDEX IF NOT EXISTS idx_provision_admissions_expiry
  ON provision_admissions(lease_expires_at);
