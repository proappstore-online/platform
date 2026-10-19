-- #423: owner-authorised, audited app ownership transfer and recovery.
-- A transfer row is the state machine; apps.creator_id changes only when one
-- is accepted or admin-approved. Cascades with its app, as 0099/0104 do — D1
-- enforces foreign keys, so a bare reference would block DELETE /apps/:id.
CREATE TABLE IF NOT EXISTS app_ownership_transfers (
  id                    INTEGER PRIMARY KEY,
  app_id                TEXT    NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  from_user             TEXT    NOT NULL,   -- users.id of the owner at initiation
  to_user               TEXT    NOT NULL,   -- users.id of the recipient / recovery requester
  kind                  TEXT    NOT NULL CHECK (kind IN ('transfer', 'recovery')),
  status                TEXT    NOT NULL DEFAULT 'pending'
                        CHECK (status IN ('pending', 'accepted', 'declined', 'cancelled', 'expired', 'escalated', 'admin_approved')),
  implications_snapshot TEXT,               -- JSON: app/repo/route/data worker/billing shown before confirmation
  expiry_ms             INTEGER,
  admin_actor           TEXT,               -- users.id of the admin who resolved an escalation
  admin_reason          TEXT,
  created_ms            INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
  updated_ms            INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);

CREATE INDEX IF NOT EXISTS idx_app_ownership_transfers_app ON app_ownership_transfers(app_id);
CREATE INDEX IF NOT EXISTS idx_app_ownership_transfers_to ON app_ownership_transfers(to_user);
CREATE INDEX IF NOT EXISTS idx_app_ownership_transfers_from ON app_ownership_transfers(from_user);
CREATE INDEX IF NOT EXISTS idx_app_ownership_transfers_status ON app_ownership_transfers(status);

-- Append-only: no foreign key, so the record outlives the app and its transfers.
CREATE TABLE IF NOT EXISTS app_ownership_audit (
  id          INTEGER PRIMARY KEY,
  app_id      TEXT    NOT NULL,
  transfer_id INTEGER,
  actor       TEXT    NOT NULL,   -- users.id of whoever acted
  action      TEXT    NOT NULL,   -- e.g. initiated | accepted | declined | cancelled | expired | escalated | admin_approved
  from_user   TEXT,
  to_user     TEXT,
  detail      TEXT,               -- JSON
  created_ms  INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);

CREATE INDEX IF NOT EXISTS idx_app_ownership_audit_app ON app_ownership_audit(app_id);
CREATE INDEX IF NOT EXISTS idx_app_ownership_audit_transfer ON app_ownership_audit(transfer_id);

CREATE TRIGGER IF NOT EXISTS app_ownership_audit_no_update
BEFORE UPDATE ON app_ownership_audit
BEGIN
  SELECT RAISE(ABORT, 'audit records are immutable');
END;

CREATE TRIGGER IF NOT EXISTS app_ownership_audit_no_delete
BEFORE DELETE ON app_ownership_audit
BEGIN
  SELECT RAISE(ABORT, 'audit records are immutable');
END;
