import { describe, expect, it } from 'vitest';
import {
  DAY_MS,
  DEFAULT_PROVISION_LIMITS,
  HOUR_MS,
  checkProvisionQuota,
  type ProvisionAttemptRow,
  type ProvisionAttemptStore,
} from './provision-rate-limit.ts';

function fakeStore(seed: Record<string, ProvisionAttemptRow> = {}) {
  const rows = new Map<string, ProvisionAttemptRow>(Object.entries(seed));
  const writes: string[] = [];
  const store: ProvisionAttemptStore = {
    async read(key) { return rows.get(key) ?? null; },
    async set(key, row) { writes.push(key); rows.set(key, row); },
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

  it('writes nothing when refusing', async () => {
    // Two reasons: a blocked caller must not push its own window forward, and
    // hammering should stop costing writes once over the limit.
    const { store, writes, rows } = fakeStore({
      [`user:${USER}:h`]: { window_start: NOW, count: DEFAULT_PROVISION_LIMITS.userPerHour },
    });
    await checkProvisionQuota(store, { userKey: USER, ip: IP, nowMs: NOW + 1000 });

    expect(writes).toEqual([]);
    expect(rows.get(`user:${USER}:h`)!.count).toBe(DEFAULT_PROVISION_LIMITS.userPerHour);
    expect(rows.get(`user:${USER}:d`)).toBeUndefined();
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
