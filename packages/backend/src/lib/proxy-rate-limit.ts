/**
 * Per-app daily request cap for the secret-injecting proxy.
 *
 * Storage is a single D1 row per (app_id, day) in `app_proxy_usage`. Writes
 * are *probabilistic*: each call rolls a 1-in-N die; on a hit we increment
 * by N. Expected count is unbiased (E[hits·N] = total calls), and we cut
 * D1 write QPS by Nx so a moderately-popular app can stay inside the free
 * tier (100k writes/day platform-wide).
 *
 * Reads, by contrast, happen on every call. D1 reads are 5M/day free —
 * not the constraint.
 *
 * The "cap" check uses the most recent counter value; under load a few
 * extra requests can slip through past the cap because increments lag.
 * That's fine — the cap is a budget, not a hard cutoff. A determined
 * abuser hits other limits (auth, allowlist) long before they pump up
 * the lag-induced overage.
 */

export const PROBABILISTIC_WRITE_DENOMINATOR = 10;

export interface ProxyUsageStore {
  /** Returns the current count for (appId, day), or 0 if no row exists. */
  read(appId: string, day: string): Promise<number>;
  /** Increments the count for (appId, day) by `by`, creating the row if needed. */
  bump(appId: string, day: string, by: number): Promise<void>;
}

/**
 * D1-backed implementation of ProxyUsageStore. Pulled into its own factory
 * so unit tests can pass a fake without spinning up D1.
 */
export function d1UsageStore(db: D1Database): ProxyUsageStore {
  return {
    async read(appId, day) {
      const row = await db
        .prepare('SELECT count FROM app_proxy_usage WHERE app_id = ?1 AND day = ?2')
        .bind(appId, day)
        .first<{ count: number }>();
      return row?.count ?? 0;
    },
    async bump(appId, day, by) {
      await db
        .prepare(
          `INSERT INTO app_proxy_usage (app_id, day, count) VALUES (?1, ?2, ?3)
           ON CONFLICT(app_id, day) DO UPDATE SET count = count + ?3`,
        )
        .bind(appId, day, by)
        .run();
    },
  };
}

/**
 * UTC day key in YYYY-MM-DD form. Matches the column convention in
 * migrations/0006_app_secrets.sql.
 */
export function dayKey(nowMs: number): string {
  return new Date(nowMs).toISOString().slice(0, 10);
}

export interface CheckOptions {
  appId: string;
  /** Hard cap for the day. */
  dailyLimit: number;
  /** ms-since-epoch; pass Date.now() in real use. */
  nowMs: number;
  /** RNG for the probabilistic bump. Defaults to Math.random. */
  rng?: () => number;
  /** Override the denominator (default 10). Tests pass 1 to force every-call writes. */
  denominator?: number;
}

export interface CheckResult {
  allowed: boolean;
  /** Most recently observed count (post-increment if we wrote). */
  count: number;
  /** True iff this call performed a D1 write. */
  wrote: boolean;
}

/**
 * Atomic-ish "did we exceed the cap, and probabilistically bump the counter".
 * Caller should refuse the request when allowed=false.
 *
 * Order matters: read first → check cap → conditionally bump. We *don't*
 * do compare-and-swap because the lag is acceptable (see file header).
 */
export async function checkAndBump(
  store: ProxyUsageStore,
  opts: CheckOptions,
): Promise<CheckResult> {
  const denom = opts.denominator ?? PROBABILISTIC_WRITE_DENOMINATOR;
  const rng = opts.rng ?? Math.random;
  const day = dayKey(opts.nowMs);
  const current = await store.read(opts.appId, day);

  if (current >= opts.dailyLimit) {
    return { allowed: false, count: current, wrote: false };
  }

  // Roll the die. denom=1 means always write; denom=10 means 10% chance.
  if (rng() < 1 / denom) {
    await store.bump(opts.appId, day, denom);
    return { allowed: true, count: current + denom, wrote: true };
  }
  return { allowed: true, count: current, wrote: false };
}
