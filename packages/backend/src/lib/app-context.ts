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
 * A direct caller cannot forge it either: `api.proappstore.online` is dispatched
 * by the host (`packages/host/src/index.ts`), which strips the header there, and
 * the backend has no workers.dev URL (`wrangler.toml`). Both halves are
 * load-bearing — drop one and the secret proxy's app binding (#80) is forgeable.
 *
 * Absence means "did not come from an app origin". A direct (legacy-bearer)
 * caller never sends it. Treat a mismatch as hostile; treat absence as
 * "unverified" — acceptable for logs, refused by the secret proxy.
 */
export const APP_CONTEXT_HEADER = 'X-PAS-App';
