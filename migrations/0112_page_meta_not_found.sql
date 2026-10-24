-- Explicit public-record absence policy. Existing apps retain fail-open behavior.
ALTER TABLE app_page_meta ADD COLUMN not_found_status INTEGER
  CHECK (not_found_status IS NULL OR not_found_status = 404);
