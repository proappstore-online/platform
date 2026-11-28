-- #696: an app may declare its review roles in mcp.json `storage.review_roles`.
-- Registration writes them to app_storage_config.review_roles and sets this flag;
-- while it is 1 the manifest is the source of truth and PUT storage-config cannot
-- change review_roles (review_retention_days stays editable). A registration
-- without the block clears the flag and keeps the roles, so the team can edit them again.
ALTER TABLE app_storage_config ADD COLUMN review_roles_from_manifest INTEGER NOT NULL DEFAULT 0 CHECK (review_roles_from_manifest IN (0, 1));
