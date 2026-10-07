-- #316: app-worker log lines get their own daily budget.
--
-- Additive only. Before this, PAS.log and the worker's console lines (#308) drew
-- on app_log_usage, the counter anonymous POST /v1/apps/:id/logs also spends, and
-- every invocation was refused once it was full: an anonymous flood stopped an
-- app's workers for the day and tripped its schedule breakers. Worker lines are
-- now counted here, per app per UTC day, beside the invocation metering; nothing
-- outside an invocation writes it. Over its limit, lines are dropped — the
-- invocation itself is never refused for logging.
ALTER TABLE app_worker_usage ADD COLUMN log_entries INTEGER NOT NULL DEFAULT 0;
