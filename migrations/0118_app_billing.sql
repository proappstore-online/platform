-- App products & purchases (#507, epic #506). Purely additive: new tables only.
--
-- app_billing / app_products are the `billing` section of an app's mcp.json, replaced with its
-- tools at registration (like app_embed 0116). A product dropped from the manifest is kept with
-- active = 0, never deleted, so its Stripe ids survive a later re-add and Stripe is never touched.
-- app_product_prices holds the Stripe Price ids ("a place for the price ids"): one active row per
-- (product, kind); a changed amount inserts version + 1 and retires the old row (Stripe prices are
-- immutable), archived = 1 once Stripe has archived it.
-- purchases is written by checkout (pending) and advanced by the webhook work in #508.
-- billing_customers maps a platform user to their one Stripe Customer for app purchases.
CREATE TABLE IF NOT EXISTS app_billing (
  app_id           TEXT PRIMARY KEY,
  authorize_action TEXT NOT NULL,
  updated_at       INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS app_products (
  app_id            TEXT NOT NULL,
  product_key       TEXT NOT NULL,
  name              TEXT NOT NULL,
  amount            INTEGER NOT NULL,
  currency          TEXT NOT NULL,
  tax_behavior      TEXT NOT NULL DEFAULT 'unspecified',
  modes             TEXT NOT NULL,
  interval_unit     TEXT,
  interval_count    INTEGER,
  grace_days        INTEGER NOT NULL DEFAULT 0,
  subject           TEXT NOT NULL DEFAULT 'none',
  active            INTEGER NOT NULL DEFAULT 1,
  stripe_product_id TEXT,
  stripe_name       TEXT,
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL,
  PRIMARY KEY (app_id, product_key)
);

CREATE TABLE IF NOT EXISTS app_product_prices (
  app_id          TEXT NOT NULL,
  product_key     TEXT NOT NULL,
  kind            TEXT NOT NULL CHECK (kind IN ('one_time', 'recurring')),
  version         INTEGER NOT NULL,
  stripe_price_id TEXT NOT NULL,
  amount          INTEGER NOT NULL,
  currency        TEXT NOT NULL,
  tax_behavior    TEXT NOT NULL,
  interval_unit   TEXT,
  interval_count  INTEGER,
  active          INTEGER NOT NULL DEFAULT 1,
  archived        INTEGER NOT NULL DEFAULT 0,
  created_at      INTEGER NOT NULL,
  PRIMARY KEY (app_id, product_key, kind, version)
);
CREATE INDEX IF NOT EXISTS idx_app_product_prices_pending_archive ON app_product_prices(active, archived);

CREATE TABLE IF NOT EXISTS purchases (
  id                     TEXT PRIMARY KEY,
  app_id                 TEXT NOT NULL,
  product_key            TEXT NOT NULL,
  buyer_user_id          TEXT NOT NULL,
  -- JSON array of opaque app-side subject ids. App data: kept here, never in Stripe metadata.
  subjects               TEXT NOT NULL,
  quantity               INTEGER NOT NULL,
  renew                  INTEGER NOT NULL DEFAULT 0,
  mode                   TEXT NOT NULL,
  -- 'pending' at checkout; #508 advances it. Deliberately no CHECK: SQLite cannot widen one later.
  status                 TEXT NOT NULL DEFAULT 'pending',
  stripe_price_id        TEXT,
  stripe_session_id      TEXT,
  stripe_customer_id     TEXT,
  stripe_subscription_id TEXT,
  created_at             INTEGER NOT NULL,
  updated_at             INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_purchases_app_buyer ON purchases(app_id, buyer_user_id);
CREATE INDEX IF NOT EXISTS idx_purchases_session ON purchases(stripe_session_id);

CREATE TABLE IF NOT EXISTS billing_customers (
  user_id            TEXT PRIMARY KEY,
  stripe_customer_id TEXT NOT NULL,
  created_at         INTEGER NOT NULL
);
