-- #566: verified app email. Additive only: new tables.
--
-- email_domains     a sending domain an app claims; proof of control is the provider's DNS
--                   verification (status = 'verified' only once the provider says so). One owner
--                   per domain: the provider team holds each domain once.
-- email_identities  the sender addresses an app declares. Usable only when its domain is
--                   verified, the owner has approved it, and nothing has revoked or suspended it.
--                   allow_external is the owner-approved capability to mail non-members.
-- email_app_settings  per-app admin kill switch and quota overrides (NULL = platform default).
-- email_sends       one row per accepted/refused send; unique (app, idempotency key). The provider
--                   id is the join to delivery events. delivered/bounced/complained_at are set once.
-- email_send_events append-only provider events per send (never rewrites email_sends history).
-- email_suppressions  per-app addresses not to mail again (hard bounce, complaint).
-- email_provider_events  provider webhook ids already received, so a retry applies once.
-- email_inbound     metadata of mail routed to an app (bodies are not stored here).
CREATE TABLE IF NOT EXISTS email_domains (
  id                 TEXT PRIMARY KEY,
  app_id             TEXT NOT NULL,
  domain             TEXT NOT NULL UNIQUE,
  provider_domain_id TEXT NOT NULL,
  status             TEXT NOT NULL DEFAULT 'pending',   -- pending | verified | failed
  receiving          INTEGER NOT NULL DEFAULT 0,
  records            TEXT NOT NULL DEFAULT '[]',        -- DNS records the provider asked for (public data)
  created_at         INTEGER NOT NULL,
  verified_at        INTEGER,
  checked_at         INTEGER
);
CREATE INDEX IF NOT EXISTS idx_email_domains_app ON email_domains (app_id);

CREATE TABLE IF NOT EXISTS email_identities (
  id               TEXT PRIMARY KEY,
  app_id           TEXT NOT NULL,
  address          TEXT NOT NULL UNIQUE,
  domain           TEXT NOT NULL,
  display_name     TEXT,
  reply_to         TEXT,
  status           TEXT NOT NULL DEFAULT 'pending',     -- pending | approved | revoked
  allow_external   INTEGER NOT NULL DEFAULT 0,
  suspended        INTEGER NOT NULL DEFAULT 0,
  suspended_reason TEXT,
  created_at       INTEGER NOT NULL,
  created_by       TEXT NOT NULL,
  approved_at      INTEGER,
  approved_by      TEXT,
  revoked_at       INTEGER,
  revoked_by       TEXT
);
CREATE INDEX IF NOT EXISTS idx_email_identities_app ON email_identities (app_id);

CREATE TABLE IF NOT EXISTS email_app_settings (
  app_id             TEXT PRIMARY KEY,
  suspended          INTEGER NOT NULL DEFAULT 0,
  suspended_reason   TEXT,
  suspended_by       TEXT,
  suspended_at       INTEGER,
  daily_limit        INTEGER,
  identity_daily_limit INTEGER,
  burst_limit        INTEGER
);

CREATE TABLE IF NOT EXISTS email_sends (
  id            TEXT PRIMARY KEY,
  app_id        TEXT NOT NULL,
  identity_id   TEXT NOT NULL,
  idem_key      TEXT NOT NULL,
  request_hash  TEXT NOT NULL,
  from_address  TEXT NOT NULL,
  to_json       TEXT NOT NULL,
  subject       TEXT NOT NULL,
  status        TEXT NOT NULL,                          -- sending | accepted | unknown | refused
  error_code    TEXT,
  provider_id   TEXT,
  actor         TEXT NOT NULL,
  created_at    INTEGER NOT NULL,
  accepted_at   INTEGER,
  delivered_at  INTEGER,
  bounced_at    INTEGER,
  complained_at INTEGER,
  UNIQUE (app_id, idem_key)
);
CREATE INDEX IF NOT EXISTS idx_email_sends_provider ON email_sends (provider_id) WHERE provider_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_email_sends_app_time ON email_sends (app_id, created_at);
CREATE INDEX IF NOT EXISTS idx_email_sends_identity_time ON email_sends (identity_id, created_at);

CREATE TABLE IF NOT EXISTS email_send_events (
  id          TEXT PRIMARY KEY,
  send_id     TEXT NOT NULL,
  app_id      TEXT NOT NULL,
  type        TEXT NOT NULL,
  detail      TEXT,
  occurred_at INTEGER NOT NULL,
  provider_event_id TEXT NOT NULL UNIQUE
);
CREATE INDEX IF NOT EXISTS idx_email_send_events_send ON email_send_events (send_id, occurred_at);

CREATE TABLE IF NOT EXISTS email_suppressions (
  app_id     TEXT NOT NULL,
  address    TEXT NOT NULL,
  reason     TEXT NOT NULL,                             -- bounced | complained
  send_id    TEXT,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (app_id, address)
);

CREATE TABLE IF NOT EXISTS email_provider_events (
  provider_event_id TEXT PRIMARY KEY,
  type              TEXT NOT NULL,
  received_at       INTEGER NOT NULL,
  processed_at      INTEGER
);

CREATE TABLE IF NOT EXISTS email_inbound (
  id            TEXT PRIMARY KEY,
  app_id        TEXT NOT NULL,
  identity_id   TEXT NOT NULL,
  provider_id   TEXT NOT NULL,
  from_address  TEXT NOT NULL,
  subject       TEXT,
  received_at   INTEGER NOT NULL,
  UNIQUE (provider_id, identity_id)
);
CREATE INDEX IF NOT EXISTS idx_email_inbound_app ON email_inbound (app_id, received_at);
