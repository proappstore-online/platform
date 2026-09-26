import { describe, expect, it, vi } from 'vitest';
import { AI_DAILY_UNITS, chargeAiBudget, embedUnits, generateUnits, secondsUntilUtcMidnight, utcDay, withinAiRate, withinModerationRate } from './ai-budget.js';
import type { Env } from '../types.js';

// #218: the weights, day boundaries and fail-open/fail-closed rules.
describe('ai-budget', () => {
  it('weights: smart 5, fast 1, embeddings 1 per 10 items with a minimum of 1', () => {
    expect(generateUnits('smart')).toBe(5);
    expect(generateUnits('fast')).toBe(1);
    expect([1, 10, 11, 100].map(embedUnits)).toEqual([1, 1, 2, 10]);
  });

  it('UTC day and time to the reset', () => {
    expect(utcDay(Date.UTC(2026, 8, 26, 23, 59))).toBe('2026-09-26');
    expect(secondsUntilUtcMidnight(Date.UTC(2026, 8, 26, 23, 0))).toBe(3600);
  });

  it('limiters fail open when the binding is missing, and take one token per call', async () => {
    expect(await withinAiRate({} as Env, 'u')).toBe(true);
    expect(await withinModerationRate({} as Env, 'u', 5)).toBe(true);
    const limit = vi.fn(async () => ({ success: true }));
    expect(await withinModerationRate({ MODERATION_RATE_LIMIT: { limit } } as unknown as Env, 'u', 3)).toBe(true);
    expect(limit).toHaveBeenCalledTimes(3);
    expect(limit).toHaveBeenCalledWith({ key: 'mod:u' });
  });

  it('the charge is one atomic conditional upsert, bound to the cap; D1 errors propagate (callers fail closed)', async () => {
    const first = vi.fn(async () => ({ units_used: 5 }));
    const bind = vi.fn(() => ({ first }));
    const db = { prepare: vi.fn(() => ({ bind })) } as unknown as D1Database;
    expect(await chargeAiBudget(db, 'u', 5, Date.UTC(2026, 8, 26))).toBe(true);
    expect(bind).toHaveBeenCalledWith('u', '2026-09-26', 5, AI_DAILY_UNITS);
    expect(String((db.prepare as ReturnType<typeof vi.fn>).mock.calls[0]![0])).toMatch(/ON CONFLICT\(user_id, date\) DO UPDATE[\s\S]*WHERE ai_daily_budget\.units_used \+ \?3 <= \?4[\s\S]*RETURNING/);
    first.mockResolvedValueOnce(null as never);
    expect(await chargeAiBudget(db, 'u', 5, Date.UTC(2026, 8, 26))).toBe(false);
    first.mockRejectedValueOnce(new Error('D1 down'));
    await expect(chargeAiBudget(db, 'u', 1, Date.UTC(2026, 8, 26))).rejects.toThrow('D1 down');
    expect(await chargeAiBudget(db, 'u', AI_DAILY_UNITS + 1, 0)).toBe(false);
  });
});
