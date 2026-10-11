import { SELF, env as providedEnv, fetchMock } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import type { Env } from '../../../backend/src/types';
import { DAILY_ENTRY_LIMIT } from '../../../backend/src/lib/log-ingest';
import { utcDayKey } from '../../../backend/src/lib/day-key';
import { resetBurstState } from '../../../backend/src/lib/log-quota';
import { BASE, json, mockNetwork, resetTables, seedApp, seedUser, session } from './helpers';

const env = providedEnv as unknown as Env;

// #376 on real D1: each cap is checked by the statement that spends it, so N
// concurrent requests at limit - 1 — interleaving at every await, as in
// production — let exactly one through. Before, every request passed a count
// read before any of them wrote.

const APP = 'quota';
const N = 10;
const nowSec = () => Math.floor(Date.now() / 1000);
const count = async (sql: string, ...args: unknown[]) => (await env.DB.prepare(sql).bind(...args).first<{ n: number }>())!.n;
const statuses = (responses: Response[]) => responses.map((r) => r.status).sort((a, b) => a - b);

beforeEach(async () => {
  mockNetwork();
  resetBurstState();
  await resetTables();
  for (const t of ['email_usage', 'notification_log', 'push_subscriptions', 'app_log_usage']) await env.DB.prepare(`DELETE FROM ${t}`).run();
  await seedUser('gh:1');
  await seedUser('gh:2');
  await seedApp(APP, 'gh:1');
});

describe('concurrent requests at limit - 1 let exactly one through (#376)', () => {
  it('email: the 100/day app cap', async () => {
    for (let i = 0; i < 99; i++) {
      await env.DB.prepare('INSERT INTO email_usage (app_id, user_id, sent_at) VALUES (?, ?, ?)').bind(APP, 'gh:1', nowSec()).run();
    }
    fetchMock.get('https://api.resend.com').intercept({ path: '/emails', method: 'POST' }).reply(200, { id: 'e' }).persist();
    const token = await session('gh:1');
    const send = () => SELF.fetch(`${BASE}/v1/email/send`, json('POST', { appId: APP, to: 'someone@example.com', subject: 'Hi', body: 'Hello' }, token));
    const responses = await Promise.all(Array.from({ length: N }, send));
    expect(statuses(responses)).toEqual([200, ...Array(N - 1).fill(429)]);
    expect(await count('SELECT COUNT(*) AS n FROM email_usage WHERE app_id = ?', APP)).toBe(100);
  });

  it('notifications: the 10/minute per-recipient cap', async () => {
    await env.DB.prepare("INSERT INTO push_subscriptions (id, user_id, app_id, endpoint, p256dh, auth_secret, created_at) VALUES ('s1', 'gh:1', ?, 'https://push.test/1', 'p', 'a', 1)").bind(APP).run();
    for (let i = 0; i < 9; i++) {
      await env.DB.prepare('INSERT INTO notification_log (sender_id, app_id, target_user_id, sent_at) VALUES (?, ?, ?, ?)').bind(`gh:other-${i}`, APP, 'gh:2', nowSec()).run();
    }
    const token = await session('gh:1');
    const notify = () => SELF.fetch(`${BASE}/v1/notifications/notify-user`, json('POST', { appId: APP, targetUserId: 'gh:2', title: 'T', body: 'B' }, token));
    const responses = await Promise.all(Array.from({ length: N }, notify));
    expect(statuses(responses)).toEqual([200, ...Array(N - 1).fill(429)]);
    expect(await count('SELECT COUNT(*) AS n FROM notification_log WHERE app_id = ? AND target_user_id = ?', APP, 'gh:2')).toBe(10);
  });

  it('logs: the daily entry budget', async () => {
    await env.DB.prepare('INSERT INTO app_log_usage (app_id, day, count) VALUES (?, ?, ?)').bind(APP, utcDayKey(Date.now()), DAILY_ENTRY_LIMIT - 1).run();
    // Distinct clients, so the per-isolate burst limit is not what refuses them.
    const post = (i: number) => SELF.fetch(`${BASE}/v1/apps/${APP}/logs`, json('POST', {
      clientId: `install-${String(i).padStart(8, '0')}`,
      entries: [{ ts: Date.now(), level: 'error', category: 'app', message: `boom ${i}` }],
    }));
    const responses = await Promise.all(Array.from({ length: N }, (_, i) => post(i)));
    const ingested = (await Promise.all(responses.map((r) => r.json<{ ingested?: number }>()))).map((b) => b.ingested ?? 0);
    expect(ingested.reduce((a, b) => a + b, 0)).toBe(1);
    expect(await count('SELECT count AS n FROM app_log_usage WHERE app_id = ? AND day = ?', APP, utcDayKey(Date.now()))).toBe(DAILY_ENTRY_LIMIT);
    expect(await count('SELECT COUNT(*) AS n FROM app_logs WHERE app_id = ?', APP)).toBe(1);
  });
});
