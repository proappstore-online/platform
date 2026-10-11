-- #374 (4d): the receipt's request intent hashed with `templateRev` removed.
-- A failed receipt the platform classified as recoverable may be rebound to a
-- new intent only when this matches: the revision is the one thing a fresh plan
-- may change. Rows from before this migration stay NULL, which never matches, so
-- they recover only under their identical intent.
ALTER TABLE provision_operations ADD COLUMN revision_free_intent_hash TEXT;
