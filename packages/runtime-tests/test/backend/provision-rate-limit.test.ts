import { env as providedEnv } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { checkProvisionQuota, d1ProvisionAttemptStore, DEFAULT_PROVISION_LIMITS } from '@proappstore/build-core';
import type { Env } from '../../../backend/src/types';

const env = providedEnv as unknown as Env;

// #303 S3 on real D1: the provisioning limiter claims each bucket in one atomic
// upsert, so a parallel burst cannot all read the same count and all pass.

const NOW = 1_800_000_000_000;
const IP = '203.0.113.7';
const count = async (key: string) => (await env.DB.prepare('SELECT count FROM provision_attempts WHERE key = ?').bind(key).first<{ count: number }>())?.count;
const burst = (n: number, opts: (i: number) => { userKey: string; ip?: string; nowMs?: number }) =>
  Promise.all(Array.from({ length: n }, (_, i) => checkProvisionQuota(d1ProvisionAttemptStore(env.DB), { nowMs: NOW, ...opts(i) })));

beforeEach(async () => {
  await env.DB.prepare('DELETE FROM provision_attempts').run();
});

describe('provisioning rate limit under a parallel burst (#303 S3)', () => {
  it('per user: 25 parallel provisions from one user admit exactly userPerHour, and refusals give their slots back', async () => {
    const rs = await burst(25, () => ({ userKey: 'gh:1' }));
    expect(rs.filter((r) => r.allowed)).toHaveLength(DEFAULT_PROVISION_LIMITS.userPerHour);
    expect(rs.filter((r) => !r.allowed).every((r) => r.scope === 'user-hour' && (r.retryAfterSeconds ?? 0) > 0)).toBe(true);
    expect(await count('user:gh:1:h')).toBe(DEFAULT_PROVISION_LIMITS.userPerHour);
    expect(await count('user:gh:1:d')).toBe(DEFAULT_PROVISION_LIMITS.userPerHour);
  });

  it('per IP: 40 parallel provisions from fresh accounts on one IP admit exactly ipPerHour', async () => {
    const rs = await burst(40, (i) => ({ userKey: `gh:${100 + i}`, ip: IP }));
    expect(rs.filter((r) => r.allowed)).toHaveLength(DEFAULT_PROVISION_LIMITS.ipPerHour);
    expect(rs.filter((r) => !r.allowed).every((r) => r.scope === 'ip-hour')).toBe(true);
    expect(await count(`ip:${IP}:h`)).toBe(DEFAULT_PROVISION_LIMITS.ipPerHour);
  });

  it('over the cap: a burst admits nothing and spends nothing; the next window admits again', async () => {
    await env.DB.prepare('INSERT INTO provision_attempts (key, window_start, count) VALUES (?, ?, ?)')
      .bind('user:gh:2:h', NOW, DEFAULT_PROVISION_LIMITS.userPerHour).run();
    const rs = await burst(10, () => ({ userKey: 'gh:2', ip: IP, nowMs: NOW + 1000 }));
    expect(rs.some((r) => r.allowed)).toBe(false);
    expect(await count('user:gh:2:h')).toBe(DEFAULT_PROVISION_LIMITS.userPerHour);
    expect(await count(`ip:${IP}:h`)).toBeUndefined();

    const later = await burst(1, () => ({ userKey: 'gh:2', nowMs: NOW + 60 * 60 * 1000 }));
    expect(later[0]!.allowed).toBe(true);
    expect(await count('user:gh:2:h')).toBe(1);
  });
});
