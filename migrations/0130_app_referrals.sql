-- #550 (epic #548): server-owned referral capture and first-app-activation attribution. Additive only.
--
-- A referred person is credited to a promoter once, by one authoritative server event: their first
-- authenticated, host-mediated request from inside the app. Page loads, clicks, code generation and token
-- issuance never create a row here. Nothing is backfilled from analytics or inferred identity.

-- The first time PAS saw this person act inside this app. Written by the server from the request, from now on.
CREATE TABLE IF NOT EXISTS app_user_activations (
  app_id TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  first_activated_at INTEGER NOT NULL,
  PRIMARY KEY (app_id, user_id)
);

-- One credit per (app, referred person). pending = a valid code was captured before activation;
-- confirmed = the activation event followed; expired = it never did (or the promoter stopped being active);
-- reversed = an owner voided it (fraud_invalid or correction). promoter_id and the code are the values at claim
-- time. referred_user_id has no foreign key so an erased person's row can be anonymised and kept as a count.
CREATE TABLE IF NOT EXISTS app_referral_attributions (
  id TEXT PRIMARY KEY,
  app_id TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  referred_user_id TEXT NOT NULL,
  promoter_id TEXT NOT NULL,
  code TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'confirmed', 'expired', 'reversed')),
  captured_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  activated_at INTEGER,
  confirmed_at INTEGER,
  reversal_kind TEXT CHECK (reversal_kind IN ('fraud_invalid', 'correction')),
  reversal_reason TEXT,
  reversed_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (app_id, referred_user_id)
);
CREATE INDEX IF NOT EXISTS idx_app_referral_attributions_promoter ON app_referral_attributions (app_id, promoter_id, status);
CREATE INDEX IF NOT EXISTS idx_app_referral_attributions_list ON app_referral_attributions (app_id, created_at DESC);

-- Every claim outcome that matters and every change, with no invitee identity in it. Never rewritten.
-- attribution_id is empty for a rejected claim (a self-referral, an existing user) that created no row.
CREATE TABLE IF NOT EXISTS app_referral_events (
  id TEXT PRIMARY KEY,
  app_id TEXT NOT NULL,
  attribution_id TEXT,
  promoter_id TEXT,
  actor_kind TEXT NOT NULL CHECK (actor_kind IN ('referred', 'owner', 'system')),
  action TEXT NOT NULL,
  from_status TEXT,
  to_status TEXT,
  reason TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_app_referral_events_app ON app_referral_events (app_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_app_referral_events_attribution ON app_referral_events (attribution_id, created_at DESC);

CREATE TRIGGER IF NOT EXISTS app_referral_events_immutable
BEFORE UPDATE ON app_referral_events
BEGIN
  SELECT RAISE(ABORT, 'app_referral_events is append-only');
END;

-- A person who erased their account in the app: an unconfirmed claim is dropped (it never became a credit); a
-- confirmed or reversed one stays as a count but no longer names them; their activation record goes.
CREATE TRIGGER IF NOT EXISTS erase_referral_on_app_account_deletion
AFTER INSERT ON per_app_deleted_users
BEGIN
  INSERT INTO app_referral_events (id, app_id, attribution_id, promoter_id, actor_kind, action, from_status, to_status, reason, created_at)
    SELECT lower(hex(randomblob(16))), app_id, id, promoter_id, 'system', 'erased', status, CASE WHEN status = 'pending' THEN NULL ELSE status END, 'referred person erased their account', NEW.deleted_at
      FROM app_referral_attributions WHERE app_id = NEW.app_id AND referred_user_id = NEW.user_id;
  DELETE FROM app_referral_attributions WHERE app_id = NEW.app_id AND referred_user_id = NEW.user_id AND status IN ('pending', 'expired');
  UPDATE app_referral_attributions SET referred_user_id = 'erased:' || id, updated_at = NEW.deleted_at
   WHERE app_id = NEW.app_id AND referred_user_id = NEW.user_id;
  DELETE FROM app_user_activations WHERE app_id = NEW.app_id AND user_id = NEW.user_id;
END;
