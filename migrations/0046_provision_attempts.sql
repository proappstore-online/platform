-- Fixed-window abuse counters for provisioning (#83).
--
-- Publishing is self-service by design — any signed-in GitHub account may
-- publish — but a single provision creates an org repo, a D1 database, a Worker,
-- DNS and a registry commit, and nothing bounded how fast one caller could drive
-- that loop. These are an abuse ceiling, not a product quota.
--
-- `key` is "<dimension>:<identity>:<window>", e.g. "user:gh:2824906:h" or
-- "ip:203.0.113.7:h". One row per bucket; a stale window is overwritten on the
-- next attempt, so rows are self-expiring in effect.
CREATE TABLE IF NOT EXISTS provision_attempts (
  key          TEXT PRIMARY KEY,
  window_start INTEGER NOT NULL,
  count        INTEGER NOT NULL
);

-- Sweeping expired windows is a full scan without this. Pruning is housekeeping
-- rather than correctness, for the reason above.
CREATE INDEX IF NOT EXISTS idx_provision_attempts_window
  ON provision_attempts(window_start);
