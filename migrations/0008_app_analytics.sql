-- Per-app visitor analytics config. Read by the public /v1/analytics.js
-- loader script that each ProAppStore app embeds in its <head>. Written by
-- the creator via PUT /v1/apps/:id/analytics.
--
-- cf_beacon_token is auto-provisioned at provision time by the admin Worker
-- (Cloudflare Web Analytics — cookieless, no PII). The remaining fields are
-- opt-in BYO tags the creator sets later: GA4 measurement ID, Plausible
-- domain, or a free-form <head> snippet (capped at 4 KB).
--
-- Pro extra (not yet wired): the loader can also stream a server-side
-- page-view event to Workers Analytics Engine via the backend Worker,
-- giving Pro creators a first-party in-platform dashboard. The events
-- table lives outside D1 (Analytics Engine is its own datastore).

CREATE TABLE IF NOT EXISTS app_analytics (
  app_id            TEXT PRIMARY KEY,
  cf_beacon_token   TEXT,                  -- Cloudflare Web Analytics site token
  ga4               TEXT,                  -- G-XXXXXXXXXX
  plausible         TEXT,                  -- e.g. "mysite.com"
  custom_head       TEXT,                  -- free-form <head> snippet (<=4 KB)
  updated_at        INTEGER NOT NULL,
  FOREIGN KEY (app_id) REFERENCES apps(id) ON DELETE CASCADE
);
