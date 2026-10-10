-- #358 correction: an admission is durable evidence before quota resolution,
-- but is executable only after the quota charge has succeeded. Existing rows
-- were created by the previous admitted-only implementation, so default them
-- to admitted without rewriting or deleting history.
ALTER TABLE provision_admissions ADD COLUMN status TEXT NOT NULL DEFAULT 'admitted'
  CHECK (status IN ('pending', 'admitted', 'denied', 'unavailable'));
ALTER TABLE provision_admissions ADD COLUMN status_updated_at INTEGER NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_provision_admissions_status_expiry
  ON provision_admissions(status, lease_expires_at);
