-- Team members: multi-user access to apps and Agent Teams projects.
--
-- Roles:
--   owner       — full control (billing, delete, transfer). Auto-assigned to creator.
--   admin       — everything except billing/delete/transfer.
--   developer   — read/write code, create tickets, run agents, deploy.
--   po          — product owner: create/manage tickets, chat with agents, approve specs.
--   viewer      — read-only access to code, tickets, analytics. For clients/stakeholders.
--
-- An app can have multiple members. The original creator_id on the apps table
-- remains for billing/payout purposes. This table controls ACCESS, not ownership
-- of revenue.

CREATE TABLE IF NOT EXISTS team_members (
  app_id    TEXT    NOT NULL,
  user_id   TEXT    NOT NULL,
  role      TEXT    NOT NULL DEFAULT 'viewer',
  invited_by TEXT,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (app_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_team_members_user ON team_members(user_id);
CREATE INDEX IF NOT EXISTS idx_team_members_app  ON team_members(app_id);

-- Invitations: pending invites that haven't been accepted yet.
-- The invite_token is a short random string shared via link/email.
-- Expires after 7 days. Accepting inserts into team_members and deletes the invite.

CREATE TABLE IF NOT EXISTS team_invites (
  id         TEXT    PRIMARY KEY,
  app_id     TEXT    NOT NULL,
  role       TEXT    NOT NULL DEFAULT 'viewer',
  invited_by TEXT    NOT NULL,
  email      TEXT,
  token      TEXT    NOT NULL UNIQUE,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_team_invites_token ON team_invites(token);
CREATE INDEX IF NOT EXISTS idx_team_invites_app   ON team_invites(app_id);
