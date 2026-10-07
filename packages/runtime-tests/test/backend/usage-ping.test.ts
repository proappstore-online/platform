import { SELF, env as providedEnv } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../../../backend/src/types';
import { BASE, mockNetwork, resetTables, seedApp, seedUser, session, viaHostApi } from './helpers';

const env = providedEnv as unknown as Env;

// #320 on workerd and real D1: parallel usage pings, mediated from the app's own
// origin by an active subscriber, are separate requests that interleave at every
// await, like production. Only the ping that wins its interval records it and
// writes a payout meter event, so 50 parallel pings cannot record 50x the time.

let meter: ReturnType<typeof vi.spyOn>;
const ping = async (deltaSeconds = 90, deltaApiCalls = 0) => viaHostApi(`${BASE}/v1/usage/ping`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${await session('gh:1')}`, 'Content-Type': 'application/json', 'X-PAS-App': 'meetup' },
  body: JSON.stringify({ appId: 'meetup', deltaSeconds, deltaApiCalls }),
}).then((r) => r.json<{ recorded: boolean; reason?: string; sessionSeconds: number }>());
const row = () => env.DB.prepare("SELECT session_seconds, api_calls, last_seen FROM usage_daily WHERE app_id = 'meetup' AND user_id = 'gh:1'").first<{ session_seconds: number; api_calls: number; last_seen: number }>();
const metered = () => meter.mock.calls.map((c) => (c[0] as { doubles: number[] }).doubles[0]);

beforeEach(async () => {
  mockNetwork();
  await resetTables();
  for (const t of ['usage_daily', 'subscriptions']) await env.DB.prepare(`DELETE FROM ${t}`).run();
  await seedUser('gh:1', 'sub');
  await seedApp('meetup', 'gh:1');
  await env.DB.prepare("INSERT INTO subscriptions (user_id, stripe_customer_id, status, created_at, updated_at) VALUES ('gh:1', 'cus_1', 'active', ?1, ?1)").bind(Date.now()).run();
  meter = vi.spyOn(env.PAYOUT_METER!, 'writeDataPoint');
});
afterEach(() => vi.restoreAllMocks());

describe('usage pings claim each interval once (#320)', () => {
  it('50 parallel first pings: one records 90 s and writes one meter event', async () => {
    const answers = await Promise.all(Array.from({ length: 50 }, () => ping(90)));
    expect(answers.filter((a) => a.recorded)).toHaveLength(1);
    expect(answers.filter((a) => !a.recorded).every((a) => a.reason === 'no-elapsed-time')).toBe(true);
    expect(await row()).toMatchObject({ session_seconds: 90 });
    expect(metered()).toEqual([90]);
  });

  it('50 parallel pings 90 s later record that 90 s once, not 4,500 s', async () => {
    await ping(90);
    await env.DB.prepare("UPDATE usage_daily SET last_seen = last_seen - 90000 WHERE app_id = 'meetup'").run();
    const answers = await Promise.all(Array.from({ length: 50 }, () => ping(90)));
    expect(answers.filter((a) => a.recorded)).toHaveLength(1);
    const r = (await row())!;
    expect(r.session_seconds).toBeGreaterThanOrEqual(180);
    expect(r.session_seconds).toBeLessThanOrEqual(181); // 90 + the 90 s that passed, give or take the ceil of a second
    expect(metered()).toHaveLength(2);
    expect(metered().reduce((a, b) => a + b, 0)).toBe(r.session_seconds);
  });

  it('a sequential retry with no time passed records nothing and writes no meter event', async () => {
    await ping(90);
    expect(await ping(90)).toMatchObject({ recorded: false, reason: 'no-elapsed-time' });
    expect(metered()).toEqual([90]);
  });

  it('normal sequential use still accrues real elapsed time', async () => {
    await ping(90);
    await env.DB.prepare("UPDATE usage_daily SET last_seen = last_seen - 60000 WHERE app_id = 'meetup'").run();
    expect(await ping(60)).toMatchObject({ recorded: true, sessionSeconds: 150 });
    expect(metered()).toEqual([90, 60]);
  });

  it('an unmediated ping still records nothing (#58 unchanged)', async () => {
    const res = await SELF.fetch(`${BASE}/v1/usage/ping`, {
      method: 'POST', headers: { Authorization: `Bearer ${await session('gh:1')}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ appId: 'meetup', deltaSeconds: 90 }),
    });
    expect(await res.json()).toMatchObject({ recorded: false, reason: 'unverified-origin' });
    expect(await row()).toBeNull();
    expect(meter).not.toHaveBeenCalled();
  });
});
