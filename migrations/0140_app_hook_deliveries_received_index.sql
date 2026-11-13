-- Refs #595: stale hook delivery recovery (STALE_RECEIVED_SQL in routes/hooks.ts)
-- filters on status = 'received', which had no index and scanned the whole table
-- on every scheduler tick. This partial index holds only deliveries still in
-- flight, so the scan is confined to them. Additive only.
CREATE INDEX IF NOT EXISTS idx_app_hook_deliveries_received
  ON app_hook_deliveries (received_at) WHERE status = 'received';
