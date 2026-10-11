-- #303: queue messages are at-least-once and can outlive a delivery lease.
-- Each queued attempt therefore has an opaque ownership token.  Consumers must
-- match it before invoking app code, changing the durable row, or deleting a
-- spilled hook body.  NULL rows/messages predate this migration and are safely
-- ignored by the token-aware consumer until normal recovery/redelivery.
ALTER TABLE app_hook_deliveries ADD COLUMN attempt_token TEXT;
ALTER TABLE scheduled_action_runs ADD COLUMN queued_token TEXT;
