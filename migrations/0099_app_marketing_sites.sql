-- Marketing-site publication is separate from app provisioning and listing copy.
-- Both gates start closed. A later trusted publishing workflow may activate a
-- revision only after verifying its immutable R2 artifact.
CREATE TABLE IF NOT EXISTS app_storefront_publication (
  app_id TEXT PRIMARY KEY REFERENCES apps(id) ON DELETE CASCADE,
  listed INTEGER NOT NULL DEFAULT 0 CHECK (listed IN (0, 1)),
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS app_marketing_sites (
  app_id TEXT PRIMARY KEY REFERENCES apps(id) ON DELETE CASCADE,
  active_revision TEXT,
  updated_at INTEGER NOT NULL
);
