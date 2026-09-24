import { SELF, env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { BASE, json, seedApp, seedUser, mockNetwork, resetTables } from './helpers';

const entries = (n: number) => Array.from({ length: n }, (_, i) => ({ ts: Date.now(), level: 'error', category: 'client', message: `boom ${i}` }));
const dayKey = () => new Date().toISOString().slice(0, 10);

beforeEach(async () => { mockNetwork(); await resetTables(); });

describe('log ingestion and quota against real D1 tables', () => {
  it('404 for an unknown app; stores entries and counts usage for a known one', async () => {
    expect((await SELF.fetch(`${BASE}/v1/apps/ghost/logs`, json('POST', { entries: entries(1) }))).status).toBe(404);
    await seedUser('gh:1'); await seedApp('demo', 'gh:1');
    const res = await SELF.fetch(`${BASE}/v1/apps/demo/logs`, json('POST', { entries: entries(3), clientId: 'client-a' }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, ingested: 3 });
    const stored = await env.DB.prepare("SELECT COUNT(*) AS n FROM app_logs WHERE app_id = 'demo'").first<{ n: number }>();
    expect(stored?.n).toBe(3);
    const usage = await env.DB.prepare("SELECT count FROM app_log_usage WHERE app_id = 'demo' AND day = ?").bind(dayKey()).first<{ count: number }>();
    expect(usage?.count).toBe(3);
  });

  it('over the daily quota: 202, counted, not stored', async () => {
    await seedUser('gh:1'); await seedApp('demo', 'gh:1');
    await env.DB.prepare("INSERT INTO app_log_usage (app_id, day, count) VALUES ('demo', ?, 50000)").bind(dayKey()).run();
    const res = await SELF.fetch(`${BASE}/v1/apps/demo/logs`, json('POST', { entries: entries(2), clientId: 'client-b' }));
    expect(res.status).toBe(202);
    const stored = await env.DB.prepare("SELECT COUNT(*) AS n FROM app_logs WHERE app_id = 'demo'").first<{ n: number }>();
    expect(stored?.n).toBe(0);
    const usage = await env.DB.prepare("SELECT count FROM app_log_usage WHERE app_id = 'demo' AND day = ?").bind(dayKey()).first<{ count: number }>();
    expect(usage!.count).toBeGreaterThanOrEqual(50000);
  });

  it('a mediated request for a different app is refused', async () => {
    await seedUser('gh:1'); await seedApp('demo', 'gh:1');
    const res = await SELF.fetch(`${BASE}/v1/apps/demo/logs`, { ...json('POST', { entries: entries(1) }), headers: { 'Content-Type': 'application/json', 'X-PAS-App': 'other' } });
    expect(res.status).toBe(403);
  });
});
