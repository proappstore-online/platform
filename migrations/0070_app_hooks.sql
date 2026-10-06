-- #256 (ADR-009 §3–§4): inbound webhooks. `app_hooks` holds the mcp.json
-- `hooks` section, replaced with the manifest; `app_hook_deliveries` is one row
-- per verified delivery, unique per (app, hook, delivery id) — the de-dupe — and
-- never holds the body. Pruned after 14 days (routes/logs-prune.ts).
-- status: received | delivered | failed | quota_exceeded (#275).
-- Additive only: two new tables.
CREATE TABLE IF NOT EXISTS app_hooks (
  app_id      TEXT NOT NULL,
  name        TEXT NOT NULL,
  verify_kind TEXT NOT NULL,
  secret_name TEXT,
  verify_opts TEXT,
  target      TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  PRIMARY KEY (app_id, name)
);

CREATE TABLE IF NOT EXISTS app_hook_deliveries (
  id          TEXT PRIMARY KEY,
  app_id      TEXT NOT NULL,
  hook        TEXT NOT NULL,
  delivery_id TEXT NOT NULL,
  event       TEXT,
  received_at INTEGER NOT NULL,
  status      TEXT NOT NULL,
  attempts    INTEGER NOT NULL DEFAULT 1,
  finished_at INTEGER,
  error       TEXT,
  UNIQUE (app_id, hook, delivery_id)
);
CREATE INDEX IF NOT EXISTS idx_app_hook_deliveries_app ON app_hook_deliveries (app_id, received_at DESC);
