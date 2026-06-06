-- Routes table: maps subdomain → R2 prefix for host Worker serving.
-- Same schema as fas/host and fgs/host (shared D1 pattern).

CREATE TABLE IF NOT EXISTS routes (
  slug       TEXT    NOT NULL,
  zone       TEXT    NOT NULL,
  r2_prefix  TEXT    NOT NULL,
  store      TEXT    NOT NULL,
  hosted_on  TEXT    NOT NULL DEFAULT 'r2',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (slug, zone)
);

CREATE INDEX IF NOT EXISTS idx_routes_store     ON routes(store);
CREATE INDEX IF NOT EXISTS idx_routes_hosted_on ON routes(hosted_on);
