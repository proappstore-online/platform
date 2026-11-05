-- A pending first connection may complete after another app connects the same
-- identity. Explicitly capture its starting state; a later global disconnect
-- still deletes every pending flow through the existing lifecycle trigger.
-- In-flight legacy states retain their previous, stricter epoch semantics.
ALTER TABLE google_calendar_oauth_states ADD COLUMN account_status TEXT NOT NULL DEFAULT 'connected' CHECK (account_status IN ('connected', 'disconnected'));
-- Older browser bindings are not evidence of a verified first-party session.
-- They must reauthenticate (or restart if already approved), not inherit proof.
ALTER TABLE google_calendar_oauth_states ADD COLUMN browser_verified_at INTEGER;
