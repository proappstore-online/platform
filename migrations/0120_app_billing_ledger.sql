-- App billing 3/3 (#509, epic #506): the per-app revenue ledger. Additive only.
--
-- What Stripe says about a charge, kept by charge id: the amount, what has been refunded of it (a running total, never lower), the
-- balance transaction that carries Stripe's fee, and the fee once it has been read. A charge is tied to an app purchase at READ time
-- through app_billing_payment_refs (payment intent, invoice or charge id), so the answer does not depend on whether the charge event
-- or the checkout event arrived first. Gross comes from app_billing_payments; this table adds refunds and fees.
CREATE TABLE IF NOT EXISTS app_billing_charges (
  charge_id TEXT PRIMARY KEY,
  payment_intent TEXT,
  invoice TEXT,
  amount INTEGER NOT NULL,
  currency TEXT NOT NULL,
  amount_refunded INTEGER NOT NULL DEFAULT 0,
  balance_transaction TEXT,
  fee INTEGER,
  fee_currency TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_app_billing_charges_pi ON app_billing_charges (payment_intent);
CREATE INDEX IF NOT EXISTS idx_app_billing_charges_invoice ON app_billing_charges (invoice);
CREATE INDEX IF NOT EXISTS idx_app_billing_charges_unfeed ON app_billing_charges (fee, balance_transaction);
