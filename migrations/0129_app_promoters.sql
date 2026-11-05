-- #549 (epic #548): app-scoped, self-service promoter enrollment. Additive only.
--
-- A promoter is an existing PAS user who has enrolled to help grow ONE app. The row is the
-- relationship (app + user), with its own public referral code, so one person can promote several
-- apps with separate identities and stats. It grants no team, creator, publisher, operator or admin
-- right: nothing here touches users, team_members, app roles or apps.

CREATE TABLE IF NOT EXISTS app_promoters (
  id TEXT PRIMARY KEY,                                   -- canonical internal id; the code is only a public handle for it
  app_id TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code TEXT NOT NULL UNIQUE,                             -- public referral code, unique across apps so it resolves alone
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended', 'withdrawn')),
  display_name TEXT,                                     -- what the person chose to show; never a login or email
  consent_version INTEGER NOT NULL,
  consented_at INTEGER NOT NULL,
  status_reason TEXT,
  status_changed_by TEXT,
  status_changed_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (app_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_app_promoters_app_status ON app_promoters (app_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_app_promoters_user ON app_promoters (user_id);

-- Every lifecycle change, who made it and why. Rows are never rewritten. promoter_id and app_id
-- are deliberately not foreign keys, so the record outlives a deleted app or promoter.
CREATE TABLE IF NOT EXISTS app_promoter_events (
  id TEXT PRIMARY KEY,
  app_id TEXT NOT NULL,
  promoter_id TEXT NOT NULL,
  actor_id TEXT,
  actor_kind TEXT NOT NULL CHECK (actor_kind IN ('self', 'owner', 'system')),
  action TEXT NOT NULL,
  from_status TEXT,
  to_status TEXT,
  reason TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_app_promoter_events_app ON app_promoter_events (app_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_app_promoter_events_promoter ON app_promoter_events (promoter_id, created_at DESC);

CREATE TRIGGER IF NOT EXISTS app_promoter_events_immutable
BEFORE UPDATE ON app_promoter_events
BEGIN
  SELECT RAISE(ABORT, 'app_promoter_events is append-only');
END;

-- An owner can close enrollment for an app. No row means open.
CREATE TABLE IF NOT EXISTS app_promoter_settings (
  app_id TEXT PRIMARY KEY REFERENCES apps(id) ON DELETE CASCADE,
  enrollment_open INTEGER NOT NULL DEFAULT 1 CHECK (enrollment_open IN (0, 1)),
  updated_by TEXT,
  updated_at INTEGER NOT NULL
);

-- A person who erased their account in an app is withdrawn there, and their public name cleared.
-- (Enrollment also refuses them, so they cannot come back through this door.)
CREATE TRIGGER IF NOT EXISTS withdraw_promoter_on_app_account_deletion
AFTER INSERT ON per_app_deleted_users
BEGIN
  INSERT INTO app_promoter_events (id, app_id, promoter_id, actor_id, actor_kind, action, from_status, to_status, reason, created_at)
    SELECT lower(hex(randomblob(16))), app_id, id, NEW.user_id, 'system', 'account_deleted', status, 'withdrawn', NULL, NEW.deleted_at
      FROM app_promoters WHERE app_id = NEW.app_id AND user_id = NEW.user_id AND status <> 'withdrawn';
  UPDATE app_promoters SET status = 'withdrawn', display_name = NULL, status_changed_at = NEW.deleted_at, updated_at = NEW.deleted_at
   WHERE app_id = NEW.app_id AND user_id = NEW.user_id AND status <> 'withdrawn';
END;
