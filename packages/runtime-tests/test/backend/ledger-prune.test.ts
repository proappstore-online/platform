import { SELF, env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { BASE, mockNetwork } from './helpers';

// #223: the daily prune deletes expired rate-limit ledger rows on real D1 and
// keeps every row a rate-limit check still reads. Units differ per table.
const LEDGERS = ['maps_usage', 'sms_usage', 'notification_log'] as const;
const count = async (t: string) => (await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${t}`).first<{ n: number }>())!.n;
const prune = () => SELF.fetch(`${BASE}/v1/internal/logs/prune`, { method: 'POST', headers: { 'X-Internal-Token': env.INTERNAL_TOKEN } });

beforeEach(async () => {
  mockNetwork();
  for (const t of LEDGERS) await env.DB.prepare(`DELETE FROM ${t}`).run();
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
    expect(body.ledgerRowsDeleted).toEqual({ maps_usage: 2, sms_usage: 2, notification_log: 2 });
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
    expect(body.ledgerRowsDeleted).toEqual({ maps_usage: 0, sms_usage: 0, notification_log: 0 });
    expect(await count('maps_usage')).toBe(1);
  });
});
