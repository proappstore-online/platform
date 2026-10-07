-- #317: an inbound delivery is de-duplicated on a key from authenticated bytes.
--
-- Additive only. app_hook_deliveries.delivery_id (UNIQUE per app and hook) now
-- holds the replay key: the SHA-256 of the verified body, or Stripe's signed event
-- id. It used to hold the sender's unsigned delivery-id header (X-GitHub-Delivery,
-- an id_header), so a captured body and signature replayed under a fresh id ran
-- again. The sender's id is kept here for display only. Rows from before this
-- migration have it NULL, and their delivery_id is what the sender sent.
ALTER TABLE app_hook_deliveries ADD COLUMN sender_delivery_id TEXT;
