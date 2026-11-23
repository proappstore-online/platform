-- #654: scheduling state of the native location relay, one row per (app, user). It holds no location: a delivery reads the
-- newest point from native_locations through the read's own authorization when it runs, so a revocation, publisher transfer,
-- disclosure change or device expiry between upload and delivery leaves nothing to relay.
--   status        'queued' while one app-events message owns the row (attempt_token), else 'idle'
--   lease_until   a queued row whose message was lost is re-armed by the next upload after this time
--   delivered_at  recorded_at of the last point relayed or given up on; only a newer point is relayed
--   sent_at       when the last delivery ran; the next one waits until 3 s after it
-- Additive. Rollback: DROP TABLE native_relays.
CREATE TABLE native_relays (
  app_id TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK(status IN ('idle', 'queued')),
  attempt_token TEXT,
  lease_until INTEGER,
  delivered_at INTEGER,
  sent_at INTEGER,
  PRIMARY KEY (app_id, user_id)
);
