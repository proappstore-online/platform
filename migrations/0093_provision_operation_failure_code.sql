-- #369: a typed, server-established reason a provisioning attempt failed.
-- Written only with the platform INTERNAL_TOKEN (the MCP provisioning
-- workflow), never from a receipt owner's own session, and never derived from
-- the owner-writable steps. Today it records one thing: a new repo whose
-- template copy was proven to differ from the planned revision, or could not
-- be verified. Only such a failed receipt may be retried under a new request
-- intent (a fresh plan adopting the copy at the revision it holds); every other
-- failed receipt still resumes only with its original intent.
-- Cleared when a new attempt starts.
ALTER TABLE provision_operations ADD COLUMN failure_code TEXT;
