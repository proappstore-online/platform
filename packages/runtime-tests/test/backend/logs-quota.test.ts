import { SELF, env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { BASE, json, seedApp, seedUser, mockNetwork, resetTables, session, viaHostApi } from './helpers';

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
    const res = await viaHostApi(`${BASE}/v1/apps/demo/logs`, { ...json('POST', { entries: entries(1) }), headers: { 'Content-Type': 'application/json', 'X-PAS-App': 'other' } });
    expect(res.status).toBe(403);
  });

  it("a caller-chosen clientId cannot spend a signed-in user's burst budget (#316)", async () => {
    await seedUser('gh:1'); await seedApp('demo', 'gh:1');
    // An anonymous flood under clientId 'gh:1' spends client:gh:1's burst (the key mapping is unit-tested in
    // log-quota.test.ts; the per-second window makes the anonymous throttle itself timing-dependent here)…
    for (let i = 0; i < 3; i++) await SELF.fetch(`${BASE}/v1/apps/demo/logs`, json('POST', { entries: entries(100), clientId: 'gh:1' }));
    // …and the signed-in gh:1 still has its own bucket (user:gh:1).
    const signedIn = await SELF.fetch(`${BASE}/v1/apps/demo/logs`, json('POST', { entries: entries(1) }, await session('gh:1')));
    expect(await signedIn.json()).toMatchObject({ ok: true, ingested: 1 });
  });
});
