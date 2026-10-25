import { describe, expect, it } from 'vitest';
import { scheduledCronError, scheduledCronMatches } from './cron.js';

describe('scheduled cron grammar (#281)', () => {
  const firingMinutes = (cron: string) => Array.from({ length: 60 }, (_, m) => m)
    .filter((m) => scheduledCronMatches(cron, Date.UTC(2026, 0, 5, 3, m)));

  it('reads a bare start before a step as start..max, like standard cron', () => {
    expect(firingMinutes('5/15 * * * *')).toEqual([5, 20, 35, 50]);
    expect(firingMinutes('0/5 * * * *')).toEqual(firingMinutes('*/5 * * * *'));
    expect(firingMinutes('0/5 * * * *')).toEqual([0, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55]);
    // Hours follow the same rule: 1/6 is 1, 7, 13, 19.
    const hours = Array.from({ length: 24 }, (_, h) => h).filter((h) => scheduledCronMatches('0 1/6 * * *', Date.UTC(2026, 0, 5, h, 0)));
    expect(hours).toEqual([1, 7, 13, 19]);
    // A bare number with no step is still that single value.
    expect(firingMinutes('5 * * * *')).toEqual([5]);
  });

  it('accepts only decimal digits as a step', () => {
    for (const cron of ['*/1e1 * * * *', '*/0x5 * * * *', '*/5.0 * * * *', '*/+5 * * * *', '*/ 5 * * *']) {
      expect(scheduledCronError(cron), cron).not.toBeNull();
      expect(scheduledCronMatches(cron, Date.UTC(2026, 0, 5, 3, 10)), cron).toBe(false);
    }
  });

  it('checks the tick before anything else that could be wrong with the minutes', () => {
    expect(scheduledCronError('*/7 * * * *')).toBe('minutes must be multiples of 5 (the platform ticks every 5 minutes)');
    expect(scheduledCronError('0,3 * * * *')).toBe('minutes must be multiples of 5 (the platform ticks every 5 minutes)');
  });

  it('rejects a day-of-month no listed month has, but not when day-of-week can fire it', () => {
    expect(scheduledCronError('0 0 31 2 *')).toMatch(/never fires/);
    expect(scheduledCronError('0 0 30 2 *')).toMatch(/never fires/);
    expect(scheduledCronError('0 0 29 2 *')).toBeNull();
    expect(scheduledCronError('0 0 31 2 1')).toBeNull();
  });
});
