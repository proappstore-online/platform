-- #428: registered actions are staged until the app goes live.
--
-- Registering an app's actions made them callable at once through the actions
-- route, before the app (or its worker) was live (doordrop, platform#264). An
-- action is now 'staged' — callable only by the app's owner and team, its
-- worker, hooks and the scheduler — or 'live'.
--
-- Every existing action is live: the apps registered today are already serving.
ALTER TABLE app_tools ADD COLUMN state TEXT NOT NULL DEFAULT 'live' CHECK (state IN ('staged', 'live'));
