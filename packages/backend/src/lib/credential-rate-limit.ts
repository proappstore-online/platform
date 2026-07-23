/**
 * Fixed-window failed-attempt limiter for credentials/login (routes/auth.ts).
 *
 * One D1 row per login in `credential_login_attempts`. We count *failed*
 * attempts only — a successful login clears the row, so a legitimate student
 * is never locked out by their own success. After MAX_ATTEMPTS failures inside
 * WINDOW_MS the login is blocked until the window rolls over. Keyed by login
 * (not IP): provisioning is gated behind an adult, so the realistic threat is
 * guessing one known login, not spraying many.
 *
 * ACCEPTED TRADE-OFF (#89): because the block is per-login, someone who knows a
 * login can deliberately fail 10 times to lock that student out for the window
 * (an availability nuisance). We keep it this way on purpose — adding a per-IP
 * dimension would weaken brute-force resistance (these passwords are low-entropy)
 * against a multi-IP attacker, which is the worse risk for these low-value
 * accounts. If class-time availability ever matters more than brute-force
 * hardening, switch to a (login, ip) composite key + CAPTCHA rather than raising
 * MAX_ATTEMPTS. Global/IP flood protection is layered separately at the edge.
 *
 * Store is injected so the limiter logic is unit-testable without D1.
 */

export const MAX_ATTEMPTS = 10;
export const WINDOW_MS = 15 * 60 * 1000; // 15 minutes

export interface AttemptRow {
  window_start: number;
  count: number;
}

export interface AttemptStore {
  read(login: string): Promise<AttemptRow | null>;
  /** Upsert the row to exactly these values. */
  set(login: string, row: AttemptRow): Promise<void>;
  clear(login: string): Promise<void>;
}

export function d1AttemptStore(db: D1Database): AttemptStore {
  return {
    async read(login) {
      return db
        .prepare('SELECT window_start, count FROM credential_login_attempts WHERE login = ?')
        .bind(login)
        .first<AttemptRow>();
    },
    async set(login, row) {
      await db
        .prepare(
          `INSERT INTO credential_login_attempts (login, window_start, count) VALUES (?1, ?2, ?3)
           ON CONFLICT(login) DO UPDATE SET window_start = ?2, count = ?3`,
        )
        .bind(login, row.window_start, row.count)
        .run();
    },
    async clear(login) {
      await db.prepare('DELETE FROM credential_login_attempts WHERE login = ?').bind(login).run();
    },
  };
}

/**
 * True if this login is currently blocked (≥ MAX_ATTEMPTS failures in-window).
 * A row whose window has expired is treated as not-blocked (it resets on the
 * next recordFailure).
 */
export async function isBlocked(store: AttemptStore, login: string, nowMs: number): Promise<boolean> {
  const row = await store.read(login);
  if (!row) return false;
  if (nowMs - row.window_start >= WINDOW_MS) return false; // stale window
  return row.count >= MAX_ATTEMPTS;
}

/** Record a failed attempt, rolling the window if the previous one expired. */
export async function recordFailure(store: AttemptStore, login: string, nowMs: number): Promise<void> {
  const row = await store.read(login);
  if (!row || nowMs - row.window_start >= WINDOW_MS) {
    await store.set(login, { window_start: nowMs, count: 1 });
  } else {
    await store.set(login, { window_start: row.window_start, count: row.count + 1 });
  }
}

/** Clear the counter after a successful login. */
export async function recordSuccess(store: AttemptStore, login: string): Promise<void> {
  await store.clear(login);
}
