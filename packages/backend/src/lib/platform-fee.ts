/**
 * The platform's cut of a services charge, in basis points.
 *
 * Single source of truth (#85). This was declared independently in
 * routes/engagements.ts and routes/payouts.ts. Both are money paths and they
 * have to agree: engagements.ts splits each charge into the developer's share
 * and the fee, and a refund reverses that same split to decide how much to claw
 * back. If the two copies ever drifted, refunds would claw back a different
 * fraction than was credited and the ledger would quietly stop balancing.
 */
export const PLATFORM_FEE_BPS = 1000; // 10%

/** The developer's share of `amountCents`, rounded the same way everywhere. */
export function developerShareCents(amountCents: number): number {
  return Math.round((amountCents * (10_000 - PLATFORM_FEE_BPS)) / 10_000);
}
