/**
 * Fixed-window attempt limiter for credentials/login, credentials/change-password
 * and per-IP self-registration (routes/auth.ts).
 *
 * One D1 row per key in `credential_login_attempts`. A caller CLAIMS an attempt
 * before doing the guessable work (verifying a password), in one atomic upsert
 * that opens or rolls the window and increments the count. The claim is allowed
 * while the count is at most MAX_ATTEMPTS inside WINDOW_MS, so parallel guesses
 * cannot slip past the limit by all reading the count before any writes it
 * (#323): each request gets a distinct count from SQLite, and at most
 * MAX_ATTEMPTS of them are allowed per window. A success clears the row, so a
 * legitimate student is never locked out by their own success; a failure leaves
 * its claim counted.
 *
 * Keys: credentials/login keys on the identifier as typed (a login or an email);
 * change-password keys on the session's credential user id (`cred:…`, which no
 * login or email can equal: logins are [a-z0-9-], emails carry '@'); registration
 * keys on REGISTER_RATE_LIMIT_PREFIX + IP. Login and change-password counters
 * are independent.
 *
 * ACCEPTED TRADE-OFF (#89): because the block is per-login, someone who knows a
 * login can deliberately fail 10 times to lock that student out for the window
 * (an availability nuisance). We keep it this way on purpose — adding a per-IP
 * dimension would weaken brute-force resistance (these passwords are low-entropy)
 * against a multi-IP attacker, which is the worse risk for these low-value
 * accounts. If class-time availability ever matters more than brute-force
 * hardening, switch to a (login, ip) composite key + CAPTCHA rather than raising
 * MAX_ATTEMPTS. Global/IP flood protection is layered separately at the edge.
 */

export const MAX_ATTEMPTS = 10;
export const WINDOW_MS = 15 * 60 * 1000; // 15 minutes

/**
 * Claim one attempt for `key`; false when the key is locked out. A row whose
 * window has expired restarts at 1. SQLite evaluates every SET expression
 * against the old row, so both CASEs see the same window_start.
 */
export async function claimAttempt(db: D1Database, key: string, nowMs: number): Promise<boolean> {
  const row = await db
    .prepare(
      `INSERT INTO credential_login_attempts (login, window_start, count) VALUES (?1, ?2, 1)
       ON CONFLICT(login) DO UPDATE SET
         window_start = CASE WHEN ?2 - window_start >= ?3 THEN ?2 ELSE window_start END,
         count        = CASE WHEN ?2 - window_start >= ?3 THEN 1 ELSE count + 1 END
       RETURNING count`,
    )
    .bind(key, nowMs, WINDOW_MS)
    .first<{ count: number }>();
  return (row?.count ?? 0) <= MAX_ATTEMPTS;
}

/** Clear the counter after a success. */
export async function recordSuccess(db: D1Database, key: string): Promise<void> {
  await db.prepare('DELETE FROM credential_login_attempts WHERE login = ?').bind(key).run();
}
