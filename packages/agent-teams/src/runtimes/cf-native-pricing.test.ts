import { describe, expect, it } from 'vitest';
import { estimateCost, estimateCostCached } from './cf-native-pricing.ts';

describe('estimateCostCached', () => {
  const M = 'claude-sonnet-4-6'; // input $3/Mtok, output $15/Mtok

  it('matches estimateCost when there are no cached tokens', () => {
    expect(estimateCostCached(M, 1000, 0, 0, 500)).toBeCloseTo(estimateCost(M, 1000, 500), 12);
  });

  it('prices cache reads at ~0.1x and cache writes at ~1.25x the input rate', () => {
    // 1000 total input: 800 cache-read, 100 cache-write, 100 fresh. 200 output.
    const cost = estimateCostCached(M, 1000, 800, 100, 200);
    const expected = (100 * 3 + 800 * 3 * 0.1 + 100 * 3 * 1.25 + 200 * 15) / 1_000_000;
    expect(cost).toBeCloseTo(expected, 12);
  });

  it('is cheaper than the naive estimate on a cache-heavy run (the bug it fixes)', () => {
    const naive = estimateCost(M, 1000, 200);           // charges all input at full rate
    const real = estimateCostCached(M, 1000, 900, 0, 200); // 900 of it from cheap cache
    expect(real).toBeLessThan(naive);
  });

  it('never goes negative if cache counts exceed the total (clamps fresh at 0)', () => {
    expect(estimateCostCached(M, 100, 90, 90, 0)).toBeGreaterThanOrEqual(0);
  });
});
