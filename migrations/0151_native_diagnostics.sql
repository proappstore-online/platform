-- #660 / ADR-019: phone diagnostics, one current snapshot per device, kept 7 days. Never location or heart-rate
-- samples: the backend rebuilds the snapshot from whitelisted fields. Device deletion cascades.
-- Also the device facts the user's own read lists (platform, app version, last sync), recorded by GET /native/me.
-- Additive. Rollback: DROP TABLE native_diagnostics; the three native_devices columns are nullable and unread by old code.
ALTER TABLE native_devices ADD COLUMN platform TEXT;
ALTER TABLE native_devices ADD COLUMN app_version TEXT;
ALTER TABLE native_devices ADD COLUMN last_seen_at INTEGER;
CREATE TABLE native_diagnostics (
  device_id TEXT PRIMARY KEY REFERENCES native_devices(id) ON DELETE CASCADE,
  received_at INTEGER NOT NULL,
  snapshot TEXT NOT NULL CHECK(length(snapshot) <= 65536)
);
CREATE INDEX native_diagnostics_received ON native_diagnostics(received_at);
