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
  /** Current count for (appId, userId, day), or 0. Optional: stores predating
   *  the per-user sub-cap (#80) may not implement it, and the check is skipped. */
  readUser?(appId: string, userId: string, day: string): Promise<number>;
  /** Increments (appId, userId, day) by `by`, creating the row if needed. */
  bumpUser?(appId: string, userId: string, day: string, by: number): Promise<void>;
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
    async readUser(appId, userId, day) {
      const row = await db
        .prepare('SELECT count FROM app_proxy_usage_user WHERE app_id = ?1 AND user_id = ?2 AND day = ?3')
        .bind(appId, userId, day)
        .first<{ count: number }>();
      return row?.count ?? 0;
    },
    async bumpUser(appId, userId, day, by) {
      await db
        .prepare(
          `INSERT INTO app_proxy_usage_user (app_id, user_id, day, count) VALUES (?1, ?2, ?3, ?4)
           ON CONFLICT(app_id, user_id, day) DO UPDATE SET count = count + ?4`,
        )
        .bind(appId, userId, day, by)
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
  /**
   * Caller identity for the per-user sub-cap (#80). Omit to check only the
   * app-wide budget — the pre-#80 behaviour, kept for callers that genuinely
   * have no user (none today; the proxy route always has one).
   */
  userId?: string;
  /** Per-caller share of the day's budget. Ignored unless `userId` is set. */
  perUserLimit?: number;
}

export interface CheckResult {
  allowed: boolean;
  /** Most recently observed count (post-increment if we wrote). */
  count: number;
  /** True iff this call performed a D1 write. */
  wrote: boolean;
  /** Which cap refused the request. Absent when allowed. */
  deniedBy?: 'app' | 'user';
  /** Most recently observed per-user count, when a userId was supplied.
   *  Explicitly `| undefined` — the repo runs `exactOptionalPropertyTypes`, and
   *  this is genuinely "absent because no userId was given", not merely optional. */
  userCount?: number | undefined;
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

  // Per-caller sub-cap (#80). Only meaningful when the store can track it and
  // the caller supplied both an identity and a limit.
  const perUser =
    opts.userId !== undefined && opts.perUserLimit !== undefined && store.readUser && store.bumpUser
      ? { userId: opts.userId, limit: opts.perUserLimit }
      : null;
  const userCurrent = perUser ? await store.readUser!(opts.appId, perUser.userId, day) : undefined;

  // App budget first: an exhausted app budget is the creator's ceiling and
  // applies regardless of who is calling.
  if (current >= opts.dailyLimit) {
    return { allowed: false, count: current, wrote: false, deniedBy: 'app', userCount: userCurrent };
  }
  if (perUser && userCurrent !== undefined && userCurrent >= perUser.limit) {
    return { allowed: false, count: current, wrote: false, deniedBy: 'user', userCount: userCurrent };
  }

  // One die roll drives both counters, so they stay consistent with each other
  // and the per-user total is unbiased the same way the app total is.
  if (rng() < 1 / denom) {
    await store.bump(opts.appId, day, denom);
    if (perUser) await store.bumpUser!(opts.appId, perUser.userId, day, denom);
    return {
      allowed: true,
      count: current + denom,
      wrote: true,
      userCount: userCurrent === undefined ? undefined : userCurrent + denom,
    };
  }
  return { allowed: true, count: current, wrote: false, userCount: userCurrent };
}
