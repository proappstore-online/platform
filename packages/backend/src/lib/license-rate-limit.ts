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
 *  - **Keyed on (ip, appId), not on the credential.** Keying on the key being
 *    validated would let an attacker rotate keys to get an unlimited budget,
 *    which is exactly the guessing behaviour this bounds. IP is coarse and
 *    shared-NAT callers share a budget; that is the accepted trade-off for an
 *    endpoint with no identity to key on. Raise the limit rather than switching
 *    to a key-derived dimension if legitimate traffic ever trips it.
 *
 * A blocked caller is NOT written back, so the limiter cannot be used to extend
 * its own window, and a caller that keeps hammering stops costing writes once
 * they are over the limit — the write cost per (ip, appId) is bounded at
 * MAX_VALIDATE_ATTEMPTS per window.
 *
 * Store is injected so the logic is unit-testable without D1.
 */

export const MAX_VALIDATE_ATTEMPTS = 10;
export const VALIDATE_WINDOW_MS = 60 * 1000; // 1 minute

export interface ValidateAttemptRow {
  window_start: number;
  count: number;
}

export interface ValidateAttemptStore {
  read(key: string): Promise<ValidateAttemptRow | null>;
  /** Upsert the row to exactly these values. */
  set(key: string, row: ValidateAttemptRow): Promise<void>;
}

export function d1ValidateAttemptStore(db: D1Database): ValidateAttemptStore {
  return {
    async read(key) {
      return db
        .prepare('SELECT window_start, count FROM license_validate_attempts WHERE key = ?')
        .bind(key)
        .first<ValidateAttemptRow>();
    },
    async set(key, row) {
      await db
        .prepare(
          `INSERT INTO license_validate_attempts (key, window_start, count) VALUES (?1, ?2, ?3)
           ON CONFLICT(key) DO UPDATE SET window_start = ?2, count = ?3`,
        )
        .bind(key, row.window_start, row.count)
        .run();
    },
  };
}

/** Bucket key for a caller. IP is whatever the edge saw; appId scopes the budget. */
export function validateAttemptKey(ip: string, appId: string): string {
  return `${ip}:${appId}`;
}

/**
 * Consume one attempt. Returns false when the caller is already at the limit
 * for the current window, in which case nothing is written.
 */
export async function consumeValidateAttempt(
  store: ValidateAttemptStore,
  key: string,
  nowMs: number,
): Promise<boolean> {
  const row = await store.read(key);

  // No row, or the previous window has rolled over — start a fresh one.
  if (!row || nowMs - row.window_start >= VALIDATE_WINDOW_MS) {
    await store.set(key, { window_start: nowMs, count: 1 });
    return true;
  }

  if (row.count >= MAX_VALIDATE_ATTEMPTS) return false;

  await store.set(key, { window_start: row.window_start, count: row.count + 1 });
  return true;
}
