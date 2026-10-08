/**
 * Fixed-window throttle for `POST /v1/license/validate` (#86).
 *
 * That endpoint is unauthenticated by design — apps validate a key offline,
 * without a session — so every call is an anonymous D1 read, and a license key
 * is a bearer credential someone can try to guess. Neither is acceptable
 * unbounded.
 *
 * Modelled on lib/credential-rate-limit.ts, with two deliberate differences:
 *
 *  - **Every attempt counts, not just failures.** The credential limiter counts
 *    failures because a legitimate user's own success shouldn't lock them out.
 *    Here the read itself is the cost being bounded, so a successful validate is
 *    just as expensive as a failed one.
 *
 *  - **Two buckets, both keyed on IP, not on the credential.** Keying on the
 *    key being validated would let an attacker rotate keys to get an unlimited
 *    budget, which is exactly the guessing behaviour this bounds. Each request
 *    spends one claim from a per-IP ceiling (MAX_VALIDATE_IP_ATTEMPTS, across
 *    all apps) and then one from a per-(ip, appId) bucket (MAX_VALIDATE_ATTEMPTS).
 *    `appId` comes from the request body, so on its own it would hand a caller a
 *    fresh bucket — and a fresh limiter row — per invented id (#324). The
 *    ceiling caps that rotation, and the route only claims a per-app bucket
 *    for an app that exists in the registry, so rows per IP are bounded by
 *    one ceiling row plus the real apps it validates against. IP is coarse and
 *    shared-NAT callers share a budget; that is the accepted trade-off for an
 *    endpoint with no identity to key on. Raise the limits rather than
 *    switching to a key-derived dimension if legitimate traffic ever trips them.
 *
 * A claim is one atomic conditional upsert, so concurrent requests each get a
 * distinct count and cannot overshoot a limit. A blocked caller is NOT written
 * back (the upsert's WHERE fails and nothing is returned), so the limiter cannot
 * be used to extend its own window, and a caller that keeps hammering stops
 * costing writes once it is over the limit.
 */

export const MAX_VALIDATE_ATTEMPTS = 10;
export const VALIDATE_WINDOW_MS = 60 * 1000; // 1 minute
/** Per-IP ceiling across every app id, so rotating ids buys no extra budget (#324). */
export const MAX_VALIDATE_IP_ATTEMPTS = 30;

/** Bucket key for a caller against one app. IP is whatever the edge saw. */
export function validateAttemptKey(ip: string, appId: string): string {
  return `${ip}:${appId}`;
}

/**
 * Bucket key for a caller's per-IP ceiling. Cannot equal a per-app key: those
 * end in an app id, which starts with a letter, never in an IP.
 */
export function validateIpKey(ip: string): string {
  return `ip:${ip}`;
}

/**
 * Consume one attempt against `limit`. Returns false when the caller is already
 * at the limit for the current window, in which case nothing is written. A row
 * whose window has expired restarts at 1; SQLite evaluates every SET expression
 * and the WHERE against the old row.
 */
export async function consumeValidateAttempt(db: D1Database, key: string, limit: number, nowMs: number): Promise<boolean> {
  const row = await db
    .prepare(
      `INSERT INTO license_validate_attempts (key, window_start, count) VALUES (?1, ?2, 1)
       ON CONFLICT(key) DO UPDATE SET
         window_start = CASE WHEN ?2 - window_start >= ?3 THEN ?2 ELSE window_start END,
         count        = CASE WHEN ?2 - window_start >= ?3 THEN 1 ELSE count + 1 END
       WHERE ?2 - window_start >= ?3 OR count < ?4
       RETURNING count`,
    )
    .bind(key, nowMs, VALIDATE_WINDOW_MS, limit)
    .first<{ count: number }>();
  return row !== null;
}
