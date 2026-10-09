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
 * Only the host can send it (#315). `api.proappstore.online` has its own route
 * to this worker, so direct callers never pass through the host: the default
 * `fetch` export strips both host-context headers before any route runs
 * ({@link withoutHostContext}). The host reaches this worker through its `API`
 * service binding to the `HostApi` entrypoint (index.ts), which the Internet
 * cannot address, and only that entrypoint keeps them. The backend has no
 * workers.dev URL either (`wrangler.toml`).
 *
 * Absence means "did not come from an app origin". A direct (legacy-bearer)
 * caller never has it. Treat a mismatch as hostile; treat absence as
 * "unverified" — acceptable for logs, refused by the secret proxy.
 */
export const APP_CONTEXT_HEADER = 'X-PAS-App';

/**
 * The app hostname the request was mediated from (#230), set by the host next
 * to `X-PAS-App` and stripped from direct traffic the same way (#315). Passkeys
 * use it as the WebAuthn relying-party id, so it must never come from the page.
 */
export const APP_HOST_HEADER = 'X-PAS-Host';

/**
 * A fixed host-only event marker. It reaches the API only through the private
 * HostApi service-binding entrypoint, never from an Internet request.
 */
export const HOST_SESSION_INVALIDATION_HEADER = 'X-PAS-Session-Invalidation';

/** Anonymous correlation id for the host's fixed session-invalidation event. */
export const HOST_SESSION_INVALIDATION_ID_HEADER = 'X-PAS-Session-Invalidation-Id';

/** The headers only the host may assert. */
export const HOST_CONTEXT_HEADERS = [
  APP_CONTEXT_HEADER,
  APP_HOST_HEADER,
  HOST_SESSION_INVALIDATION_HEADER,
  HOST_SESSION_INVALIDATION_ID_HEADER,
] as const;

/**
 * `request` without any host-context header (#315): what every request that did
 * not arrive through the `HostApi` entrypoint is reduced to, so a direct caller's
 * copies never reach a route. Returns `request` itself when it carries none.
 */
export function withoutHostContext(request: Request): Request {
  if (!HOST_CONTEXT_HEADERS.some((h) => request.headers.has(h))) return request;
  const stripped = new Request(request);
  for (const h of HOST_CONTEXT_HEADERS) stripped.headers.delete(h);
  return stripped;
}
