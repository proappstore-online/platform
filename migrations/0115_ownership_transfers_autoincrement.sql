-- #445: app_ownership_transfers.id was a bare INTEGER PRIMARY KEY (0105), so SQLite reused the
-- highest id once its row was deleted. Deleting an app cascades its transfers away while
-- app_ownership_audit keeps its rows (no foreign key), so a transfer of a re-created app could take
-- an old id whose (app_id, transfer_id, action) audit row existed, and its audit insert was skipped.
-- Rebuild with AUTOINCREMENT, ids preserved, and start the sequence above every id the audit has
-- ever recorded, so an id that only survives in the audit is never handed out again.
-- Rollback: rebuild again without AUTOINCREMENT (ids stay valid); nothing else depends on it.
CREATE TABLE app_ownership_transfers_new (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  app_id                TEXT    NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  from_user             TEXT    NOT NULL,
  to_user               TEXT    NOT NULL,
  kind                  TEXT    NOT NULL CHECK (kind IN ('transfer', 'recovery')),
  status                TEXT    NOT NULL DEFAULT 'pending'
                        CHECK (status IN ('pending', 'accepted', 'declined', 'cancelled', 'expired', 'escalated', 'admin_approved')),
  implications_snapshot TEXT,
  expiry_ms             INTEGER,
  admin_actor           TEXT,
  admin_reason          TEXT,
  created_ms            INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
  updated_ms            INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);

INSERT INTO app_ownership_transfers_new
  (id, app_id, from_user, to_user, kind, status, implications_snapshot, expiry_ms, admin_actor, admin_reason, created_ms, updated_ms)
  SELECT id, app_id, from_user, to_user, kind, status, implications_snapshot, expiry_ms, admin_actor, admin_reason, created_ms, updated_ms
  FROM app_ownership_transfers;

DROP TABLE app_ownership_transfers;
ALTER TABLE app_ownership_transfers_new RENAME TO app_ownership_transfers;

CREATE INDEX IF NOT EXISTS idx_app_ownership_transfers_app ON app_ownership_transfers(app_id);
CREATE INDEX IF NOT EXISTS idx_app_ownership_transfers_to ON app_ownership_transfers(to_user);
CREATE INDEX IF NOT EXISTS idx_app_ownership_transfers_from ON app_ownership_transfers(from_user);
CREATE INDEX IF NOT EXISTS idx_app_ownership_transfers_status ON app_ownership_transfers(status);

DELETE FROM sqlite_sequence WHERE name = 'app_ownership_transfers';
INSERT INTO sqlite_sequence (name, seq)
  VALUES ('app_ownership_transfers', MAX(
    COALESCE((SELECT MAX(id) FROM app_ownership_transfers), 0),
    COALESCE((SELECT MAX(transfer_id) FROM app_ownership_audit), 0)));
