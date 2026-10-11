-- #366: carry template provenance (#178) from a submission to the app it becomes.
-- template_id is the approved catalogue id the submitter's repo was created from,
-- template_rev the exact source commit copied. Both NULL means provenance unknown:
-- every submission made before this migration, and any made without them. Approval
-- then records the app's provenance as unknown (NULL), never as the default
-- template (template-app) it was not shown to come from.
ALTER TABLE submissions ADD COLUMN template_id TEXT;
ALTER TABLE submissions ADD COLUMN template_rev TEXT;
