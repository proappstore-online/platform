/**
 * The header the host's platform mediation injects from the resolved app route.
 *
 * `packages/host/src/platform-mediation.ts` deletes any client-supplied copy
 * before setting it, so its presence on an inbound request is the host's claim
 * about which app the caller is — not the page's. Routes that make an
 * authorization decision on it (logs ingestion, the secret proxy) must use this
 * constant rather than a literal: the name is part of the trust boundary, and a
 * typo in one copy silently turns the check into a no-op.
 *
 * Absence proves nothing. A direct (legacy-bearer) caller never sends it, and an
 * attacker simply omits it. Treat a mismatch as hostile; treat absence as
 * "unverified", not "safe".
 */
export const APP_CONTEXT_HEADER = 'X-PAS-App';
