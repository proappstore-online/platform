-- Per-app store-listing metadata, editable from console.proappstore.online.
-- Separate from apps (provision tracking) and submissions (one-time review).
-- One row per app, populated lazily on first save.
--
-- The storefront reads this to render an app's listing page (icon, tagline,
-- long description, screenshots, developer info, social links, legal docs).
-- Anything that should change between releases without a code push lives
-- here.

CREATE TABLE IF NOT EXISTS app_listings (
  app_id              TEXT PRIMARY KEY,

  -- Branding
  icon_url            TEXT,
  theme_color         TEXT,           -- hex, used for PWA + storefront tile
  splash_color        TEXT,           -- hex, used for storefront tile background

  -- Listing copy
  tagline             TEXT,           -- short, 60 chars max
  long_description    TEXT,           -- markdown, 5000 chars max
  category            TEXT,           -- overrides apps.category if set

  -- Developer / contact
  website_url         TEXT,
  support_email       TEXT,
  support_url         TEXT,

  -- Social
  social_twitter      TEXT,           -- handle without @
  social_github       TEXT,           -- org/user
  social_mastodon     TEXT,           -- full URL (instances vary)
  social_bluesky      TEXT,           -- handle.tld

  -- Legal
  privacy_policy_url  TEXT,
  terms_url           TEXT,

  -- Screenshots: JSON array of public R2 URLs, ordered as displayed.
  screenshots_json    TEXT NOT NULL DEFAULT '[]',

  updated_at          INTEGER NOT NULL,

  FOREIGN KEY (app_id) REFERENCES apps(id) ON DELETE CASCADE
);
