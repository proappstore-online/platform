-- Refs #573: retain the app's stable identity and all rider data while publishing
-- one product name and canonical hostname. Exact active domains use the same
-- visibility, session audience and same-origin mediation as the original host.
ALTER TABLE app_custom_domains ADD COLUMN canonical INTEGER NOT NULL DEFAULT 0 CHECK (canonical IN (0, 1));
CREATE UNIQUE INDEX idx_app_custom_domains_canonical ON app_custom_domains(app_id) WHERE canonical = 1;

INSERT INTO app_custom_domains (app_id, domain, status, kind, added_at, verified_at, canonical)
SELECT id, 'rideshare.proappstore.online', 'active', 'exact', CAST(strftime('%s','now') AS INTEGER) * 1000, CAST(strftime('%s','now') AS INTEGER) * 1000, 1
FROM apps WHERE id = 'loopride'
  AND NOT EXISTS (SELECT 1 FROM apps WHERE id = 'rideshare')
  AND NOT EXISTS (SELECT 1 FROM app_custom_domains WHERE domain = 'rideshare.proappstore.online' AND app_id <> 'loopride')
ON CONFLICT(app_id, domain) DO UPDATE SET status = excluded.status, kind = excluded.kind, verified_at = excluded.verified_at, canonical = 1;

UPDATE submissions SET name = 'Rideshare' WHERE app_id = 'loopride' AND lower(name) IN ('loopride', 'rideshare', 'rideshare (loopride)');

-- Keep future storefront reconciliation from restoring the retired public brand.
-- Leave URL identifiers and the rest of the listing copy unchanged.
UPDATE app_listings
SET tagline = replace(replace(tagline, 'Loopride', 'Rideshare'), 'RideShare', 'Rideshare'),
    long_description = replace(replace(long_description, 'Loopride', 'Rideshare'), 'RideShare', 'Rideshare')
WHERE app_id = 'loopride';
