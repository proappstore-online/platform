import { SELF, env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { ERROR_SPIKE_MIN, evaluateErrorSpikes } from '../../../backend/src/lib/error-alerts';
import { resetBurstState } from '../../../backend/src/lib/log-quota';
import { BASE, mockNetwork, resetTables, seedApp, seedUser } from './helpers';

// #438: POST /v1/apps/:id/logs is unauthenticated. On the real worker, real D1 and the real
// rate-limit bindings, an anonymous burst must (1) be refused before any D1 work once past the
// per-(app, IP) bound, and (2) never raise an error-spike alert however it rotates clientIds.

const APP = 'flood-demo';
const IP = '203.0.113.50';
const post = (clientId: string, ip = IP) => SELF.fetch(`${BASE}/v1/apps/${APP}/logs`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'cf-connecting-ip': ip },
  body: JSON.stringify({ clientId, entries: Array.from({ length: 5 }, (_, i) => ({ ts: Date.now(), level: 'error', category: 'runtime', message: `boom ${i}` })) }),
});
const count = async (sql: string) => ((await env.DB.prepare(sql).bind(APP).first<{ n: number }>())?.n ?? 0);

beforeEach(async () => {
  mockNetwork(); resetBurstState(); await resetTables();
  await env.DB.prepare('DELETE FROM app_metric_buckets').run();
  await env.DB.prepare('DELETE FROM app_alerts').run();
  await env.DB.prepare('DELETE FROM alert_evaluator_cursor').run();
  await seedUser('gh:1'); await seedApp(APP, 'gh:1');
});

describe('anonymous log flood (#438)', () => {
  it('past the per-(app, IP) bound the route answers 429 and writes nothing', async () => {
    const flood = '203.0.113.60';
    const statuses: number[] = [];
    for (let i = 0; i < 100; i++) statuses.push((await post(`rot-${i}-xxxxxxxx`, flood)).status);
    const refused = statuses.filter((s) => s === 429).length;
    expect(refused).toBeGreaterThanOrEqual(10); // 30 per 60 s: at most 30 + one window boundary get through
    const first429 = statuses.indexOf(429);
    const rowsAtRefusal = await count("SELECT COUNT(*) AS n FROM app_logs WHERE app_id = ?");
    // Refused requests added no rows: the stored rows are bounded by the admitted requests.
    expect(rowsAtRefusal).toBeLessThanOrEqual((statuses.length - refused) * 5);
    expect(first429).toBeGreaterThan(0);
    const res = await post('rot-after-xxxxxxxx', flood);
    expect(res.status).toBe(429);
    expect(res.headers.get('Retry-After')).toBe('60');
  });

  it('rotating clientIds from one IP cannot raise an error-spike alert', async () => {
    for (let i = 0; i < 100; i++) await post(`spoof-${i}-xxxxxxxx`);
    const counted = await count("SELECT COALESCE(SUM(n), 0) AS n FROM app_metric_buckets WHERE app_id = ? AND signal = 'client_error'");
    expect(counted).toBeLessThan(ERROR_SPIKE_MIN);
    // Evaluate every completed window that could contain the burst.
    const now = Date.now() + 30 * 60_000;
    const { alerts } = await evaluateErrorSpikes({ env, now });
    expect(alerts.filter((a) => a.app_id === APP)).toEqual([]);
    expect(await count("SELECT COUNT(*) AS n FROM app_alerts WHERE app_id = ?")).toBe(0);
  });

  it('ordinary logging still works: one client posts, rows are stored, the error is counted once', async () => {
    const res = await post('well-behaved-client', '203.0.113.70');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, ingested: 5 });
    expect(await count("SELECT COUNT(*) AS n FROM app_logs WHERE app_id = ?")).toBe(5);
    expect(await count("SELECT COALESCE(SUM(n), 0) AS n FROM app_metric_buckets WHERE app_id = ? AND signal = 'client_error'")).toBe(1);
  });

  it('many distinct sources still raise the alert: a real incident is not suppressed', async () => {
    // A genuine incident is many clients on many IPs; each adds one per minute.
    for (let i = 0; i < ERROR_SPIKE_MIN + 5; i++) await post(`real-${i}-xxxxxxxx`, `198.51.100.${i + 1}`);
    const counted = await count("SELECT COALESCE(SUM(n), 0) AS n FROM app_metric_buckets WHERE app_id = ? AND signal = 'client_error'");
    expect(counted).toBe(ERROR_SPIKE_MIN + 5);
  });
});
