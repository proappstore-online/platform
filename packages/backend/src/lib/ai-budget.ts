/**
 * Workers AI spend bounds (#218, a child of #27). `/v1/ai/*` let any signed-in
 * account run Workers AI — up to the 70B model — on the platform's metered
 * account with no limit, and the moderation added in #214/#215/#217 had no
 * per-caller bound either. Two ratelimit bindings (no new resource) plus a D1
 * daily budget bound both.
 */
import type { Env } from '../types.js';

/** Weighted units a user may spend per UTC day on /v1/ai/*. */
export const AI_DAILY_UNITS = 200;
/** Units per request: the 70B model costs more; embeddings are charged per 10 items. */
export const AI_UNITS = { smart: 5, fast: 1, embedPerTenItems: 1 } as const;

export function generateUnits(alias: string): number {
  return alias === 'smart' ? AI_UNITS.smart : AI_UNITS.fast;
}
export function embedUnits(items: number): number {
  return Math.max(1, Math.ceil(items / 10)) * AI_UNITS.embedPerTenItems;
}

type Limiter = { limit(opts: { key: string }): Promise<{ success: boolean }> } | undefined;

/**
 * Take `count` tokens from a ratelimit binding. Fail-open by design: a missing
 * binding does not block (the D1 daily budget still bounds /v1/ai/* spend, and
 * moderation must not stop because a limiter is absent).
 */
async function take(limiter: Limiter, key: string, count = 1): Promise<boolean> {
  if (!limiter?.limit) return true;
  for (let i = 0; i < count; i++) {
    if (!(await limiter.limit({ key })).success) return false;
  }
  return true;
}

/** 20 /v1/ai/* requests per minute per user (AI_RATE_LIMIT). */
export function withinAiRate(env: Env, userId: string): Promise<boolean> {
  return take(env.AI_RATE_LIMIT, userId);
}

/** 60 moderation model calls per minute per user (MODERATION_RATE_LIMIT, key `mod:{userId}`). */
export function withinModerationRate(env: Env, userId: string, calls = 1): Promise<boolean> {
  return take(env.MODERATION_RATE_LIMIT, `mod:${userId}`, calls);
}

export function utcDay(now: number): string {
  return new Date(now).toISOString().slice(0, 10);
}

/** Seconds until the next UTC midnight, when the daily budget resets. */
export function secondsUntilUtcMidnight(now: number): number {
  const next = new Date(now);
  next.setUTCHours(24, 0, 0, 0);
  return Math.max(1, Math.ceil((next.getTime() - now) / 1000));
}

/**
 * Charge `units` against the user's budget for today, atomically: the row is
 * created or incremented only if the result stays within AI_DAILY_UNITS, so
 * the check and the charge cannot race. Returns false when over budget.
 * A D1 failure throws — callers fail closed.
 */
export async function chargeAiBudget(db: D1Database, userId: string, units: number, now: number): Promise<boolean> {
  if (units > AI_DAILY_UNITS) return false;
  const row = await db.prepare(
    `INSERT INTO ai_daily_budget (user_id, date, units_used) VALUES (?1, ?2, ?3)
     ON CONFLICT(user_id, date) DO UPDATE SET units_used = units_used + ?3
       WHERE ai_daily_budget.units_used + ?3 <= ?4
     RETURNING units_used`,
  ).bind(userId, utcDay(now), units, AI_DAILY_UNITS).first<{ units_used: number }>();
  return row !== null;
}
