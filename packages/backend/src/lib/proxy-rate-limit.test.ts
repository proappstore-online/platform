import { describe, expect, it } from 'vitest';
import { checkAndBump, dayKey, type ProxyUsageStore } from './proxy-rate-limit.js';

function fakeStore(): ProxyUsageStore & { counts: Map<string, number>; userCounts: Map<string, number> } {
  const counts = new Map<string, number>();
  const userCounts = new Map<string, number>();
  return {
    counts,
    userCounts,
    async read(appId, day) { return counts.get(`${appId}:${day}`) ?? 0; },
    async bump(appId, day, by) {
      const key = `${appId}:${day}`;
      counts.set(key, (counts.get(key) ?? 0) + by);
    },
    async readUser(appId, userId, day) { return userCounts.get(`${appId}:${userId}:${day}`) ?? 0; },
    async bumpUser(appId, userId, day, by) {
      const key = `${appId}:${userId}:${day}`;
      userCounts.set(key, (userCounts.get(key) ?? 0) + by);
    },
  };
}

/** A store from before the per-user sub-cap — no readUser/bumpUser at all. */
function legacyStore(): ProxyUsageStore {
  const counts = new Map<string, number>();
  return {
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

// The proxy is callable by any signed-in user for any app, and the platform has
// no record of "user U is a user of app A" to check against. Until calls can be
// bound to the app's own origin (#20), the per-caller cap is what stops one
// account from spending an app's whole budget.
describe('checkAndBump — per-user sub-cap (#80)', () => {
  const now = Date.now();
  const opts = { appId: 'app1', dailyLimit: 100, nowMs: now, denominator: 1, rng: () => 0 };

  it('blocks a caller at their own cap while the app still has budget', async () => {
    const store = fakeStore();
    store.userCounts.set(`app1:attacker:${dayKey(now)}`, 10);

    const result = await checkAndBump(store, { ...opts, userId: 'attacker', perUserLimit: 10 });

    expect(result.allowed).toBe(false);
    expect(result.deniedBy).toBe('user');
    // The app budget is untouched — that is the whole point.
    expect(store.counts.get(`app1:${dayKey(now)}`) ?? 0).toBe(0);
  });

  it('still serves a different caller once one is capped', async () => {
    const store = fakeStore();
    store.userCounts.set(`app1:attacker:${dayKey(now)}`, 10);

    const blocked = await checkAndBump(store, { ...opts, userId: 'attacker', perUserLimit: 10 });
    const served = await checkAndBump(store, { ...opts, userId: 'legit', perUserLimit: 10 });

    expect(blocked.allowed).toBe(false);
    expect(served.allowed).toBe(true);
    expect(served.userCount).toBe(1);
  });

  it('reports the app cap, not the user cap, when the app budget is spent', async () => {
    // Ordering matters for the error the caller sees: an exhausted app budget is
    // the creator's ceiling and applies no matter who is asking.
    const store = fakeStore();
    store.counts.set(`app1:${dayKey(now)}`, 100);

    const result = await checkAndBump(store, { ...opts, userId: 'legit', perUserLimit: 10 });

    expect(result.allowed).toBe(false);
    expect(result.deniedBy).toBe('app');
  });

  it('advances both counters from a single die roll', async () => {
    // One roll drives both, so the per-user total stays unbiased the same way
    // the app total does and the two can't drift apart.
    const store = fakeStore();
    await checkAndBump(store, { ...opts, denominator: 10, rng: () => 0, userId: 'u1', perUserLimit: 50 });

    expect(store.counts.get(`app1:${dayKey(now)}`)).toBe(10);
    expect(store.userCounts.get(`app1:u1:${dayKey(now)}`)).toBe(10);
  });

  it('leaves both counters alone when the die misses', async () => {
    const store = fakeStore();
    await checkAndBump(store, { ...opts, denominator: 10, rng: () => 0.99, userId: 'u1', perUserLimit: 50 });

    expect(store.counts.get(`app1:${dayKey(now)}`)).toBeUndefined();
    expect(store.userCounts.get(`app1:u1:${dayKey(now)}`)).toBeUndefined();
  });

  it('checks only the app cap when no userId is supplied', async () => {
    const store = fakeStore();
    store.userCounts.set(`app1:u1:${dayKey(now)}`, 999);

    const result = await checkAndBump(store, opts);

    expect(result.allowed).toBe(true);
    expect(result.userCount).toBeUndefined();
  });

  it('degrades to the app cap against a store that cannot track per-user counts', async () => {
    // The store interface's per-user half is optional; a caller passing a userId
    // to an older store must not throw, just lose the sub-cap.
    const result = await checkAndBump(legacyStore(), { ...opts, userId: 'u1', perUserLimit: 1 });

    expect(result.allowed).toBe(true);
    expect(result.userCount).toBeUndefined();
  });
});
