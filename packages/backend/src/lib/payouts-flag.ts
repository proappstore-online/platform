/**
 * Payouts are archived (#381): ProAppStore pays no developers, so no payout,
 * Stripe transfer, Connect onboarding or payout-netting debt may run. The
 * payout code is kept, unrouted, in src/archived/payouts/. The few payout paths
 * that live inside otherwise-live routes are gated on this flag. Off in every
 * environment; there is no switch to turn it on.
 */
export const PAYOUTS_ENABLED = false as boolean;
