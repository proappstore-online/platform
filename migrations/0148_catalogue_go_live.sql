-- #658: an app listed in the public store goes live (Serge, 2026-11-23).
--
-- run and cv are listed in proappstore.online/catalogue.json but were created after
-- migration 0109's backfill, so every code action they registered is staged and
-- refused (403) to everyone but their owner and team. Record their go-live and
-- promote their staged code actions now; the cron's catalogue sweep
-- (lib/catalogue-go-live.ts) does the same for any app listed later.
-- Unlisted apps are untouched. Rollback: none needed (go-live is never reverted).
INSERT OR IGNORE INTO app_go_live (app_id, went_live_at, went_live_by)
  SELECT id, CAST(strftime('%s', 'now') AS INTEGER) * 1000, 'migration-0148' FROM apps WHERE id IN ('run', 'cv');

UPDATE app_tools SET state = 'live' WHERE app_id IN ('run', 'cv') AND source = 'code' AND state = 'staged';
