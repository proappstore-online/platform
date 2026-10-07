import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { beforeEach, describe, expect, it } from 'vitest';
import { claimPingInterval } from './usage.js';

// #320 against real SQLite (node:sqlite), the same SQL D1 runs: the claim is a
// compare-and-swap on last_seen, so concurrent pings cannot claim one interval
// twice. The adapter awaits between statements, so pings started together
// interleave the way parallel requests do: every read, then the writes.

const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');
const MIGRATION = readFileSync(new URL('../../../../migrations/0006_usage_daily.sql', import.meta.url), 'utf8');
const T0 = Date.UTC(2026, 9, 8, 12, 0);
const DAY = '2026-10-08';

let sqlite: InstanceType<typeof DatabaseSync>;
function d1(): D1Database {
  return {
    prepare(sql: string) {
      const exec = (args: unknown[]) => ({
        first: async () => (sqlite.prepare(sql).get(...(args as never[])) as unknown) ?? null,
        run: async () => ({ meta: { changes: Number(sqlite.prepare(sql).run(...(args as never[])).changes) } }),
      });
      return { bind: (...args: unknown[]) => exec(args) };
    },
  } as unknown as D1Database;
}
const db = () => d1();
const ping = (now: number, deltaSeconds: unknown = 90, deltaApiCalls: unknown = 0) =>
  claimPingInterval(db(), { appId: 'a', userId: 'gh:1', day: DAY, now }, { deltaSeconds, deltaApiCalls });
const row = () => sqlite.prepare("SELECT session_seconds, api_calls, last_seen FROM usage_daily WHERE app_id = 'a' AND user_id = 'gh:1' AND day = ?").get(DAY);

beforeEach(() => {
  sqlite = new DatabaseSync(':memory:');
  sqlite.exec(MIGRATION);
});

describe('claimPingInterval (#320)', () => {
  it('normal sequential heartbeats: the first is capped at 90 s, each later one gets its real elapsed time', async () => {
    expect(await ping(T0, 999)).toEqual({ deltaSeconds: 90, deltaApiCalls: 0, sessionSeconds: 90, apiCalls: 0 });
    expect(await ping(T0 + 60_000, 60, 500)).toEqual({ deltaSeconds: 60, deltaApiCalls: 500, sessionSeconds: 150, apiCalls: 500 });
    expect(await ping(T0 + 120_000, 60)).toMatchObject({ deltaSeconds: 60, sessionSeconds: 210 });
    expect(row()).toEqual({ session_seconds: 210, api_calls: 500, last_seen: T0 + 120_000 });
  });

  it('50 parallel pings after 90 s record 90 s once, not 4,500 s', async () => {
    await ping(T0, 90);
    const claims = await Promise.all(Array.from({ length: 50 }, () => ping(T0 + 90_000, 90)));
    const won = claims.filter((c) => c !== null);
    expect(won).toHaveLength(1);
    expect(won[0]).toMatchObject({ deltaSeconds: 90 });
    expect(row()).toMatchObject({ session_seconds: 180, last_seen: T0 + 90_000 });
  });

  it('parallel first pings of the day insert once: one wins the 90 s, the rest claim nothing', async () => {
    const claims = await Promise.all(Array.from({ length: 20 }, () => ping(T0, 90, 1000)));
    expect(claims.filter((c) => c !== null)).toEqual([{ deltaSeconds: 90, deltaApiCalls: 1000, sessionSeconds: 90, apiCalls: 1000 }]);
    expect(row()).toEqual({ session_seconds: 90, api_calls: 1000, last_seen: T0 });
  });

  it('parallel pings at different instants never record more than the wall-clock span', async () => {
    await ping(T0, 0, 1); // opens the day with ~nothing
    const instants = Array.from({ length: 30 }, (_, i) => T0 + 1_000 + i * 2_000); // spread over ~60 s
    await Promise.all(instants.map((t) => ping(t, 90, 1000)));
    const r = row() as { session_seconds: number; api_calls: number; last_seen: number };
    const span = Math.ceil((r.last_seen - T0) / 1000);
    expect(r.session_seconds).toBeLessThanOrEqual(span);
    expect(r.api_calls).toBeLessThanOrEqual(1 + span * 20);
  });

  it('a retry, or a stale/out-of-order ping, claims nothing and never moves last_seen back', async () => {
    await ping(T0, 90);
    await ping(T0 + 30_000, 90);
    expect(await ping(T0 + 30_000, 90)).toBeNull(); // an exact retry
    expect(await ping(T0 + 10_000, 90)).toBeNull(); // arrives after a later one (skewed clock, delayed request)
    expect(row()).toEqual({ session_seconds: 120, api_calls: 0, last_seen: T0 + 30_000 });
  });

  it('cap boundaries: 90 s per ping, elapsed time, and 20 api calls per elapsed second', async () => {
    await ping(T0, 90);
    expect(await ping(T0 + 200_000, 999, 99_999)).toMatchObject({ deltaSeconds: 90, deltaApiCalls: 1000 }); // per-ping caps
    expect(await ping(T0 + 205_000, 90, 1000)).toMatchObject({ deltaSeconds: 5, deltaApiCalls: 100 }); // 5 s elapsed
    expect(await ping(T0 + 205_500, 90, 1000)).toBeNull(); // half a second: nothing whole to claim yet…
    expect(await ping(T0 + 206_000, 90, 1000)).toMatchObject({ deltaSeconds: 1, deltaApiCalls: 20 }); // …until it is one
    expect(await ping(T0 + 300_000, 'junk', -5)).toBeNull(); // nothing requested
  });

  it('a ping that loses its interval re-reads and claims only what is left after the winner', async () => {
    await ping(T0, 90);
    const [a, b] = await Promise.all([ping(T0 + 60_000, 90), ping(T0 + 61_000, 90)]);
    // Both read last_seen = T0; one wins (T0, its now]; the other re-reads and gets only the remainder, if any.
    const total = (a?.deltaSeconds ?? 0) + (b?.deltaSeconds ?? 0);
    expect(total).toBeLessThanOrEqual(61);
    expect(row()).toMatchObject({ session_seconds: 90 + total });
  });

  it('pings milliseconds apart cannot each claim a second; the sub-second rest carries to the next ping', async () => {
    await ping(T0, 90);
    const claims = await Promise.all(Array.from({ length: 20 }, (_, i) => ping(T0 + 1 + i, 90))); // 20 pings within 20 ms
    expect(claims.every((c) => c === null)).toBe(true);
    expect(row()).toMatchObject({ session_seconds: 90, last_seen: T0 });
    expect(await ping(T0 + 2_500, 90)).toMatchObject({ deltaSeconds: 2 }); // 2.5 s: claims 2, carries 0.5
    expect(row()).toMatchObject({ last_seen: T0 + 2_000 });
    expect(await ping(T0 + 3_000, 90)).toMatchObject({ deltaSeconds: 1 }); // the carried 0.5 s plus 0.5 s
    expect(row()).toMatchObject({ session_seconds: 93, last_seen: T0 + 3_000 });
  });

  it('a request smaller than the elapsed time drops the rest, as before (last_seen moves to now)', async () => {
    await ping(T0, 90);
    expect(await ping(T0 + 60_400, 10)).toMatchObject({ deltaSeconds: 10 });
    expect(row()).toMatchObject({ session_seconds: 100, last_seen: T0 + 60_400 });
  });
});
