import { SELF, env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { BASE, mockNetwork } from './helpers';

// #223: the daily prune deletes expired rate-limit ledger rows on real D1 and
// keeps every row a rate-limit check still reads. Units differ per table.
const LEDGERS = ['maps_usage', 'sms_usage', 'notification_log'] as const;
// #27: per-day / per-window rate-limit counters, pruned with the ledgers.
const COUNTERS = ['app_proxy_usage', 'app_proxy_usage_user', 'ai_daily_budget', 'license_validate_attempts', 'provision_attempts'] as const;
const count = async (t: string) => (await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${t}`).first<{ n: number }>())!.n;
const prune = () => SELF.fetch(`${BASE}/v1/internal/logs/prune`, { method: 'POST', headers: { 'X-Internal-Token': env.INTERNAL_TOKEN } });

beforeEach(async () => {
  mockNetwork();
  for (const t of [...LEDGERS, ...COUNTERS, 'webhook_deliveries', 'app_webhooks']) await env.DB.prepare(`DELETE FROM ${t}`).run();
});

describe('rate-limit ledger retention against real D1', () => {
  it('deletes rows past retention; keeps in-window and just-inside-retention rows', async () => {
    const nowMs = Date.now();
    const nowS = Math.floor(nowMs / 1000);
    const old = 3 * 86_400; // seconds: past the 2-day retention
    const recent = 86_400; // seconds: older than every window, still inside retention
    for (const ts of [nowS - old, nowS - old - 60, nowS - recent, nowS - 30]) {
      await env.DB.prepare('INSERT INTO maps_usage (user_id, ts) VALUES (?, ?)').bind('gh:1', ts).run();
      await env.DB.prepare('INSERT INTO notification_log (sender_id, app_id, target_user_id, sent_at) VALUES (?, ?, ?, ?)').bind('gh:1', 'demo', 'gh:2', ts).run();
      await env.DB.prepare('INSERT INTO sms_usage (app_id, sent_at) VALUES (?, ?)').bind('demo', ts * 1000).run();
    }

    const res = await prune();
    expect(res.status).toBe(200);
    const body = await res.json() as { ledgerRowsDeleted: Record<string, number>; ledgerBacklog: boolean; ledgerErrors: Record<string, string> };
    expect(body.ledgerRowsDeleted).toMatchObject({ maps_usage: 2, sms_usage: 2, notification_log: 2 });
    expect(body.ledgerBacklog).toBe(false);
    expect(body.ledgerErrors).toEqual({});
    for (const t of LEDGERS) expect(await count(t)).toBe(2);

    // The in-window rows the limiters read are intact.
    const inWindow = await env.DB.prepare('SELECT COUNT(*) AS n FROM maps_usage WHERE ts > ?').bind(nowS - 3600).first<{ n: number }>();
    expect(inWindow!.n).toBe(1);
    const smsToday = await env.DB.prepare('SELECT COUNT(*) AS n FROM sms_usage WHERE sent_at >= ?').bind(nowMs - 60_000).first<{ n: number }>();
    expect(smsToday!.n).toBe(1);
  });

  it('is idempotent: a second run deletes nothing', async () => {
    await env.DB.prepare('INSERT INTO maps_usage (user_id, ts) VALUES (?, ?)').bind('gh:1', Math.floor(Date.now() / 1000) - 10).run();
    await prune();
    const body = await (await prune()).json() as { ledgerRowsDeleted: Record<string, number> };
    expect(body.ledgerRowsDeleted).toEqual({
      maps_usage: 0, sms_usage: 0, notification_log: 0, webhook_deliveries: 0, webhook_deliveries_orphaned: 0,
      app_proxy_usage: 0, app_proxy_usage_user: 0, ai_daily_budget: 0, license_validate_attempts: 0, provision_attempts: 0,
    });
    expect(await count('maps_usage')).toBe(1);
  });
});

// #27: the webhook delivery log (full payloads, never read) keeps 7 days and
// drops rows whose webhook was deleted.
describe('webhook delivery log retention against real D1', () => {
  const addHook = (id: string) => env.DB.prepare(
    'INSERT INTO app_webhooks (id, app_id, event, url, secret) VALUES (?, ?, ?, ?, ?)',
  ).bind(id, 'demo', 'storage.uploaded', 'https://hooks.example.com/in', 's3cret').run();
  const addDelivery = (id: string, webhookId: string, createdAt: number) => env.DB.prepare(
    `INSERT INTO webhook_deliveries (id, webhook_id, event, payload, status, attempts, last_attempt_at, created_at)
     VALUES (?, ?, 'storage.uploaded', '{"userId":"gh:2"}', 200, 1, ?, ?)`,
  ).bind(id, webhookId, createdAt, createdAt).run();
  const remaining = async () => (await env.DB.prepare('SELECT id FROM webhook_deliveries ORDER BY id').all<{ id: string }>()).results.map((r) => r.id);

  it('deletes rows past 7 days and keeps rows just inside it', async () => {
    const nowS = Math.floor(Date.now() / 1000);
    const week = 7 * 86_400;
    await addHook('hook-live');
    await addDelivery('a-past', 'hook-live', nowS - week - 60);
    await addDelivery('b-past-far', 'hook-live', nowS - 30 * 86_400);
    await addDelivery('c-inside', 'hook-live', nowS - week + 60);
    await addDelivery('d-recent', 'hook-live', nowS - 5);

    const body = await (await prune()).json() as { webhookDeliveryRetentionDays: number; ledgerRowsDeleted: Record<string, number>; ledgerErrors: Record<string, string> };
    expect(body.webhookDeliveryRetentionDays).toBe(7);
    expect(body.ledgerRowsDeleted).toMatchObject({ webhook_deliveries: 2, webhook_deliveries_orphaned: 0 });
    expect(body.ledgerErrors).toEqual({});
    expect(await remaining()).toEqual(['c-inside', 'd-recent']);
  });

  it("deletes a deleted webhook's rows, however recent, and keeps live webhooks' rows", async () => {
    const nowS = Math.floor(Date.now() / 1000);
    await addHook('hook-live');
    await addDelivery('live-1', 'hook-live', nowS - 60);
    await addDelivery('gone-1', 'hook-gone', nowS - 60);
    await addDelivery('gone-2', 'hook-gone', nowS - 5);

    const body = await (await prune()).json() as { ledgerRowsDeleted: Record<string, number> };
    expect(body.ledgerRowsDeleted).toMatchObject({ webhook_deliveries: 0, webhook_deliveries_orphaned: 2 });
    expect(await remaining()).toEqual(['live-1']);

    // Idempotent: nothing left to delete.
    const again = await (await prune()).json() as { ledgerRowsDeleted: Record<string, number> };
    expect(again.ledgerRowsDeleted).toMatchObject({ webhook_deliveries: 0, webhook_deliveries_orphaned: 0 });
  });
});

// #27: counters are read only for today / the current window. Past-retention
// rows go; today's, yesterday's and every live window keep their counts.
describe('rate-limit counter retention against real D1', () => {
  it('deletes counters older than 2 days and keeps live windows with their counts', async () => {
    const nowMs = Date.now();
    const day = (daysAgo: number) => new Date(nowMs - daysAgo * 86_400_000).toISOString().slice(0, 10);
    for (const [d, n] of [[0, 7], [1, 5], [3, 9], [10, 1]] as const) {
      await env.DB.prepare('INSERT INTO app_proxy_usage (app_id, day, count) VALUES (?, ?, ?)').bind('demo', day(d), n).run();
      await env.DB.prepare('INSERT INTO app_proxy_usage_user (app_id, user_id, day, count) VALUES (?, ?, ?, ?)').bind('demo', 'gh:1', day(d), n).run();
      await env.DB.prepare('INSERT INTO ai_daily_budget (user_id, date, units_used) VALUES (?, ?, ?)').bind('gh:1', day(d), n).run();
    }
    const windows: [string, number, number][] = [
      ['ip:live', nowMs - 30_000, 4], // inside its 60 s / 1 h window
      ['user:gh:1:d', nowMs - 20 * 3_600_000, 3], // inside the 24 h window
      ['ip:gone', nowMs - 3 * 86_400_000, 8],
    ];
    for (const [key, start, n] of windows) {
      await env.DB.prepare('INSERT INTO license_validate_attempts (key, window_start, count) VALUES (?, ?, ?)').bind(key, start, n).run();
      await env.DB.prepare('INSERT INTO provision_attempts (key, window_start, count) VALUES (?, ?, ?)').bind(key, start, n).run();
    }

    const res = await prune();
    expect(res.status).toBe(200);
    const body = await res.json() as { ledgerRowsDeleted: Record<string, number>; ledgerErrors: Record<string, string>; ledgerBacklog: boolean };
    expect(body.ledgerRowsDeleted).toMatchObject({
      app_proxy_usage: 2, app_proxy_usage_user: 2, ai_daily_budget: 2, license_validate_attempts: 1, provision_attempts: 1,
    });
    expect(body.ledgerErrors).toEqual({});
    expect(body.ledgerBacklog).toBe(false);

    // Today's and yesterday's counts are untouched, so the limiters still see them.
    const today = await env.DB.prepare('SELECT count FROM app_proxy_usage_user WHERE app_id = ? AND user_id = ? AND day = ?').bind('demo', 'gh:1', day(0)).first<{ count: number }>();
    expect(today?.count).toBe(7);
    const budget = await env.DB.prepare('SELECT date, units_used FROM ai_daily_budget ORDER BY date DESC').all<{ date: string; units_used: number }>();
    expect(budget.results).toEqual([{ date: day(0), units_used: 7 }, { date: day(1), units_used: 5 }]);
    for (const t of ['license_validate_attempts', 'provision_attempts']) {
      const rows = await env.DB.prepare(`SELECT key, count FROM ${t} ORDER BY key`).all<{ key: string; count: number }>();
      expect(rows.results).toEqual([{ key: 'ip:live', count: 4 }, { key: 'user:gh:1:d', count: 3 }]);
    }
  });
});
