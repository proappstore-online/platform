-- Maps each creator to their Stripe Connect Express account. Populated when a
-- creator first clicks "Connect Stripe" in the Console Payouts tab. The boolean
-- columns are cached from the Stripe Account object so the Console can render
-- status without hitting Stripe on every dashboard load — they're refreshed
-- whenever GET /v1/connect/status is called.
CREATE TABLE creator_payouts (
  creator_id TEXT PRIMARY KEY,                       -- gh:<id>
  stripe_connect_account_id TEXT NOT NULL UNIQUE,    -- acct_xxx
  charges_enabled INTEGER NOT NULL DEFAULT 0,
  payouts_enabled INTEGER NOT NULL DEFAULT 0,
  details_submitted INTEGER NOT NULL DEFAULT 0,
  country TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX idx_creator_payouts_account ON creator_payouts(stripe_connect_account_id);
