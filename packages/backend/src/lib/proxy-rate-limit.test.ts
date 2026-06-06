import { describe, expect, it } from 'vitest';
import { checkAndBump, dayKey, type ProxyUsageStore } from './proxy-rate-limit.js';

function fakeStore(): ProxyUsageStore & { counts: Map<string, number> } {
  const counts = new Map<string, number>();
  return {
    counts,
    async read(appId, day) { return counts.get(`${appId}:${day}`) ?? 0; },
    async bump(appId, day, by) {
      const key = `${appId}:${day}`;
      counts.set(key, (counts.get(key) ?? 0) + by);
    },
  };
}

describe('dayKey', () => {
  it('returns YYYY-MM-DD in UTC', () => {
    // 2026-01-16T13:10:00Z
    expect(dayKey(1768569000000)).toBe('2026-01-16');
  });

  it('handles midnight boundary', () => {
    // Use a known epoch: 2025-01-01T00:00:00.000Z
    expect(dayKey(1735689600000)).toBe('2025-01-01');
  });
});

describe('checkAndBump', () => {
  it('allows requests under the limit', async () => {
    const store = fakeStore();
    const result = await checkAndBump(store, {
      appId: 'app1', dailyLimit: 100, nowMs: Date.now(),
      denominator: 1, rng: () => 0, // always write
    });
    expect(result.allowed).toBe(true);
    expect(result.wrote).toBe(true);
    expect(result.count).toBe(1);
  });

  it('blocks requests at the limit', async () => {
    const store = fakeStore();
    const day = dayKey(Date.now());
    store.counts.set(`app1:${day}`, 100);
    const result = await checkAndBump(store, {
      appId: 'app1', dailyLimit: 100, nowMs: Date.now(),
      denominator: 1, rng: () => 0,
    });
    expect(result.allowed).toBe(false);
    expect(result.wrote).toBe(false);
  });

  it('probabilistic write: skips write when rng >= 1/denom', async () => {
    const store = fakeStore();
    const result = await checkAndBump(store, {
      appId: 'app1', dailyLimit: 100, nowMs: Date.now(),
      denominator: 10, rng: () => 0.5, // 0.5 >= 1/10 → no write
    });
    expect(result.allowed).toBe(true);
    expect(result.wrote).toBe(false);
    expect(result.count).toBe(0);
  });

  it('probabilistic write: writes when rng < 1/denom and increments by denom', async () => {
    const store = fakeStore();
    const result = await checkAndBump(store, {
      appId: 'app1', dailyLimit: 100, nowMs: Date.now(),
      denominator: 10, rng: () => 0.05, // 0.05 < 1/10 → write
    });
    expect(result.allowed).toBe(true);
    expect(result.wrote).toBe(true);
    expect(result.count).toBe(10); // incremented by denom
  });

  it('isolates apps by appId', async () => {
    const store = fakeStore();
    const day = dayKey(Date.now());
    store.counts.set(`app1:${day}`, 99);
    const r1 = await checkAndBump(store, {
      appId: 'app1', dailyLimit: 100, nowMs: Date.now(),
      denominator: 1, rng: () => 0,
    });
    const r2 = await checkAndBump(store, {
      appId: 'app2', dailyLimit: 100, nowMs: Date.now(),
      denominator: 1, rng: () => 0,
    });
    expect(r1.count).toBe(100); // app1: 99 + 1
    expect(r2.count).toBe(1);   // app2: 0 + 1
  });

  it('resets count on a new day', async () => {
    const store = fakeStore();
    const yesterday = Date.now() - 86400000;
    store.counts.set(`app1:${dayKey(yesterday)}`, 500);
    const result = await checkAndBump(store, {
      appId: 'app1', dailyLimit: 100, nowMs: Date.now(),
      denominator: 1, rng: () => 0,
    });
    expect(result.allowed).toBe(true);
    expect(result.count).toBe(1);
  });
});
