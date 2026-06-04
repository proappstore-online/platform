-- Services marketplace: dev profiles, client balances, and the ledger.

-- Developer service profiles (extends the existing creator identity)
CREATE TABLE IF NOT EXISTS dev_profiles (
  creator_id        TEXT PRIMARY KEY,
  prompt_rate_cents  INTEGER NOT NULL DEFAULT 100,
  bio_services      TEXT,
  available         INTEGER NOT NULL DEFAULT 1,
  quality_score     REAL,
  avg_prompt_length INTEGER,
  median_response_time_ms INTEGER,
  completed_engagements INTEGER NOT NULL DEFAULT 0,
  avg_rating        REAL,
  rating_count      INTEGER NOT NULL DEFAULT 0,
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL
);

-- Client prepaid balances
CREATE TABLE IF NOT EXISTS client_balances (
  user_id             TEXT PRIMARY KEY,
  balance_cents       INTEGER NOT NULL DEFAULT 0,
  total_deposited_cents INTEGER NOT NULL DEFAULT 0,
  total_spent_cents   INTEGER NOT NULL DEFAULT 0,
  stripe_customer_id  TEXT,
  created_at          INTEGER NOT NULL,
  updated_at          INTEGER NOT NULL
);

-- Balance transactions (deposits + charges, immutable ledger)
CREATE TABLE IF NOT EXISTS balance_transactions (
  id                      TEXT PRIMARY KEY,
  user_id                 TEXT NOT NULL,
  type                    TEXT NOT NULL,
  amount_cents            INTEGER NOT NULL,
  engagement_id           TEXT,
  stripe_payment_intent_id TEXT,
  description             TEXT,
  created_at              INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_balance_tx_user ON balance_transactions(user_id, created_at);
