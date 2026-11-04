-- #267 item 10: distinguish an explicit admin kill switch from "never enabled" or an owner's own
-- disable, so owner self-serve (APP_WORKER_OWNER_SELF_SERVE) can never undo it.
--
-- Additive, plus one conservative backfill. No pre-existing row has these columns set, so without
-- the backfill below a row that was actually admin-killed before this migration existed would read
-- as merely "disabled" and become owner-reenableable — the exact thing this column exists to stop.
-- There is no prior audit trail distinguishing an admin disable from an owner's own disable
-- (routes/app-workers.ts wrote neither to any log before this change), so a row with disable
-- history is marked conservatively, as if admin-killed, rather than guessed as safe:
--
--   enabled = 0 AND enabled_at IS NOT NULL  -- it WAS enabled at some point, by someone, then disabled
--   AND admin_disabled_at IS NULL           -- and nothing already distinguishes why
--
-- A row that was NEVER enabled (enabled_at IS NULL — Hiring, and every app the first-party rule
-- always refused) is untouched: it has no disable history to be ambiguous about, so it stays
-- eligible for the owner self-serve this migration exists to unblock. An admin clears the
-- conservative mark the same way as a real one — re-enabling via PUT /admin/.../worker-enabled —
-- which is the intended, narrow extra friction: a human looks at the small population this
-- actually affects, once, rather than the marker silently waiving itself.
ALTER TABLE app_workers ADD COLUMN admin_disabled_at INTEGER;
ALTER TABLE app_workers ADD COLUMN admin_disabled_by TEXT;

UPDATE app_workers
   SET admin_disabled_at = enabled_at, admin_disabled_by = 'migration:0125_conservative_backfill'
 WHERE enabled = 0 AND enabled_at IS NOT NULL AND admin_disabled_at IS NULL;
