-- App log observability (ADR-008, platform#105/#106/#108).
--
-- Rebuilds `app_logs` (0015) for automatic SDK capture. Three changes, each
-- fixing something that made the table unusable for its stated purpose:
--
--   1. `user_id` becomes NULLABLE. It was NOT NULL, and ingestion required a
--      session — so a white screen on load or a failed credential sign-in, the
--      failures most worth capturing, could not be recorded at all. Anonymous
--      identity is carried by `client_id` (rotating, per-install, not per-person).
--   2. `fingerprint` groups occurrences into an issue. Without it a log table is
--      a firehose: you can count errors but never say "*this* error, 400 times,
--      12 users, since the 14:02 deploy".
--   3. `source` records whether the app context was verified by the host's
--      mediation binding (`mediated`) or merely asserted by the caller
--      (`direct`), so the console can default to rows that cannot be spoofed.
--
-- SQLite cannot drop NOT NULL in place, hence the rebuild. Existing rows are
-- preserved and land as source='direct' with no fingerprint.

CREATE TABLE app_logs_new (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  app_id      TEXT    NOT NULL,
  -- NULL = no session at capture time (pre-auth failure, signed-out visitor).
  user_id     TEXT,
  -- Rotating per-install id. Gives anonymous reports a cardinality for
  -- "affected users" without storing anything person-identifying.
  client_id   TEXT,
  -- Client clock. Untrusted: skewed, forgeable, and it is NOT what retention
  -- uses — see ingested_at below.
  ts          INTEGER NOT NULL,
  level       TEXT    NOT NULL,
  category    TEXT    NOT NULL DEFAULT 'app',
  message     TEXT    NOT NULL,
  data        TEXT,
  build_meta  TEXT,
  -- Grouping key: hash of level + category + the message *shape* (variable parts
  -- masked), so "failed for user 123" and "failed for user 456" are one issue.
  fingerprint TEXT,
  -- W3C traceparent trace-id, correlating this row with the backend and
  -- data-worker log lines for the same logical request.
  trace_id    TEXT,
  -- 'mediated' (app context asserted by the host, trustworthy) | 'direct'.
  source      TEXT    NOT NULL DEFAULT 'direct',
  -- Server clock at ingest. Retention prunes on THIS, never on `ts`: a client
  -- that reports ts far in the future would otherwise outlive the retention
  -- window forever.
  ingested_at INTEGER NOT NULL
);

INSERT INTO app_logs_new (id, app_id, user_id, ts, level, category, message, data, build_meta, ingested_at)
  SELECT id, app_id, user_id, ts, level, category, message, data, build_meta, ingested_at FROM app_logs;

DROP TABLE app_logs;
ALTER TABLE app_logs_new RENAME TO app_logs;

CREATE INDEX IF NOT EXISTS idx_app_logs_app_ts ON app_logs (app_id, ts DESC);
CREATE INDEX IF NOT EXISTS idx_app_logs_app_level ON app_logs (app_id, level);
-- Serves the console's error-group rollup (count + first/last seen per group).
CREATE INDEX IF NOT EXISTS idx_app_logs_app_fingerprint ON app_logs (app_id, fingerprint);
-- Serves retention pruning, which scans by server-side ingest time.
CREATE INDEX IF NOT EXISTS idx_app_logs_ingested_at ON app_logs (ingested_at);

-- Per-app daily write budget. Same shape as app_proxy_usage (0006): one row per
-- (app, UTC day). Bounds the cost of an app stuck in a render-error loop, which
-- is the realistic flood — no attacker required.
CREATE TABLE IF NOT EXISTS app_log_usage (
  app_id TEXT    NOT NULL,
  day    TEXT    NOT NULL,
  count  INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (app_id, day)
);
