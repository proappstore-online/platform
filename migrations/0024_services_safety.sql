-- Safety constraints for services marketplace billing.

-- Prevent balance overdraft: the UPDATE conditional guard is the primary
-- defense; this CHECK is the backstop.
-- NOTE: D1/SQLite CHECK constraints on ALTER TABLE are not supported.
-- The guard is implemented in application code (conditional WHERE clause).

-- Prevent deposit double-credit via concurrent confirm calls.
CREATE UNIQUE INDEX IF NOT EXISTS idx_balance_tx_stripe_pi
  ON balance_transactions(stripe_payment_intent_id)
  WHERE stripe_payment_intent_id IS NOT NULL;
