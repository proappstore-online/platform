import { beforeEach, describe, expect, it } from 'vitest';
import {
  checkBurst,
  checkLogQuota,
  publicLogBurstKey,
  resetBurstState,
  type LogUsageStore,
} from './log-quota.js';
import { utcDayKey } from './day-key.js';
import { WORKER_LOG_BURST_KEY } from './app-worker-usage.js';
import { BURST_ENTRIES_PER_SECOND } from './log-ingest.js';

const NOW = 1_800_000_000_000;

function fakeStore(seed: Record<string, number> = {}): LogUsageStore & { counts: Map<string, number> } {
  const counts = new Map(Object.entries(seed));
  return {
    counts,
    async read(appId, day) {
      return counts.get(`${appId}:${day}`) ?? 0;
    },
    async bump(appId, day, by) {
      const key = `${appId}:${day}`;
      counts.set(key, (counts.get(key) ?? 0) + by);
    },
  };
}

beforeEach(() => resetBurstState());

describe('publicLogBurstKey (#316)', () => {
  it('namespaces every caller key, so a chosen clientId never names a user or a platform bucket', () => {
    expect(publicLogBurstKey('gh:42', 'gh:7', '1.2.3.4')).toBe('user:gh:42');
    expect(publicLogBurstKey(null, 'gh:42', '1.2.3.4')).toBe('client:gh:42');
    expect(publicLogBurstKey(undefined, null, '1.2.3.4')).toBe('ip:1.2.3.4');
    expect(publicLogBurstKey(null, null, undefined)).toBe('ip:unknown');
    // A clientId equal to a user id, or to a platform key, lands in a different bucket.
    expect(publicLogBurstKey(null, 'gh:42', null)).not.toBe(publicLogBurstKey('gh:42', null, null));
    for (const platform of [WORKER_LOG_BURST_KEY, 'server', 'app-worker']) expect(publicLogBurstKey(null, platform, null)).not.toBe(platform);
  });

  it("an anonymous flood under clientId 'worker' leaves the workers' burst bucket untouched", () => {
    const now = 1_000_000;
    expect(checkBurst('a', publicLogBurstKey(null, WORKER_LOG_BURST_KEY, null), now, BURST_ENTRIES_PER_SECOND)).toBe(true);
    expect(checkBurst('a', publicLogBurstKey(null, WORKER_LOG_BURST_KEY, null), now, 1)).toBe(false);
    expect(checkBurst('a', WORKER_LOG_BURST_KEY, now, 1)).toBe(true);
  });
});

describe('checkBurst', () => {
  it('spends budget per entry, not per request', () => {
    expect(checkBurst('a', 'c', NOW, BURST_ENTRIES_PER_SECOND)).toBe(true);
    expect(checkBurst('a', 'c', NOW, 1)).toBe(false);
  });

  it('resets on the next second', () => {
    expect(checkBurst('a', 'c', NOW, BURST_ENTRIES_PER_SECOND)).toBe(true);
    expect(checkBurst('a', 'c', NOW, 1)).toBe(false);
    expect(checkBurst('a', 'c', NOW + 1000, 1)).toBe(true);
  });

  it('isolates clients so one noisy client cannot spend another budget', () => {
    expect(checkBurst('a', 'noisy', NOW, BURST_ENTRIES_PER_SECOND)).toBe(true);
    expect(checkBurst('a', 'noisy', NOW, 1)).toBe(false);
    expect(checkBurst('a', 'quiet', NOW, 1)).toBe(true);
  });

  it('isolates apps', () => {
    expect(checkBurst('a', 'c', NOW, BURST_ENTRIES_PER_SECOND)).toBe(true);
    expect(checkBurst('b', 'c', NOW, 1)).toBe(true);
  });
});

describe('checkLogQuota', () => {
  it('persists and records the spend when under budget', async () => {
    const store = fakeStore();
    const v = await checkLogQuota(store, { appId: 'a', clientKey: 'c', entries: 5, nowMs: NOW });
    expect(v).toMatchObject({ persist: true, reason: 'ok', dayCount: 0 });
    expect(store.counts.get(`a:${utcDayKey(NOW)}`)).toBe(5);
  });

  it('refuses detail once the daily budget is spent', async () => {
    const store = fakeStore({ [`a:${utcDayKey(NOW)}`]: 100 });
    const v = await checkLogQuota(store, {
      appId: 'a', clientKey: 'c', entries: 1, nowMs: NOW, dailyLimit: 100,
    });
    expect(v).toMatchObject({ persist: false, reason: 'daily_quota', dayCount: 100 });
  });

  it('reports burst before daily, and does not spend daily budget on a burst refusal', async () => {
    const store = fakeStore();
    await checkLogQuota(store, {
      appId: 'a', clientKey: 'c', entries: BURST_ENTRIES_PER_SECOND, nowMs: NOW,
    });
    const spentAfterFirst = store.counts.get(`a:${utcDayKey(NOW)}`);
    const v = await checkLogQuota(store, { appId: 'a', clientKey: 'c', entries: 1, nowMs: NOW });
    expect(v.reason).toBe('burst');
    expect(store.counts.get(`a:${utcDayKey(NOW)}`)).toBe(spentAfterFirst);
  });

  it('rolls over to a fresh budget on the next UTC day', async () => {
    const store = fakeStore({ [`a:${utcDayKey(NOW)}`]: 100 });
    const nextDay = NOW + 24 * 60 * 60 * 1000;
    const v = await checkLogQuota(store, {
      appId: 'a', clientKey: 'c', entries: 1, nowMs: nextDay, dailyLimit: 100,
    });
    expect(v.persist).toBe(true);
  });

  it('keeps app budgets independent', async () => {
    const store = fakeStore({ [`a:${utcDayKey(NOW)}`]: 100 });
    const v = await checkLogQuota(store, {
      appId: 'b', clientKey: 'c', entries: 1, nowMs: NOW, dailyLimit: 100,
    });
    expect(v.persist).toBe(true);
  });
});
