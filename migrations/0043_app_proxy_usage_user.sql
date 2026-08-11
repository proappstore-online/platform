-- Per-(app, user) daily proxy counter (#80).
--
-- app_proxy_usage is keyed (app_id, day) and is the APP's budget — the thing
-- the creator pays for. It cannot tell how that budget was spent, so a single
-- caller could burn all of DAILY_PROXY_REQUESTS on an app they have nothing to
-- do with. Until proxy calls can be bound to the app's own origin (blocked on
-- the platform-cookie migration, #20), a per-caller sub-cap is what limits the
-- blast radius: draining an app now needs many accounts, not one script.
--
-- A separate table rather than adding user_id to app_proxy_usage: that table's
-- (app_id, day) primary key IS the per-app aggregate the quota check reads, and
-- widening the key would turn every per-app total into a per-user one.
CREATE TABLE IF NOT EXISTS app_proxy_usage_user (
  app_id  TEXT NOT NULL,
  user_id TEXT NOT NULL,
  day     TEXT NOT NULL,
  count   INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (app_id, user_id, day)
);

-- Pruning old days is a full scan without this; the per-app table has the same
-- shape of query and gets it from its primary key's leading column.
CREATE INDEX IF NOT EXISTS idx_app_proxy_usage_user_day
  ON app_proxy_usage_user(day);
