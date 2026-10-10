-- #355/#356: re-enable only the safe broker revision.  0082 intentionally
-- retained the table but removed unsafe session-bearing rows.  The new columns
-- support an immutable machine public key, bounded encrypted-result retention,
-- and an enforced polling cadence.
ALTER TABLE mcp_remote_auth_requests ADD COLUMN machine_public_key TEXT;
ALTER TABLE mcp_remote_auth_requests ADD COLUMN result_expires_at INTEGER;
ALTER TABLE mcp_remote_auth_requests ADD COLUMN last_poll_at INTEGER;
ALTER TABLE mcp_remote_auth_requests ADD COLUMN approving_at INTEGER;
ALTER TABLE mcp_remote_auth_requests ADD COLUMN failure_code TEXT;
-- A provider callback is browser-bound by the existing OAuth state cookie;
-- this timestamp is audit/state-machine metadata only, never a credential.
ALTER TABLE mcp_remote_auth_requests ADD COLUMN callback_at INTEGER;
-- A redemption attempt ID distinguishes an explicit lost-response retry from a
-- competing redemption.  The machine must reuse the same high-entropy value
-- only when retrying an indeterminate request.
ALTER TABLE mcp_remote_auth_requests ADD COLUMN redeem_attempt_id TEXT;

CREATE INDEX IF NOT EXISTS idx_mcp_remote_auth_cleanup
  ON mcp_remote_auth_requests(status, result_expires_at);
