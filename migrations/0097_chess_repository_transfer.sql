-- #386: preserve the authority of existing grants across the repository transfer.
-- Revoked grants and historical mint/deploy audit records remain unchanged.
UPDATE oidc_session_grants
SET repository = 'ChessClubs-online/chess-clubs'
WHERE repository IN ('proappstore-online/chess-academy', 'proappstore-online/chess-clubs')
  AND revoked_at IS NULL;

-- The live registry had no chess grant at transfer time. Scope the owner's
-- nightly test session to this single workflow and main, just as the app expects.
INSERT INTO oidc_session_grants
  (id, repository, workflow, ref, user_id, label, created_by, created_at)
SELECT 'chess-clubs-nightly-386', 'ChessClubs-online/chess-clubs',
       '.github/workflows/e2e-full.yml', 'refs/heads/main', creator_id,
       'Chess Clubs nightly E2E (#386)', creator_id, unixepoch() * 1000
FROM apps
WHERE id = 'chess-academy' AND creator_id = 'gh:2824906'
  AND NOT EXISTS (
    SELECT 1 FROM oidc_session_grants
    WHERE repository = 'ChessClubs-online/chess-clubs'
      AND revoked_at IS NULL
      AND ref = 'refs/heads/main'
      AND (workflow IS NULL OR workflow = '.github/workflows/e2e-full.yml')
  );
