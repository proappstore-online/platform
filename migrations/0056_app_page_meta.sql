-- Per-route link-preview metadata and sitemap (#210). Declared in an app's
-- mcp.json (`page_meta`, `sitemap`), validated and replaced with its tools at
-- registration, read by the host on uncached HTML hits and /sitemap.xml.
CREATE TABLE IF NOT EXISTS app_page_meta (
  app_id       TEXT NOT NULL,
  position     INTEGER NOT NULL,  -- declaration order; the first matching pattern wins
  path_pattern TEXT NOT NULL,     -- e.g. /p/:id
  action_name  TEXT NOT NULL,     -- a public query action returning title, description, image_url
  param_name   TEXT NOT NULL,     -- the path placeholder, passed as this action param
  created_at   INTEGER NOT NULL,
  PRIMARY KEY (app_id, path_pattern)
);

CREATE TABLE IF NOT EXISTS app_sitemap (
  app_id      TEXT PRIMARY KEY,
  action_name TEXT NOT NULL,      -- a public query action returning path, updated_at; paged by :cursor
  created_at  INTEGER NOT NULL
);
