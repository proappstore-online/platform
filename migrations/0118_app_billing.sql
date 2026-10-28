-- App billing 1/3 (#507, epic #506): an app declares products in its manifest, the platform mirrors them to Stripe
-- and sells them through app-authorized checkout. The platform's single Stripe account; no app holds a key.

-- One row per app that has ever declared billing. `enabled` is the admin's switch for live money: OFF by default, and
-- re-registering a manifest never turns it on or off. `authorize_action` is the manifest's action (callers: ["billing"])
-- that decides who may buy; NULL when the manifest no longer declares billing.
CREATE TABLE IF NOT EXISTS app_billing (
  app_id TEXT PRIMARY KEY,
  authorize_action TEXT,
  enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- The declared products. A product the manifest stops declaring is deactivated, never deleted: its Stripe objects and any
-- purchase made against it stay, and declaring it again reuses them.
CREATE TABLE IF NOT EXISTS app_billing_products (
  app_id TEXT NOT NULL,
  product_key TEXT NOT NULL,
  name TEXT NOT NULL,
  amount INTEGER NOT NULL,
  currency TEXT NOT NULL,
  tax_behavior TEXT NOT NULL DEFAULT 'unspecified',
  modes TEXT NOT NULL,
  interval_unit TEXT,
  interval_count INTEGER,
  grace_days INTEGER NOT NULL DEFAULT 0,
  subject TEXT NOT NULL DEFAULT 'none',
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  stripe_product_id TEXT,
  stripe_name TEXT,
  sync_error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (app_id, product_key)
);

-- Every Stripe Price made for a product. At most one is active per (app, product, mode): a changed amount creates a new
-- Price and archives the old one, so an old receipt's price id still resolves.
CREATE TABLE IF NOT EXISTS app_billing_prices (
  stripe_price_id TEXT PRIMARY KEY,
  app_id TEXT NOT NULL,
  product_key TEXT NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('one_time', 'recurring')),
  amount INTEGER NOT NULL,
  currency TEXT NOT NULL,
  tax_behavior TEXT NOT NULL,
  interval_unit TEXT,
  interval_count INTEGER,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
  created_at INTEGER NOT NULL,
  archived_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_app_billing_prices_product ON app_billing_prices (app_id, product_key, mode, status);

-- A checkout the platform started: app, product, buyer, the opaque app-side subject ids (app data, so kept here and not in
-- Stripe metadata) and the Stripe session. Webhooks (#508) move it from pending.
CREATE TABLE IF NOT EXISTS app_purchases (
  id TEXT PRIMARY KEY,
  app_id TEXT NOT NULL,
  product_key TEXT NOT NULL,
  buyer_user_id TEXT NOT NULL,
  subjects TEXT NOT NULL DEFAULT '[]',
  quantity INTEGER NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('one_time', 'recurring')),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'paid', 'failed', 'canceled', 'refunded')),
  price_id TEXT,
  stripe_session_id TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_app_purchases_buyer ON app_purchases (app_id, buyer_user_id);
CREATE INDEX IF NOT EXISTS idx_app_purchases_session ON app_purchases (stripe_session_id);

-- One Stripe Customer per platform user across every app. A customer an earlier Pro subscription made is reused (see the route).
CREATE TABLE IF NOT EXISTS billing_customers (
  user_id TEXT PRIMARY KEY,
  stripe_customer_id TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
