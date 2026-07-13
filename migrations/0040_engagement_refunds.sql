-- Track cumulative refunds per engagement so a refund can (a) be capped at the
-- amount actually charged and (b) claw back the developer's proportional share
-- before the payout cron pays them for refunded work.
--
-- Before this, /services/engagements/:id/refund credited the client but never
-- decremented total_dev_earned_cents (so the monthly cron still paid the dev
-- 90% on refunded work — the platform ate the whole amount), and the refund cap
-- was checked against total_charged_cents which never changed (so the same
-- engagement was refundable in full repeatedly).
ALTER TABLE engagements ADD COLUMN total_refunded_cents INTEGER NOT NULL DEFAULT 0;
