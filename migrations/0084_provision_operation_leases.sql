-- #358 follow-up: bind a receipt to its exact intent and give only one worker
-- a bounded, retry-acquired lease. Kept additive because 0083 is deployed.
ALTER TABLE provision_operations ADD COLUMN intent_hash TEXT NOT NULL DEFAULT '';
ALTER TABLE provision_operations ADD COLUMN attempt_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE provision_operations ADD COLUMN lease_expires_at INTEGER;
ALTER TABLE provision_operations ADD COLUMN attempt_id TEXT;

CREATE INDEX IF NOT EXISTS idx_provision_operations_lease
  ON provision_operations(status, lease_expires_at);
