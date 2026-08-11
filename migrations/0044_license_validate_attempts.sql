-- Fixed-window throttle bucket for POST /v1/license/validate (#86).
--
-- The endpoint is unauthenticated on purpose (apps validate a key without a
-- session), so every call is an anonymous D1 read and a license key is a bearer
-- credential someone can try to guess. Same shape as credential_login_attempts
-- (0029), which throttles the other unauthenticated credential path.
--
-- `key` is "<ip>:<app_id>", not the license key being validated: keying on the
-- credential would let a caller rotate keys for an unlimited budget, which is
-- precisely the guessing this bounds.
CREATE TABLE IF NOT EXISTS license_validate_attempts (
  key          TEXT PRIMARY KEY,
  window_start INTEGER NOT NULL,
  count        INTEGER NOT NULL
);

-- Sweeping expired windows is a full scan without this. Rows are tiny and
-- self-expiring in effect (a stale window is overwritten on the next attempt),
-- so a pruning pass is housekeeping rather than correctness.
CREATE INDEX IF NOT EXISTS idx_license_validate_attempts_window
  ON license_validate_attempts(window_start);
