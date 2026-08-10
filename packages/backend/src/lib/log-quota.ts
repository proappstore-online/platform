/**
 * Per-app daily log-write budget and per-isolate burst ceiling (ADR-008 §4).
 *
 * The realistic flood is not an attacker — it is one app stuck in a render-error
 * loop, which arrives authenticated, from a real user, about a real app. The
 * existing per-request caps (100 entries, 4 KB each) do nothing about it: they
 * bound one request, not the rate.
 *
 * Two layers, matching how the rest of the codebase already does this:
 *
 *  - **Burst** — the in-isolate per-second counter from lib/rate-limit.ts, keyed
 *    on (app, client). Same primitive analytics-ingest.ts already relies on.
 *    Per-isolate, so it is a speed bump rather than a guarantee.
 *  - **Daily** — a durable D1 counter per (app, UTC day), mirroring
 *    lib/proxy-rate-limit.ts. Exact increments rather than that module's
 *    probabilistic ones: log batches are bounded at 100 entries and arrive far
 *    less often than proxy calls, so write QPS is not the constraint and an exact
 *    count is worth more (it is what the console shows an owner).
 *
 * When the daily budget is spent we stop writing D1 rows but keep counting in
 * Analytics Engine — the spike stays visible, only the detail stops. That is
 * Sentry-style spike protection, and it is why exceeding the cap is not a 500.
 */

import { consume, newRateLimitState, type RateLimitState } from './rate-limit.js';
import { dayKey } from './proxy-rate-limit.js';
import { BURST_ENTRIES_PER_SECOND, DAILY_ENTRY_LIMIT } from './log-ingest.js';

export { dayKey };

export interface LogUsageStore {
  read(appId: string, day: string): Promise<number>;
  bump(appId: string, day: string, by: number): Promise<void>;
}

export function d1LogUsageStore(db: D1Database): LogUsageStore {
  return {
    async read(appId, day) {
      const row = await db
        .prepare('SELECT count FROM app_log_usage WHERE app_id = ?1 AND day = ?2')
        .bind(appId, day)
        .first<{ count: number }>();
      return row?.count ?? 0;
    },
    async bump(appId, day, by) {
      await db
        .prepare(
          `INSERT INTO app_log_usage (app_id, day, count) VALUES (?1, ?2, ?3)
           ON CONFLICT(app_id, day) DO UPDATE SET count = count + ?3`,
        )
        .bind(appId, day, by)
        .run();
    },
  };
}

// Per-isolate burst state, keyed `appId:clientKey`. Bounded so a spray of
// distinct client ids cannot grow it without limit — the same guard
// analytics-ingest.ts applies to its sampling buckets.
const burstStates = new Map<string, RateLimitState>();
const BURST_KEYS_MAX = 4096;

/** Exposed for tests; also lets a caller reset between isolate reuses. */
export function resetBurstState(): void {
  burstStates.clear();
}

export function checkBurst(appId: string, clientKey: string, nowMs: number, entries: number): boolean {
  const key = `${appId}:${clientKey}`;
  let state = burstStates.get(key);
  if (!state) {
    if (burstStates.size >= BURST_KEYS_MAX) burstStates.clear();
    state = newRateLimitState(nowMs);
    burstStates.set(key, state);
  }
  // One consume() per entry: a 100-entry batch spends 100 of the budget, so the
  // ceiling is on entries written, not requests made.
  for (let i = 0; i < entries; i++) {
    if (!consume(state, nowMs, BURST_ENTRIES_PER_SECOND)) return false;
  }
  return true;
}

export interface QuotaVerdict {
  /** Write detail rows to D1. False → count in AE only. */
  persist: boolean;
  /** Why detail was withheld, for the response body. */
  reason: 'ok' | 'burst' | 'daily_quota';
  /** Daily count observed before this batch. */
  dayCount: number;
}

/**
 * Decide whether this batch's detail rows may be persisted, and record the spend.
 *
 * Counts the spend even when persistence is refused: an app in a loop should not
 * get its budget back by being throttled, or it oscillates in and out of the cap
 * forever.
 */
export async function checkLogQuota(
  store: LogUsageStore,
  opts: { appId: string; clientKey: string; entries: number; nowMs: number; dailyLimit?: number },
): Promise<QuotaVerdict> {
  const dailyLimit = opts.dailyLimit ?? DAILY_ENTRY_LIMIT;
  const day = dayKey(opts.nowMs);
  const dayCount = await store.read(opts.appId, day);

  if (!checkBurst(opts.appId, opts.clientKey, opts.nowMs, opts.entries)) {
    return { persist: false, reason: 'burst', dayCount };
  }
  if (dayCount >= dailyLimit) {
    return { persist: false, reason: 'daily_quota', dayCount };
  }

  await store.bump(opts.appId, day, opts.entries);
  return { persist: true, reason: 'ok', dayCount };
}
