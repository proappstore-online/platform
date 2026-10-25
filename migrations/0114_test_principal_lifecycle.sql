-- Test-principal lifecycle hardening (#434, parent #432). Builds on 0113.
-- Rollback: DROP TRIGGER trg_test_principal_events_no_update / _no_delete, then the indexes below;
-- the added columns are nullable and ignored by older code, so they may stay.

ALTER TABLE test_principals ADD COLUMN updated_at INTEGER;           -- last bounded-metadata edit; NULL = never edited

-- Every mutation records who asked (request_id) and why (reason); before/after live in `detail`.
ALTER TABLE test_principal_events ADD COLUMN request_id TEXT;
ALTER TABLE test_principal_events ADD COLUMN reason TEXT;

CREATE INDEX IF NOT EXISTS idx_test_principals_created ON test_principals (created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_oidc_session_grants_principal ON oidc_session_grants (principal_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_test_principal_events_principal ON test_principal_events (principal_id, at DESC);
CREATE INDEX IF NOT EXISTS idx_test_principal_events_grant ON test_principal_events (grant_id, at DESC);

-- The audit trail is append-only: revoke/deactivate is the lifecycle, deletion is never needed.
CREATE TRIGGER IF NOT EXISTS trg_test_principal_events_no_update BEFORE UPDATE ON test_principal_events
BEGIN SELECT RAISE(ABORT, 'test_principal_events is append-only'); END;
CREATE TRIGGER IF NOT EXISTS trg_test_principal_events_no_delete BEFORE DELETE ON test_principal_events
BEGIN SELECT RAISE(ABORT, 'test_principal_events is append-only'); END;
