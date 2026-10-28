-- App billing 2/3 (#508, epic #506): Stripe webhooks to per-subject entitlements, mirrored into the app's own D1.
-- Additive only. Builds on 0118 (purchases, products, prices).

-- What a purchase needs to be understood later, whatever the manifest says by then: the term it was sold under (so a
-- renewal is computed from the interval and grace the buyer paid for), the Stripe ids that route later events to it, and the
-- facts the events carry. A fact is only ever added or moved forward, never recomputed from a clock: that is what makes
-- replays and out-of-order delivery safe (the entitlement is a pure function of these rows).
ALTER TABLE app_purchases ADD COLUMN interval_unit TEXT;
ALTER TABLE app_purchases ADD COLUMN interval_count INTEGER;
ALTER TABLE app_purchases ADD COLUMN grace_days INTEGER NOT NULL DEFAULT 0;
ALTER TABLE app_purchases ADD COLUMN stripe_subscription_id TEXT;
ALTER TABLE app_purchases ADD COLUMN stripe_customer_id TEXT;
ALTER TABLE app_purchases ADD COLUMN failed_at INTEGER;
ALTER TABLE app_purchases ADD COLUMN refunded_at INTEGER;
ALTER TABLE app_purchases ADD COLUMN sub_cancel_at_period_end INTEGER NOT NULL DEFAULT 0;
ALTER TABLE app_purchases ADD COLUMN sub_ended_at INTEGER;
ALTER TABLE app_purchases ADD COLUMN sub_event_at INTEGER NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS idx_app_purchases_subscription ON app_purchases (stripe_subscription_id);

-- One row per payment that bought time: a one-off checkout ('cs:<session>') or a paid invoice ('in:<invoice>'). The id is the
-- idempotency key: the same payment arriving twice, or in either order, is one row.
CREATE TABLE IF NOT EXISTS app_billing_payments (
  id TEXT PRIMARY KEY,
  purchase_id TEXT NOT NULL,
  paid_at INTEGER NOT NULL,
  amount INTEGER,
  currency TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_app_billing_payments_purchase ON app_billing_payments (purchase_id);

-- Stripe ids (payment intent, charge, invoice) that point back at a purchase, for events that carry none of our metadata
-- (a refund names a charge).
CREATE TABLE IF NOT EXISTS app_billing_payment_refs (
  ref TEXT PRIMARY KEY,
  purchase_id TEXT NOT NULL
);

-- Stripe event ids seen. `processed_at` is set only after the event is fully applied, so a failure is retried and a
-- redelivery of a processed event does nothing.
CREATE TABLE IF NOT EXISTS app_billing_events (
  event_id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  app_id TEXT,
  received_at INTEGER NOT NULL,
  processed_at INTEGER
);

-- The entitlement: one row per (app, product, subject). A product with no subject uses the empty string. This is the source of
-- truth; the app's own D1 holds a read-only mirror (`_pas_entitlements`). `version` rises on every change and the mirror only
-- accepts a newer one, so a late or retried push never overwrites newer state; `mirrored_version` < `version` marks a row the
-- sweep still has to push.
CREATE TABLE IF NOT EXISTS app_entitlements (
  app_id TEXT NOT NULL,
  product_key TEXT NOT NULL,
  subject TEXT NOT NULL,
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
  PRIMARY KEY (app_id, product_key, subject)
);
CREATE INDEX IF NOT EXISTS idx_app_entitlements_due ON app_entitlements (status, period_end);
CREATE INDEX IF NOT EXISTS idx_app_entitlements_dirty ON app_entitlements (app_id, mirrored_version, version);
