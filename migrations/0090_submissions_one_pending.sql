-- #363 (#303 N22): at most one pending submission per app id, enforced by D1.
-- POST /v1/submissions checked for a pending row and then inserted, so two
-- concurrent submissions for one app id could both pass and both be pending.
-- The partial unique index makes the INSERT the single-winner step; the route
-- maps its constraint error to the existing 409. Rows that have left 'pending'
-- (approved, rejected, published) are outside the index, so resubmitting after
-- a terminal state is unaffected.
--
-- The index cannot be created over existing duplicates. Any app id that already
-- has several pending rows keeps its earliest (by created_at, then id), which is
-- the one the route meant to keep; the later ones are rejected with a reason,
-- never deleted, so the review history stays complete.
UPDATE submissions
   SET status = 'rejected',
       rejection_reason = 'Superseded: another submission for this app id was already pending (#363)',
       reviewed_at = CAST(strftime('%s', 'now') AS INTEGER) * 1000
 WHERE status = 'pending'
   AND EXISTS (
     SELECT 1 FROM submissions AS earlier
      WHERE earlier.app_id = submissions.app_id
        AND earlier.status = 'pending'
        AND (earlier.created_at < submissions.created_at
             OR (earlier.created_at = submissions.created_at AND earlier.id < submissions.id))
   );

CREATE UNIQUE INDEX IF NOT EXISTS idx_submissions_one_pending
  ON submissions(app_id) WHERE status = 'pending';
