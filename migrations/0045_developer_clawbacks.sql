-- Unrecovered developer debt from refunds (#85).
--
-- A refund reverses the developer's share by decrementing
-- engagements.total_dev_earned_cents, which works only while the engagement is
-- still unpaid: the payout cron sums `WHERE payout_month IS NULL`, so once a row
-- has been settled the decrement writes a number the payout path never reads
-- again. Refund-after-payout therefore credited the client while the developer
-- kept the transfer, and the platform absorbed the difference.
--
-- This table is the ledger that survives that gap: the shortfall is recorded
-- against the DEVELOPER and netted from their next payout.
--
-- Why not a column on creator_payouts: that table requires a Stripe Connect
-- account (`stripe_connect_account_id TEXT NOT NULL UNIQUE`), so a developer who
-- has not onboarded — or has been refunded before onboarding — has no row to
-- carry the debt, and one cannot be created without inventing an account id.
-- Debt has to outlive both the engagement and the Connect account.
CREATE TABLE IF NOT EXISTS developer_clawbacks (
  developer_id           TEXT PRIMARY KEY,
  -- Always >= 0. Cents the developer was paid for work later refunded, not yet
  -- recovered. Reduced as future payouts absorb it; 0 means settled.
  pending_clawback_cents INTEGER NOT NULL DEFAULT 0,
  updated_at             INTEGER NOT NULL
);

-- The cron looks debt up per developer (primary key), but reconciliation and any
-- "who owes us" report wants the non-zero rows, which are a small minority.
CREATE INDEX IF NOT EXISTS idx_developer_clawbacks_outstanding
  ON developer_clawbacks(pending_clawback_cents)
  WHERE pending_clawback_cents > 0;
