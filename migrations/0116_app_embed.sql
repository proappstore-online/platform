-- Opt-in embedding (#453). Declared in an app's mcp.json (`embed: { allow: [...] }`),
-- validated and replaced with its tools at registration exactly like app_visibility (0065).
-- Read by the host when it serves an HTML page: the listed https origins are appended to that
-- app's CSP `frame-ancestors`, and nothing else changes. No row means the default: only the
-- app itself and PAS's own surfaces may frame it. A manifest that stops declaring `embed`
-- deletes the row, closing the app to other sites again on the next deploy.
CREATE TABLE IF NOT EXISTS app_embed (
  app_id     TEXT PRIMARY KEY,
  origins    TEXT NOT NULL,      -- JSON array of 1-10 normalised https origins (lib/manifest/embed.ts)
  created_at INTEGER NOT NULL
);
