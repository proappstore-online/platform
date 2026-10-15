-- #390: the allowlisted request context of a log row (JSON LogContext in
-- lib/log-ingest.ts): envelope version, SDK version, operation, span ids,
-- result, safe error code and duration. Client rows carry the SDK's span;
-- server rows the server's span and the client span as parent. NULL for rows
-- from SDKs before the envelope and for rows written before this column.
ALTER TABLE app_logs ADD COLUMN context TEXT;
