-- Queue creation time (`started_at`) is not the same as executor ownership
-- time. Stale-run recovery must use this claim timestamp so old queued runs are
-- not marked timed out immediately after being claimed.
ALTER TABLE app_test_runs ADD COLUMN claimed_at INTEGER;
