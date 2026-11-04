-- Team accounts, milestone 1 (#534 T02, ADR-013, docs/team-accounts-design.md §4).
--
-- Purely additive and INERT: nothing reads these tables until ACCOUNTS_WRITE / account
-- authorization are switched on, apps keep authorizing through creator_id and team_members, and no
-- row is written here. The personal-account backfill is NOT in this file: the deploy lint refuses
-- UPDATE/DELETE, and a production backfill is a separate, reviewed, dry-run-first operation
-- (packages/backend/src/lib/accounts/backfill.ts).
--
-- Rollback: nothing depends on these objects. Drop the triggers, then the tables, by hand; the
-- added apps/agent_projects columns are nullable or defaulted and ignored by older code, so they stay.

CREATE TABLE accounts (
  id               TEXT PRIMARY KEY,
  kind             TEXT NOT NULL CHECK (kind IN ('personal','team')),
  name             TEXT NOT NULL,
  slug             TEXT NOT NULL CHECK (slug = lower(slug)),
  -- A new account is always 'provisioning'; it becomes 'active' only once an active owner exists.
  status           TEXT NOT NULL DEFAULT 'provisioning' CHECK (status IN ('provisioning','active','suspended','deleting','deleted')),
  personal_user_id TEXT,
  created_by       TEXT NOT NULL,
  authz_version    INTEGER NOT NULL DEFAULT 0,      -- bumped by every membership change
  governance_version INTEGER NOT NULL DEFAULT 0,    -- bumped by settings/status changes
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL,
  CHECK ((kind = 'personal' AND personal_user_id IS NOT NULL) OR (kind = 'team' AND personal_user_id IS NULL))
);
CREATE UNIQUE INDEX accounts_slug ON accounts (slug);
CREATE UNIQUE INDEX accounts_personal_user ON accounts (personal_user_id) WHERE personal_user_id IS NOT NULL;

CREATE TABLE account_memberships (
  account_id TEXT NOT NULL REFERENCES accounts (id),
  user_id    TEXT NOT NULL,
  role       TEXT NOT NULL CHECK (role IN ('owner','admin','billing_manager','member','guest')),
  status     TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','removed')),
  -- Bumped on every rejoin, so app grants of an earlier stint can never match again.
  generation INTEGER NOT NULL DEFAULT 1,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (account_id, user_id)
);
CREATE INDEX account_memberships_user ON account_memberships (user_id, status, account_id);
CREATE INDEX account_memberships_owner ON account_memberships (account_id, role, status);

-- An active (or suspended) account always has an active owner, enforced at the write boundary: two
-- concurrent demotions or removals cannot both pass a precheck, because the second one aborts here.
CREATE TRIGGER trg_membership_keep_owner_update BEFORE UPDATE OF role, status ON account_memberships
WHEN OLD.role = 'owner' AND OLD.status = 'active' AND (NEW.role <> 'owner' OR NEW.status <> 'active')
  AND (SELECT status FROM accounts WHERE id = OLD.account_id) IN ('active','suspended')
  AND NOT EXISTS (SELECT 1 FROM account_memberships o WHERE o.account_id = OLD.account_id AND o.role = 'owner' AND o.status = 'active' AND o.user_id <> OLD.user_id)
BEGIN SELECT RAISE(ABORT, 'last_owner'); END;

CREATE TRIGGER trg_membership_keep_owner_delete BEFORE DELETE ON account_memberships
WHEN OLD.role = 'owner' AND OLD.status = 'active'
  AND (SELECT status FROM accounts WHERE id = OLD.account_id) IN ('active','suspended')
  AND NOT EXISTS (SELECT 1 FROM account_memberships o WHERE o.account_id = OLD.account_id AND o.role = 'owner' AND o.status = 'active' AND o.user_id <> OLD.user_id)
BEGIN SELECT RAISE(ABORT, 'last_owner'); END;

CREATE TRIGGER trg_account_starts_provisioning BEFORE INSERT ON accounts
WHEN NEW.status <> 'provisioning'
BEGIN SELECT RAISE(ABORT, 'account_must_start_provisioning'); END;

CREATE TRIGGER trg_account_activation_needs_owner BEFORE UPDATE OF status ON accounts
WHEN NEW.status = 'active' AND OLD.status = 'provisioning'
  AND NOT EXISTS (SELECT 1 FROM account_memberships o WHERE o.account_id = OLD.id AND o.role = 'owner' AND o.status = 'active')
BEGIN SELECT RAISE(ABORT, 'account_needs_owner'); END;

CREATE TABLE account_invitations (
  id            TEXT PRIMARY KEY,
  account_id    TEXT NOT NULL REFERENCES accounts (id),
  -- Exactly one target: a canonical PAS user id, or an exact (trimmed, lower-cased, never alias-normalized) verified email.
  target_user_id TEXT,
  target_email   TEXT,
  role          TEXT NOT NULL CHECK (role IN ('admin','billing_manager','member','guest')),
  inviter_id    TEXT NOT NULL,
  inviter_generation INTEGER NOT NULL,
  -- SHA-256 of the secret. The raw secret is shown once to the inviter and never stored.
  token_hash    TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','accepted','revoked','expired')),
  version       INTEGER NOT NULL DEFAULT 0,
  expires_at    INTEGER NOT NULL,
  accepted_by   TEXT,
  accepted_at   INTEGER,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  CHECK ((target_user_id IS NOT NULL) <> (target_email IS NOT NULL))
);
CREATE UNIQUE INDEX account_invitations_token_hash ON account_invitations (token_hash);
CREATE UNIQUE INDEX account_invitations_pending_target ON account_invitations (account_id, COALESCE(target_user_id, target_email)) WHERE status = 'pending';
CREATE INDEX account_invitations_account ON account_invitations (account_id, status);

-- An app assignment of a person who is an account member. For a team app the grant counts only while
-- the membership is active AND membership_generation still equals the membership's generation.
CREATE TABLE app_access_grants (
  id          TEXT PRIMARY KEY,
  app_id      TEXT NOT NULL,
  account_id  TEXT NOT NULL REFERENCES accounts (id),
  user_id     TEXT NOT NULL,
  role        TEXT NOT NULL CHECK (role IN ('app_admin','developer','product_owner','viewer','app_legacy_owner','app_legacy_admin','app_legacy_developer')),
  extra_permissions TEXT NOT NULL DEFAULT '[]',   -- JSON array of explicit grants, e.g. ["app.data.manage"]
  reason      TEXT,                               -- e.g. legacy_developer_data_access
  membership_generation INTEGER NOT NULL,
  granted_by  TEXT NOT NULL,
  expires_at  INTEGER,
  revoked_at  INTEGER,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);
CREATE UNIQUE INDEX app_access_grants_live ON app_access_grants (app_id, user_id) WHERE revoked_at IS NULL;
CREATE INDEX app_access_grants_user ON app_access_grants (user_id, revoked_at);
CREATE INDEX app_access_grants_account ON app_access_grants (account_id, user_id);

-- Idempotency receipts. A row exists only for an operation that COMMITTED, written in the same batch
-- as its effects: a replay returns result_json, a reused key with another payload is a 409.
CREATE TABLE account_operations (
  id              TEXT PRIMARY KEY,
  actor_id        TEXT NOT NULL,
  account_id      TEXT,
  action          TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  payload_hash    TEXT NOT NULL,
  result_json     TEXT NOT NULL,
  created_at      INTEGER NOT NULL
);
CREATE UNIQUE INDEX account_operations_key ON account_operations (actor_id, action, idempotency_key);
CREATE INDEX account_operations_account ON account_operations (account_id, created_at);

CREATE TABLE account_audit_events (
  id            TEXT PRIMARY KEY,
  account_id    TEXT,
  app_id        TEXT,
  actor_id      TEXT NOT NULL,
  credential    TEXT NOT NULL,                    -- credential kind of the caller
  action        TEXT NOT NULL,
  target_type   TEXT,
  target_id     TEXT,
  authz_version INTEGER,
  details       TEXT NOT NULL DEFAULT '{}',       -- redacted: never a secret, token or email body
  request_id    TEXT,
  operation_id  TEXT,
  created_at    INTEGER NOT NULL
);
CREATE INDEX account_audit_account_time ON account_audit_events (account_id, created_at);
CREATE INDEX account_audit_app_time ON account_audit_events (app_id, created_at);
CREATE TRIGGER trg_account_audit_no_update BEFORE UPDATE ON account_audit_events
BEGIN SELECT RAISE(ABORT, 'account_audit_events is append-only'); END;
CREATE TRIGGER trg_account_audit_no_delete BEFORE DELETE ON account_audit_events
BEGIN SELECT RAISE(ABORT, 'account_audit_events is append-only'); END;

-- Durable side effects, retried after commit. One row per (operation, effect), so a retry cannot duplicate one.
CREATE TABLE account_outbox (
  id              TEXT PRIMARY KEY,
  operation_id    TEXT NOT NULL,
  effect          TEXT NOT NULL,
  account_id      TEXT,
  payload_json    TEXT NOT NULL DEFAULT '{}',     -- redacted: ids and versions only
  state           TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('held','pending','done','failed')),
  attempts        INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);
CREATE UNIQUE INDEX account_outbox_effect ON account_outbox (operation_id, effect);
CREATE INDEX account_outbox_state ON account_outbox (state, next_attempt_at);

-- Email proof for email-targeted invitations. Never backfilled from users.email or a provider label.
CREATE TABLE user_verified_emails (
  user_id     TEXT NOT NULL,
  email       TEXT NOT NULL CHECK (email = lower(trim(email))),
  method      TEXT NOT NULL CHECK (method IN ('provider_claim','pas_email_proof')),
  verified_at INTEGER NOT NULL,
  revoked_at  INTEGER,
  PRIMARY KEY (user_id, email)
);
CREATE INDEX user_verified_emails_email ON user_verified_emails (email);

-- Backfill tooling state. One receipt per user, one quarantined exception per anomaly: never guessed.
CREATE TABLE account_backfill_receipts (
  user_id    TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  run_id     TEXT NOT NULL,
  apps_mapped INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE TABLE account_backfill_exceptions (
  kind       TEXT NOT NULL,
  subject    TEXT NOT NULL,
  detail     TEXT NOT NULL DEFAULT '{}',
  run_id     TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (kind, subject)
);

-- Owning-account references. Nullable/defaulted: creator_id keeps authorizing until cutover.
ALTER TABLE apps ADD COLUMN owner_account_id TEXT;
ALTER TABLE apps ADD COLUMN ownership_version INTEGER NOT NULL DEFAULT 0;
ALTER TABLE apps ADD COLUMN access_version INTEGER NOT NULL DEFAULT 0;
ALTER TABLE apps ADD COLUMN authorization_model TEXT NOT NULL DEFAULT 'legacy' CHECK (authorization_model IN ('legacy','account'));
CREATE INDEX apps_owner_account ON apps (owner_account_id) WHERE owner_account_id IS NOT NULL;

ALTER TABLE agent_projects ADD COLUMN owner_account_id TEXT;
ALTER TABLE agent_projects ADD COLUMN ownership_version INTEGER NOT NULL DEFAULT 0;
CREATE INDEX agent_projects_owner_account ON agent_projects (owner_account_id) WHERE owner_account_id IS NOT NULL;
