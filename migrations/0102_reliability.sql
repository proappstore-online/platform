-- #395: reliability objectives, incidents with a lifecycle, and observable
-- alert-webhook delivery. The per-window #107 alerts (app_alerts) are unchanged.

-- An owner's reliability objective for one operation family of their app (the
-- families of #391's request metrics). No row, no reliability alerting: the
-- platform never invents a target. `target` is the fraction of requests that
-- must not be a 5xx, e.g. 0.99.
CREATE TABLE IF NOT EXISTS app_reliability_objectives (
  app_id      TEXT    NOT NULL,
  family      TEXT    NOT NULL,
  target      REAL    NOT NULL CHECK (target >= 0.5 AND target < 1),
  enabled     INTEGER NOT NULL DEFAULT 1,
  updated_at  INTEGER NOT NULL,
  updated_by  TEXT,
  PRIMARY KEY (app_id, family)
);

-- One incident per app and rule while it is open: firing, then optionally
-- acknowledged, then recovered. `rule` is a fixed name (burn_fast:<family>,
-- burn_slow:<family>, outage:<family>, monitoring_degraded). `detail` holds
-- only rates, counts and window bounds — never ids, paths or payloads.
CREATE TABLE IF NOT EXISTS app_incidents (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  app_id           TEXT    NOT NULL,
  rule             TEXT    NOT NULL,
  state            TEXT    NOT NULL CHECK (state IN ('firing', 'acknowledged', 'recovered')),
  opened_at        INTEGER NOT NULL,
  last_seen_at     INTEGER NOT NULL,
  acknowledged_at  INTEGER,
  acknowledged_by  TEXT,
  recovered_at     INTEGER,
  detail           TEXT    NOT NULL DEFAULT '{}'
);
-- At most one open incident per app and rule: repeated evaluation updates it.
CREATE UNIQUE INDEX IF NOT EXISTS idx_app_incidents_open ON app_incidents (app_id, rule) WHERE state != 'recovered';
CREATE INDEX IF NOT EXISTS idx_app_incidents_app ON app_incidents (app_id, opened_at);

-- Bounded retry for app.alert webhook deliveries: when the next attempt is due
-- (NULL = no further attempt) and a short reason for the last failure.
ALTER TABLE webhook_deliveries ADD COLUMN next_attempt_at INTEGER;
ALTER TABLE webhook_deliveries ADD COLUMN last_error TEXT;
CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_retry ON webhook_deliveries (next_attempt_at) WHERE next_attempt_at IS NOT NULL;
