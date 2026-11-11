-- Refs #574: canonical platform hostnames reserve their public slug atomically.
-- Provisioning already writes this shared host table. Ensure the exact existing
-- host baseline also exists on clean backend-only schemas before adding guards.
CREATE TABLE IF NOT EXISTS routes (
  slug TEXT NOT NULL,
  zone TEXT NOT NULL,
  r2_prefix TEXT NOT NULL,
  store TEXT NOT NULL,
  hosted_on TEXT NOT NULL DEFAULT 'r2',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (slug, zone)
);

-- Fail closed on pre-existing conflicts (including claims between migrations135
-- and136). This scratch assertion owns no user data and is removed immediately.
CREATE TABLE _canonical_alias_migration_check (valid INTEGER CONSTRAINT no_canonical_hostname_conflicts CHECK (valid = 1));
INSERT INTO _canonical_alias_migration_check (valid)
SELECT NOT EXISTS (
  SELECT 1 FROM app_custom_domains d WHERE d.status = 'active' AND d.canonical = 1 AND (
    EXISTS (SELECT 1 FROM apps a WHERE a.id || '.proappstore.online' = d.domain AND a.id <> d.app_id)
    OR EXISTS (SELECT 1 FROM routes r WHERE r.zone = 'proappstore.online' AND r.slug || '.proappstore.online' = d.domain AND r.slug <> d.app_id)
    OR EXISTS (SELECT 1 FROM app_custom_domains other WHERE other.domain = d.domain AND other.status = 'active' AND other.app_id <> d.app_id)
  )
);
DROP TABLE _canonical_alias_migration_check;

CREATE TRIGGER canonical_alias_app_insert BEFORE INSERT ON apps
WHEN EXISTS (SELECT 1 FROM app_custom_domains WHERE domain = NEW.id || '.proappstore.online' AND status = 'active' AND canonical = 1 AND app_id <> NEW.id)
BEGIN SELECT RAISE(ABORT, 'app ID reserved by canonical hostname'); END;
CREATE TRIGGER canonical_alias_app_update BEFORE UPDATE OF id ON apps
WHEN EXISTS (SELECT 1 FROM app_custom_domains WHERE domain = NEW.id || '.proappstore.online' AND status = 'active' AND canonical = 1 AND app_id <> NEW.id)
BEGIN SELECT RAISE(ABORT, 'app ID reserved by canonical hostname'); END;

CREATE TRIGGER canonical_alias_route_insert BEFORE INSERT ON routes
WHEN NEW.zone = 'proappstore.online' AND EXISTS (SELECT 1 FROM app_custom_domains WHERE domain = NEW.slug || '.proappstore.online' AND status = 'active' AND canonical = 1 AND app_id <> NEW.slug)
BEGIN SELECT RAISE(ABORT, 'app ID reserved by canonical hostname'); END;
CREATE TRIGGER canonical_alias_route_update BEFORE UPDATE OF slug, zone ON routes
WHEN NEW.zone = 'proappstore.online' AND EXISTS (SELECT 1 FROM app_custom_domains WHERE domain = NEW.slug || '.proappstore.online' AND status = 'active' AND canonical = 1 AND app_id <> NEW.slug)
BEGIN SELECT RAISE(ABORT, 'app ID reserved by canonical hostname'); END;

-- The reverse direction matters too: assigning/activating an alias cannot take
-- an existing app or route's public name, or shadow another canonical domain.
CREATE TRIGGER canonical_alias_domain_insert BEFORE INSERT ON app_custom_domains
WHEN NEW.status = 'active' AND (
  (NEW.canonical = 1 AND (
    EXISTS (SELECT 1 FROM apps WHERE id || '.proappstore.online' = NEW.domain AND id <> NEW.app_id)
    OR EXISTS (SELECT 1 FROM routes WHERE zone = 'proappstore.online' AND slug || '.proappstore.online' = NEW.domain AND slug <> NEW.app_id)))
  OR EXISTS (SELECT 1 FROM app_custom_domains WHERE domain = NEW.domain AND app_id <> NEW.app_id AND status = 'active' AND (canonical = 1 OR NEW.canonical = 1)))
BEGIN SELECT RAISE(ABORT, 'canonical hostname already reserved'); END;
CREATE TRIGGER canonical_alias_domain_update BEFORE UPDATE OF app_id, domain, status, canonical ON app_custom_domains
WHEN NEW.status = 'active' AND (
  (NEW.canonical = 1 AND (
    EXISTS (SELECT 1 FROM apps WHERE id || '.proappstore.online' = NEW.domain AND id <> NEW.app_id)
    OR EXISTS (SELECT 1 FROM routes WHERE zone = 'proappstore.online' AND slug || '.proappstore.online' = NEW.domain AND slug <> NEW.app_id)))
  OR EXISTS (SELECT 1 FROM app_custom_domains WHERE domain = NEW.domain AND app_id <> NEW.app_id AND status = 'active' AND (canonical = 1 OR NEW.canonical = 1)))
BEGIN SELECT RAISE(ABORT, 'canonical hostname already reserved'); END;
