-- Audit record for zero-transfer clawback settlements (#85 item c).
--
-- When a developer's outstanding refund debt (developer_clawbacks) is at least
-- the month's earnings, the payout cron moves no money: it stamps the
-- engagements as paid and reduces the debt. Nothing else recorded that. The
-- service_payouts table cannot hold it because `stripe_transfer_id` is NOT NULL
-- and no transfer happened, so the only trace was the cron's JSON response.
--
-- One row per developer per month, mirroring service_payouts: the cron checks
-- for an existing row before settling, so a re-run in the same month leaves the
-- engagements for next month instead of consuming them with no record.
CREATE TABLE IF NOT EXISTS clawback_settlements (
  id                       TEXT PRIMARY KEY,
  developer_id             TEXT NOT NULL,
  payout_month             TEXT NOT NULL,   -- YYYY-MM
  -- Earnings consumed against the debt this month (no transfer was made).
  clawback_cents           INTEGER NOT NULL,
  -- Debt still outstanding after this settlement; carried to the next payout.
  remaining_clawback_cents INTEGER NOT NULL,
  engagement_count         INTEGER NOT NULL,
  created_at               INTEGER NOT NULL
);

-- Idempotency: one settlement per developer per month.
CREATE UNIQUE INDEX IF NOT EXISTS idx_clawback_settlements_dev_month
  ON clawback_settlements(developer_id, payout_month);
CREATE INDEX IF NOT EXISTS idx_clawback_settlements_month
  ON clawback_settlements(payout_month);
