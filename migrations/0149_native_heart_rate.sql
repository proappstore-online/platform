-- #631 / ADR-018 §5: Run's Bluetooth heart rate, the second Collect capability (heart_rate.ble). Its own table, as
-- native_locations is location's: a cascading FK to its grant, field CHECKs, and the same two indexes (0134).
-- Stores beats per minute and time only; no sensor name or identifier reaches the platform.
-- Additive. Rollback: DROP TABLE native_heart_rate.
CREATE TABLE native_heart_rate (
  grant_id TEXT NOT NULL REFERENCES native_grants(id) ON DELETE CASCADE,
  sample_id TEXT NOT NULL,
  recorded_at INTEGER NOT NULL,
  bpm INTEGER NOT NULL CHECK(bpm BETWEEN 25 AND 250),
  PRIMARY KEY(grant_id, sample_id)
);
CREATE INDEX native_heart_rate_time ON native_heart_rate(recorded_at);
CREATE INDEX native_heart_rate_grant_time ON native_heart_rate(grant_id, recorded_at, sample_id);
