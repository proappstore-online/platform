-- Monthly payout records for the services marketplace.
-- Each row represents a single developer payout for a given month.
-- The payout_month column (YYYY-MM) + developer_id is the idempotency key:
-- running the cron twice in the same month will not double-pay.

CREATE TABLE IF NOT EXISTS service_payouts (
  id                      TEXT PRIMARY KEY,
  developer_id            TEXT NOT NULL,
  payout_month            TEXT NOT NULL,          -- YYYY-MM
  amount_cents            INTEGER NOT NULL,
  engagement_count        INTEGER NOT NULL,
  stripe_transfer_id      TEXT NOT NULL,
  stripe_connect_account_id TEXT NOT NULL,
  created_at              INTEGER NOT NULL
);

-- Prevent double payouts: one payout per developer per month.
CREATE UNIQUE INDEX IF NOT EXISTS idx_service_payouts_dev_month
  ON service_payouts(developer_id, payout_month);

CREATE INDEX IF NOT EXISTS idx_service_payouts_month
  ON service_payouts(payout_month);

-- Track which month each engagement's earnings were paid out.
-- NULL means unpaid; set to YYYY-MM when the payout cron runs.
ALTER TABLE engagements ADD COLUMN payout_month TEXT;
