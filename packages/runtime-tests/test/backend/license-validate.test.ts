import { SELF, env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { BASE, mockNetwork, resetTables, seedApp } from './helpers';

// #324 on workerd and real D1: /v1/license/validate is anonymous and `appId`
// comes from the body. One IP must not escape the throttle by rotating app ids,
// and invented ids must not create limiter rows.

const IP_CEILING = 30; // lib/license-rate-limit MAX_VALIDATE_IP_ATTEMPTS
const PER_APP = 10; // MAX_VALIDATE_ATTEMPTS
const WINDOW_MS = 60_000;
const KEY = 'license-key-runtime';

async function validate(appId: unknown, key = KEY, ip = '203.0.113.9'): Promise<{ status: number; body: unknown }> {
  const res = await SELF.fetch(`${BASE}/v1/license/validate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': ip },
    body: JSON.stringify({ appId, key }),
  });
  return { status: res.status, body: await res.json() };
}
const rows = async () => (await env.DB.prepare('SELECT key, count FROM license_validate_attempts ORDER BY key').all<{ key: string; count: number }>()).results;

beforeEach(async () => {
  mockNetwork();
  await resetTables();
  for (const t of ['license_validate_attempts', 'licenses', 'subscriptions']) await env.DB.prepare(`DELETE FROM ${t}`).run();
  await seedApp('myapp', 'gh:9');
  await env.DB.prepare("INSERT INTO licenses (key, app_id, user_id, issued_at) VALUES (?, 'myapp', 'gh:1', 1)").bind(KEY).run();
  await env.DB.prepare("INSERT INTO subscriptions (user_id, stripe_customer_id, status, tier, created_at, updated_at) VALUES ('gh:1', 'cus_1', 'active', 'pro', 1, 1)").run();
});

describe('license validation cannot be un-throttled by rotating app ids (#324)', () => {
  it('a valid license still validates, and a wrong key is the same bare {valid:false}', async () => {
    expect(await validate('myapp')).toEqual({ status: 200, body: { valid: true } });
    expect(await validate('myapp', 'wrong')).toEqual({ status: 200, body: { valid: false } });
  });

  it('sequential: invented app ids share the per-IP ceiling and create no per-app rows', async () => {
    for (let i = 0; i < IP_CEILING; i++) expect(await validate(`fake-app-${i}`)).toEqual({ status: 200, body: { valid: false } });
    expect((await validate('fake-app-next')).status).toBe(429);
    expect((await validate('myapp')).status).toBe(429); // the ceiling covers real apps too
    expect(await rows()).toEqual([{ key: 'ip:203.0.113.9', count: IP_CEILING }]);
    expect(await validate('myapp', KEY, '198.51.100.1')).toEqual({ status: 200, body: { valid: true } }); // another IP is unaffected
  });

  it('concurrent: 60 parallel requests with distinct ids get exactly the ceiling, and no per-app rows', async () => {
    const results = await Promise.all(Array.from({ length: 60 }, (_, i) => validate(`fake-app-${i}`)));
    expect(results.filter((r) => r.status === 200)).toHaveLength(IP_CEILING);
    expect(results.filter((r) => r.status === 429)).toHaveLength(60 - IP_CEILING);
    expect(await rows()).toEqual([{ key: 'ip:203.0.113.9', count: IP_CEILING }]);
  });

  it('concurrent guesses against one real app stop at the per-app limit', async () => {
    const results = await Promise.all(Array.from({ length: 25 }, (_, i) => validate('myapp', `guess-${i}`)));
    expect(results.filter((r) => r.status === 200)).toHaveLength(PER_APP);
    expect(await rows()).toEqual([{ key: '203.0.113.9:myapp', count: PER_APP }, { key: 'ip:203.0.113.9', count: 25 }]);
  });

  it('malformed app ids answer {valid:false} and write nothing', async () => {
    for (const id of ['UPPER', '1abc', 'a'.repeat(59), 'x:y', 42, '']) expect((await validate(id)).body).toEqual({ valid: false });
    expect(await rows()).toEqual([]);
  });

  it('the ceiling lifts when its window expires', async () => {
    for (let i = 0; i < IP_CEILING; i++) await validate(`fake-app-${i}`);
    expect((await validate('myapp')).status).toBe(429);
    await env.DB.prepare('UPDATE license_validate_attempts SET window_start = window_start - ?').bind(WINDOW_MS).run();
    expect(await validate('myapp')).toEqual({ status: 200, body: { valid: true } });
    expect(await rows()).toEqual([{ key: '203.0.113.9:myapp', count: 1 }, { key: 'ip:203.0.113.9', count: 1 }]);
  });
});
