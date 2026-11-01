-- App billing test-mode isolation (#519, issue proappstore-online/platform#519): a second, explicitly selected
-- Stripe identity for test-mode checkout, structurally separated everywhere money, customers, products,
-- purchases and entitlements are keyed. Additive only: every existing row defaults to 'live' and keeps
-- behaving exactly as it did before this migration. Ops provisioning is tracked separately in
-- serge-ivo/ops#34 (secret names: STRIPE_TEST_SECRET_KEY, STRIPE_TEST_WEBHOOK_SECRET — see docs/app-billing.md).

-- The admin's Stripe-mode switch, alongside the existing `enabled` switch. Switching is refused while
-- `enabled = 1` (routes/app-billing-account.ts): the admin disables billing first, so a mode change is never
-- made under live checkout traffic.
ALTER TABLE app_billing ADD COLUMN stripe_env TEXT NOT NULL DEFAULT 'live' CHECK (stripe_env IN ('live', 'test'));
ALTER TABLE app_billing ADD COLUMN stripe_env_updated_at INTEGER;
ALTER TABLE app_billing ADD COLUMN stripe_env_updated_by TEXT;

-- A Price belongs to one Stripe mode's data (live and test are different Stripe object namespaces, even
-- within the same account): the same (app, product, mode) may have one active live price AND one active
-- test price at once. Existing rows are 'live', unchanged.
ALTER TABLE app_billing_prices ADD COLUMN stripe_env TEXT NOT NULL DEFAULT 'live' CHECK (stripe_env IN ('live', 'test'));
DROP INDEX IF EXISTS idx_app_billing_prices_product;
CREATE INDEX IF NOT EXISTS idx_app_billing_prices_product ON app_billing_prices (app_id, product_key, mode, stripe_env, status);

-- Test mode's own Stripe Product linkage, kept off app_billing_products entirely: a test-mode sync never
-- writes app_billing_products' stripe_product_id / stripe_name / sync_error, whichever env is active.
CREATE TABLE IF NOT EXISTS app_billing_products_test (
  app_id TEXT NOT NULL,
  product_key TEXT NOT NULL,
  stripe_product_id TEXT,
  stripe_name TEXT,
  sync_error TEXT,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (app_id, product_key)
);

-- A purchase is forever of the mode it was bought under: stamped at checkout from app_billing's stripe_env
-- at that moment (routes/app-billing.ts), never re-derived, so a later mode switch cannot reclassify history.
ALTER TABLE app_purchases ADD COLUMN stripe_env TEXT NOT NULL DEFAULT 'live' CHECK (stripe_env IN ('live', 'test'));
CREATE INDEX IF NOT EXISTS idx_app_purchases_env ON app_purchases (app_id, stripe_env);

-- A Stripe Customer id only exists within the mode that created it: a live customer id is meaningless (or a
-- collision risk) to the test-mode API. Rebuilt for a composite key (user_id, stripe_env); every existing
-- row is a live customer and keeps its id.
-- Rollback: rebuild again keyed by user_id alone, keeping only the 'live' rows.
CREATE TABLE billing_customers_new (
  user_id TEXT NOT NULL,
  stripe_env TEXT NOT NULL DEFAULT 'live' CHECK (stripe_env IN ('live', 'test')),
  stripe_customer_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, stripe_env)
);
INSERT INTO billing_customers_new (user_id, stripe_env, stripe_customer_id, created_at)
  SELECT user_id, 'live', stripe_customer_id, created_at FROM billing_customers;
DROP TABLE billing_customers;
ALTER TABLE billing_customers_new RENAME TO billing_customers;

-- An entitlement is scoped to the mode its purchase was bought under (the load-bearing change for mirror
-- isolation, #519): rebuilt for a composite key (app_id, product_key, subject, stripe_env), so a synthetic
-- test-mode purchase can never compute into, or overwrite, the live entitlement of the same subject.
-- Rollback: rebuild again keyed without stripe_env, keeping only the 'live' rows.
CREATE TABLE app_entitlements_new (
  app_id TEXT NOT NULL,
  product_key TEXT NOT NULL,
  subject TEXT NOT NULL,
  stripe_env TEXT NOT NULL DEFAULT 'live' CHECK (stripe_env IN ('live', 'test')),
  status TEXT NOT NULL CHECK (status IN ('active', 'grace', 'expired', 'refunded', 'canceled')),
  period_start INTEGER,
  period_end INTEGER,
  grace_until INTEGER,
  renews INTEGER NOT NULL DEFAULT 0 CHECK (renews IN (0, 1)),
  buyer_user_id TEXT,
  purchase_id TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  mirrored_version INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (app_id, product_key, subject, stripe_env)
);
INSERT INTO app_entitlements_new
  (app_id, product_key, subject, stripe_env, status, period_start, period_end, grace_until, renews, buyer_user_id, purchase_id, version, mirrored_version, created_at, updated_at)
  SELECT app_id, product_key, subject, 'live', status, period_start, period_end, grace_until, renews, buyer_user_id, purchase_id, version, mirrored_version, created_at, updated_at
  FROM app_entitlements;
DROP TABLE app_entitlements;
ALTER TABLE app_entitlements_new RENAME TO app_entitlements;
CREATE INDEX IF NOT EXISTS idx_app_entitlements_due ON app_entitlements (status, period_end);
CREATE INDEX IF NOT EXISTS idx_app_entitlements_dirty ON app_entitlements (app_id, mirrored_version, version);

-- Audit only: which secret verified a webhook event. Nullable — an event recorded before this migration
-- carries none, and nothing reads this column as a correctness check (the purchase's own stripe_env is).
ALTER TABLE app_billing_events ADD COLUMN stripe_env TEXT;
