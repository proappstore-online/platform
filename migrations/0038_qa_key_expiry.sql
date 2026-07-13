-- QA keys are scoped, external automation credentials. Bound them to the same
-- 30-day lifetime promised by the route docs so stale PAGS/agent keys do not
-- remain valid forever.
ALTER TABLE qa_api_keys ADD COLUMN expires_at INTEGER;

UPDATE qa_api_keys
SET expires_at = created_at + (30 * 24 * 60 * 60 * 1000)
WHERE expires_at IS NULL;
