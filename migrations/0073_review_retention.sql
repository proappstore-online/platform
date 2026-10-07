-- #307: how long an undecided review upload (`_review/`, #208) may stay before
-- the platform deletes it. Additive only. NULL means the platform default
-- (30 days, lib/review-storage-reaper.ts); a team admin sets 1–365 through
-- PUT /v1/apps/:appId/storage-config.
ALTER TABLE app_storage_config ADD COLUMN review_retention_days INTEGER;
