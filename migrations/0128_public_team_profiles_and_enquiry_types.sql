-- #542 (part of #541): a deliberately public team projection and typed team-join enquiries.
-- Additive only: no existing row is rewritten.

-- Enquiry type. Every existing enquiry is a general contact enquiry; a team_join enquiry
-- grants no membership and no access (it is only a message in the owner's inbox).
ALTER TABLE app_enquiries ADD COLUMN type TEXT NOT NULL DEFAULT 'general' CHECK (type IN ('general', 'team_join'));
CREATE INDEX IF NOT EXISTS idx_app_enquiries_type ON app_enquiries (app_id, type, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_app_enquiries_status_type ON app_enquiries (app_id, status, type);

-- A person's own opt-in to appear on the app's public team list. Nothing is public until
-- the person sets visible = 1; display_name and label are what they chose to publish, never
-- a login, email or provider id. A label is presentation, never a permission.
CREATE TABLE IF NOT EXISTS app_team_public_profiles (
  app_id TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  display_name TEXT,
  label TEXT,
  visible INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (app_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_app_team_public_profiles_visible ON app_team_public_profiles (app_id, visible);

-- Removing a member withdraws their public visibility, so rejoining never resurrects it:
-- the person must opt in again.
CREATE TRIGGER IF NOT EXISTS clear_team_public_profile_on_removal
AFTER DELETE ON team_members
BEGIN
  UPDATE app_team_public_profiles SET visible = 0, updated_at = datetime('now')
   WHERE app_id = OLD.app_id AND user_id = OLD.user_id;
END;

-- A publisher transfer withdraws the old publisher's visibility, and the new publisher
-- starts private too: neither is shown on the strength of an earlier opt-in.
CREATE TRIGGER IF NOT EXISTS clear_team_public_profiles_on_creator_transfer
AFTER UPDATE OF creator_id ON apps
WHEN OLD.creator_id <> NEW.creator_id
BEGIN
  UPDATE app_team_public_profiles SET visible = 0, updated_at = datetime('now')
   WHERE app_id = NEW.id AND user_id IN (OLD.creator_id, NEW.creator_id);
END;
