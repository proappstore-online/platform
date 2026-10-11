import { describe, expect, it } from 'vitest';
import {
  DAY_MS,
  DEFAULT_PROVISION_LIMITS,
  HOUR_MS,
  checkProvisionQuota,
  type ProvisionAttemptRow,
  type ProvisionAttemptStore,
} from './provision-rate-limit.ts';

/**
 * The D1 store's semantics in memory. Each claim is one indivisible step, as
 * SQLite's upsert is, but it yields before and after it, so calls started
 * together interleave the way parallel requests do.
 */
function fakeStore(seed: Record<string, ProvisionAttemptRow> = {}) {
  const rows = new Map<string, ProvisionAttemptRow>(Object.entries(seed));
  const writes: string[] = [];
  const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
  const store: ProvisionAttemptStore = {
    async claim(key, nowMs, windowMs) {
      await tick();
      const row = rows.get(key);
      const next = !row || nowMs - row.window_start >= windowMs ? { window_start: nowMs, count: 1 } : { ...row, count: row.count + 1 };
      rows.set(key, next);
      writes.push(key);
      await tick();
      return { ...next };
    },
    async release(key, windowStart) {
      await tick();
      const row = rows.get(key);
      if (row && row.window_start === windowStart && row.count > 0) rows.set(key, { ...row, count: row.count - 1 });
    },
  };
  return { store, rows, writes };
}

const NOW = 1_800_000_000_000;
const USER = 'gh:2824906';
const IP = '203.0.113.7';

describe('checkProvisionQuota', () => {
  it('allows a first provision and opens every window', async () => {
    const { store, rows } = fakeStore();
    const r = await checkProvisionQuota(store, { userKey: USER, ip: IP, nowMs: NOW });

    expect(r.allowed).toBe(true);
    expect(rows.get(`user:${USER}:h`)).toEqual({ window_start: NOW, count: 1 });
    expect(rows.get(`user:${USER}:d`)).toEqual({ window_start: NOW, count: 1 });
    expect(rows.get(`ip:${IP}:h`)).toEqual({ window_start: NOW, count: 1 });
  });

  it('refuses at the per-user hourly cap and names the scope', async () => {
    const { store } = fakeStore({
      [`user:${USER}:h`]: { window_start: NOW, count: DEFAULT_PROVISION_LIMITS.userPerHour },
    });
    const r = await checkProvisionQuota(store, { userKey: USER, ip: IP, nowMs: NOW + 1000 });

    expect(r.allowed).toBe(false);
    expect(r.scope).toBe('user-hour');
  });

  it('refuses on the daily cap even when the hour looks fine', async () => {
    // A slow drip that never trips the hourly bucket is exactly why the daily
    // one exists.
    const { store } = fakeStore({
      [`user:${USER}:h`]: { window_start: NOW, count: 1 },
      [`user:${USER}:d`]: { window_start: NOW, count: DEFAULT_PROVISION_LIMITS.userPerDay },
    });
    const r = await checkProvisionQuota(store, { userKey: USER, ip: IP, nowMs: NOW + 1000 });

    expect(r.allowed).toBe(false);
    expect(r.scope).toBe('user-day');
  });

  it('refuses on the per-IP cap, which the per-user buckets cannot see', async () => {
    // Spreading a script across fresh accounts leaves every user bucket empty.
    const { store } = fakeStore({
      [`ip:${IP}:h`]: { window_start: NOW, count: DEFAULT_PROVISION_LIMITS.ipPerHour },
    });
    const r = await checkProvisionQuota(store, { userKey: 'gh:brand-new', ip: IP, nowMs: NOW });

    expect(r.allowed).toBe(false);
    expect(r.scope).toBe('ip-hour');
  });

  it('a refusal costs no budget: every slot it claimed is given back', async () => {
    // A blocked caller must not push its own window forward or spend budget,
    // and buckets after the refusing one are never touched.
    const { store, writes, rows } = fakeStore({
      [`user:${USER}:h`]: { window_start: NOW, count: DEFAULT_PROVISION_LIMITS.userPerHour },
    });
    await checkProvisionQuota(store, { userKey: USER, ip: IP, nowMs: NOW + 1000 });

    expect(writes).toEqual([`user:${USER}:h`]);
    expect(rows.get(`user:${USER}:h`)).toEqual({ window_start: NOW, count: DEFAULT_PROVISION_LIMITS.userPerHour });
    expect(rows.get(`user:${USER}:d`)).toBeUndefined();
  });

  it('an IP refusal gives back the user buckets it claimed first', async () => {
    const { store, rows } = fakeStore({
      [`ip:${IP}:h`]: { window_start: NOW, count: DEFAULT_PROVISION_LIMITS.ipPerHour },
    });
    const r = await checkProvisionQuota(store, { userKey: USER, ip: IP, nowMs: NOW });

    expect(r.scope).toBe('ip-hour');
    expect(rows.get(`user:${USER}:h`)).toEqual({ window_start: NOW, count: 0 });
    expect(rows.get(`user:${USER}:d`)).toEqual({ window_start: NOW, count: 0 });
    expect(rows.get(`ip:${IP}:h`)!.count).toBe(DEFAULT_PROVISION_LIMITS.ipPerHour);
  });

  describe('parallel provisions cannot exceed a cap (#303 S3)', () => {
    const allowedOf = (rs: { allowed: boolean }[]) => rs.filter((r) => r.allowed).length;

    it('per user per hour: a burst of 25 from one user admits exactly the cap', async () => {
      const { store, rows } = fakeStore();
      const rs = await Promise.all(Array.from({ length: 25 }, () => checkProvisionQuota(store, { userKey: USER, nowMs: NOW })));

      expect(allowedOf(rs)).toBe(DEFAULT_PROVISION_LIMITS.userPerHour);
      expect(rs.filter((r) => !r.allowed).every((r) => r.scope === 'user-hour')).toBe(true);
      // The refusals gave their slots back: the windows hold exactly the admitted provisions.
      expect(rows.get(`user:${USER}:h`)!.count).toBe(DEFAULT_PROVISION_LIMITS.userPerHour);
      expect(rows.get(`user:${USER}:d`)!.count).toBe(DEFAULT_PROVISION_LIMITS.userPerHour);
    });

    it('per IP per hour: a burst spread over 40 fresh accounts on one IP admits exactly the cap', async () => {
      const { store, rows } = fakeStore();
      const rs = await Promise.all(Array.from({ length: 40 }, (_, i) => checkProvisionQuota(store, { userKey: `gh:${i}`, ip: IP, nowMs: NOW })));

      expect(allowedOf(rs)).toBe(DEFAULT_PROVISION_LIMITS.ipPerHour);
      expect(rs.filter((r) => !r.allowed).every((r) => r.scope === 'ip-hour')).toBe(true);
      expect(rows.get(`ip:${IP}:h`)!.count).toBe(DEFAULT_PROVISION_LIMITS.ipPerHour);
    });

    it('over the cap, a burst admits nothing and leaves the count where it was', async () => {
      const { store, rows } = fakeStore({
        [`user:${USER}:h`]: { window_start: NOW, count: DEFAULT_PROVISION_LIMITS.userPerHour },
      });
      const rs = await Promise.all(Array.from({ length: 10 }, () => checkProvisionQuota(store, { userKey: USER, ip: IP, nowMs: NOW + 1000 })));

      expect(allowedOf(rs)).toBe(0);
      expect(rows.get(`user:${USER}:h`)!.count).toBe(DEFAULT_PROVISION_LIMITS.userPerHour);
      expect(rows.get(`ip:${IP}:h`)).toBeUndefined();
    });
  });

  it('reports seconds until the refusing window rolls over', async () => {
    const { store } = fakeStore({
      [`user:${USER}:h`]: { window_start: NOW, count: DEFAULT_PROVISION_LIMITS.userPerHour },
    });
    const r = await checkProvisionQuota(store, { userKey: USER, nowMs: NOW + HOUR_MS - 30_000 });

    expect(r.retryAfterSeconds).toBe(30);
  });

  it('rolls an expired window instead of staying blocked forever', async () => {
    const { store, rows } = fakeStore({
      [`user:${USER}:h`]: { window_start: NOW, count: 9999 },
    });
    const r = await checkProvisionQuota(store, { userKey: USER, nowMs: NOW + HOUR_MS });

    expect(r.allowed).toBe(true);
    expect(rows.get(`user:${USER}:h`)).toEqual({ window_start: NOW + HOUR_MS, count: 1 });
  });

  it('keeps the daily window open across an hourly rollover', async () => {
    const { store } = fakeStore({
      [`user:${USER}:d`]: { window_start: NOW, count: DEFAULT_PROVISION_LIMITS.userPerDay },
    });
    const justOverAnHour = NOW + HOUR_MS + 1;
    expect((await checkProvisionQuota(store, { userKey: USER, nowMs: justOverAnHour })).allowed).toBe(false);
    expect((await checkProvisionQuota(store, { userKey: USER, nowMs: NOW + DAY_MS })).allowed).toBe(true);
  });

  it('skips the IP bucket when the edge supplied no IP', async () => {
    // Collapsing every anonymous caller into one shared bucket would let a
    // single abuser deny everyone else.
    const { store, rows } = fakeStore();
    const r = await checkProvisionQuota(store, { userKey: USER, nowMs: NOW });

    expect(r.allowed).toBe(true);
    expect([...rows.keys()].some((k) => k.startsWith('ip:'))).toBe(false);
  });

  it('keeps separate budgets per user', async () => {
    const { store } = fakeStore({
      [`user:${USER}:h`]: { window_start: NOW, count: DEFAULT_PROVISION_LIMITS.userPerHour },
    });
    expect((await checkProvisionQuota(store, { userKey: USER, nowMs: NOW })).allowed).toBe(false);
    expect((await checkProvisionQuota(store, { userKey: 'gh:999', nowMs: NOW })).allowed).toBe(true);
  });

  it('honours caller-supplied limits', async () => {
    const { store } = fakeStore({ [`user:${USER}:h`]: { window_start: NOW, count: 2 } });
    const r = await checkProvisionQuota(store, {
      userKey: USER,
      nowMs: NOW,
      limits: { userPerHour: 2, userPerDay: 100, ipPerHour: 100 },
    });
    expect(r.allowed).toBe(false);
    expect(r.scope).toBe('user-hour');
  });
});
