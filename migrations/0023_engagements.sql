-- Services Phase 2: engagements, service chat, build requests, ratings.

CREATE TABLE IF NOT EXISTS build_requests (
  id          TEXT PRIMARY KEY,
  client_id   TEXT NOT NULL,
  title       TEXT NOT NULL,
  description TEXT NOT NULL,
  budget_cents INTEGER,
  status      TEXT NOT NULL DEFAULT 'open',
  accepted_by TEXT,
  engagement_id TEXT,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_build_requests_status ON build_requests(status);

CREATE TABLE IF NOT EXISTS engagements (
  id                      TEXT PRIMARY KEY,
  client_id               TEXT NOT NULL,
  developer_id            TEXT NOT NULL,
  project_slug            TEXT,
  build_request_id        TEXT,
  status                  TEXT NOT NULL DEFAULT 'active',
  prompt_rate_cents       INTEGER NOT NULL,
  prompts_count           INTEGER NOT NULL DEFAULT 0,
  total_charged_cents     INTEGER NOT NULL DEFAULT 0,
  total_dev_earned_cents  INTEGER NOT NULL DEFAULT 0,
  total_platform_fee_cents INTEGER NOT NULL DEFAULT 0,
  -- YYYY-MM of the payout run that settled this engagement; NULL = unpaid.
  -- The payout cron's idempotency hinges on this (`WHERE payout_month IS NULL`).
  --
  -- ADDED TO THIS FILE RETROACTIVELY (#85). It was originally applied to
  -- production by hand and 0025_service_payouts.sql only left a comment telling
  -- you to do the same, so a database rebuilt from migrations/ came out without
  -- it and every payout query failed. It belongs here rather than in a later
  -- ALTER because `wrangler d1 migrations apply` tracks migrations by NAME: this
  -- file is already recorded as applied, so production will not re-run it (and
  -- already has the column), while a fresh database gets it in the CREATE.
  -- An `ALTER TABLE ... ADD COLUMN payout_month` in a new migration would run
  -- against production and fail with "duplicate column name", breaking deploys.
  payout_month            TEXT,
  created_at              INTEGER NOT NULL,
  updated_at              INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_engagements_client ON engagements(client_id);
-- The cron scans unpaid rows by (status, payout_month); without this it is a
-- full table scan that grows with every settled engagement.
CREATE INDEX IF NOT EXISTS idx_engagements_unpaid ON engagements(status, payout_month);
CREATE INDEX IF NOT EXISTS idx_engagements_dev ON engagements(developer_id);

CREATE TABLE IF NOT EXISTS service_messages (
  id             TEXT PRIMARY KEY,
  engagement_id  TEXT NOT NULL,
  sender_role    TEXT NOT NULL,
  sender_id      TEXT NOT NULL,
  body           TEXT NOT NULL,
  charged        INTEGER NOT NULL DEFAULT 0,
  charge_cents   INTEGER NOT NULL DEFAULT 0,
  created_at     INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_service_msgs ON service_messages(engagement_id, created_at);

CREATE TABLE IF NOT EXISTS engagement_ratings (
  id             TEXT PRIMARY KEY,
  engagement_id  TEXT NOT NULL UNIQUE,
  client_id      TEXT NOT NULL,
  developer_id   TEXT NOT NULL,
  score          INTEGER NOT NULL,
  comment        TEXT,
  created_at     INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ratings_dev ON engagement_ratings(developer_id);
