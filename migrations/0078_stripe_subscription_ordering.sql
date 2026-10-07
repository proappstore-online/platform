-- #321: Stripe webhook ordering. A late or redelivered checkout.session.completed
-- must never bring a cancelled subscription back.
--
-- Additive only.
--
-- stripe_terminated_subscriptions: every Stripe subscription id a webhook has
-- ended (customer.subscription.deleted, or an update to a terminal status). It is
-- recorded whether or not a subscriptions row matched, so a deletion that arrives
-- BEFORE its checkout still wins: a checkout for a recorded id never activates.
-- Stripe never reuses a subscription id, so a row here is permanent.
--
-- subscriptions.checkout_event_at: the signed `created` time (unix seconds) of the
-- checkout event that set the row's subscription. A checkout for a DIFFERENT
-- subscription replaces an active row only if its event is newer, so an old
-- checkout delivered late cannot swap a user back to a superseded subscription.
CREATE TABLE IF NOT EXISTS stripe_terminated_subscriptions (
  subscription_id TEXT PRIMARY KEY,
  terminated_at   INTEGER NOT NULL,
  event_type      TEXT NOT NULL
);
ALTER TABLE subscriptions ADD COLUMN checkout_event_at INTEGER;
