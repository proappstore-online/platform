/**
 * Service-to-service auth check for internal endpoints (agent-teams → admin,
 * agent-teams → backend). Returns true only when a shared INTERNAL_TOKEN is
 * configured AND the caller presented exactly that value. Centralized so no call
 * site can forget the `expected` null-guard — without it, an unset INTERNAL_TOKEN
 * would make `provided === expected` (both undefined) pass and open the route.
 *
 * Runtime-agnostic: pass the header string from a raw `Request`
 * (`request.headers.get('X-Internal-Token')`) or Hono (`c.req.header(...)`).
 */
import { timingSafeEqual } from './session-jwt.js';

export function internalTokenOk(
  provided: string | null | undefined,
  expected: string | undefined,
): boolean {
  // Constant-time compare on the shared secret (matches the session-signature
  // check); a plain === leaks a byte-by-byte timing oracle on the token.
  return !!expected && typeof provided === 'string' && timingSafeEqual(provided, expected);
}
