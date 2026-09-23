-- #178: record which approved template an app was provisioned from and the
-- exact source commit copied. NULL for apps provisioned before this migration.
ALTER TABLE apps ADD COLUMN template_id TEXT;
ALTER TABLE apps ADD COLUMN template_rev TEXT;
