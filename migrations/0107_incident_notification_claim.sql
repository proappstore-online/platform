-- #395: restart-safe incident notifications, the #389 pattern for app_incidents.
--
-- An incident's state change and its notification were one step: the row changed,
-- then the webhook was sent, so a run that died in between left a firing or
-- recovered incident whose notification the next run never sent. Each transition
-- that notifies — firing, then recovered — is now claimed on the row with a lease
-- and stamped when sent; a later tick sends whatever is still owed.
--
-- notified_state: the last transition sent ('firing' | 'recovered'), NULL if none.
-- Acknowledging notifies nothing, so 'acknowledged' is never owed or stamped.
ALTER TABLE app_incidents ADD COLUMN notify_claimed_at INTEGER;
ALTER TABLE app_incidents ADD COLUMN notified_state TEXT CHECK (notified_state IN ('firing', 'recovered'));
ALTER TABLE app_incidents ADD COLUMN notify_attempts INTEGER NOT NULL DEFAULT 0;

-- Every existing incident was notified (or never will be) under the old code.
UPDATE app_incidents SET notified_state = CASE state WHEN 'recovered' THEN 'recovered' ELSE 'firing' END
 WHERE notified_state IS NULL;
