import { SELF, env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { recordHealth } from '../../../backend/src/lib/metric-aggregates';
import { resetBurstState } from '../../../backend/src/lib/log-quota';
import { evaluateErrorSpikes } from '../../../backend/src/lib/error-alerts';
import { BASE, json, mockNetwork, resetTables, seedApp, seedUser, session } from './helpers';

// #391 on real D1: the health API tells "nothing happened" from "cannot tell",
// reports degraded on a failed component and clears on recovery, and stays owner-only.

const APP = 'health-demo';
type Health = {
  status: string;
  countsReliable: boolean;
  components: Record<'evaluator' | 'prune' | 'aggregates', { status: string; lastError: string | null }>;
  windows: { lastHour: { signals: Record<string, number>; detailDropped: { client: number; server: number } } };
  requests: { status: string; reason?: string; lastHour: unknown };
};
const health = async (token: string, appId = APP) => SELF.fetch(`${BASE}/v1/apps/${appId}/telemetry/health`, json('GET', undefined, token));
const read = async (token: string) => (await (await health(token)).json()) as Health;

beforeEach(async () => {
  mockNetwork();
  resetBurstState();
  await resetTables();
  await env.DB.prepare('DELETE FROM telemetry_health').run();
  await env.DB.prepare('DELETE FROM app_metric_buckets').run();
  await env.DB.prepare('DELETE FROM alert_evaluator_cursor').run();
  await seedUser('gh:1'); await seedApp(APP, 'gh:1');
  await seedUser('gh:2'); await seedApp('other-app', 'gh:2');
});

describe('telemetry health (#391)', () => {
  it('before anything has run, it is unknown — not a healthy zero', async () => {
    const res = await health(await session('gh:1'));
    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toContain('no-store');
    const h = await res.json() as Health;
    expect(h).toMatchObject({ status: 'unknown', countsReliable: false });
    expect(h.components.evaluator.status).toBe('unknown');
    expect(h.components.aggregates.status).toBe('no_data');
    expect(h.windows.lastHour.signals.client_error).toBe(0);
  });

  it('with a recent evaluation and a counted error, counts are reliable; AE being unreadable is reported, not zeroed', async () => {
    const token = await session('gh:1');
    await recordHealth(env.DB, 'evaluator', '', true, null);
    await SELF.fetch(`${BASE}/v1/apps/${APP}/logs`, json('POST', { entries: [{ level: 'error', category: 'runtime', message: 'x', ts: Date.now() }] }));
    const h = await read(token);
    expect(h.countsReliable).toBe(true);
    expect(h.components.evaluator.status).toBe('ok');
    expect(h.components.aggregates.status).toBe('ok');
    expect(h.windows.lastHour.signals.client_error).toBe(1);
    // This pool has no Analytics Engine read token: request totals are unknown, so the whole is degraded.
    expect(h.requests).toMatchObject({ status: 'unknown', reason: 'analytics_unavailable', lastHour: null });
    expect(h.status).toBe('degraded');
  });

  it('a failed evaluation is degraded, and the next success clears it', async () => {
    const token = await session('gh:1');
    const now = Date.now();
    await recordHealth(env.DB, 'evaluator', '', true, null, now - 60_000);
    await recordHealth(env.DB, 'evaluator', '', false, 'evaluation_failed', now - 30_000);
    expect((await read(token)).components.evaluator).toMatchObject({ status: 'degraded', lastError: 'evaluation_failed' });
    await recordHealth(env.DB, 'evaluator', '', true, null, now);
    expect((await read(token)).components.evaluator.status).toBe('ok');
  });

  it('an evaluator that stopped running goes stale: unknown, counts not reliable', async () => {
    await recordHealth(env.DB, 'evaluator', '', true, null, Date.now() - 20 * 60_000);
    const h = await read(await session('gh:1'));
    expect(h.components.evaluator.status).toBe('unknown');
    expect(h).toMatchObject({ status: 'unknown', countsReliable: false });
  });

  it('the scheduled tick and the prune stamp their own health', async () => {
    await SELF.scheduled({ scheduledTime: new Date(Math.floor(Date.now() / 300_000) * 300_000 + 60_000), cron: '*/5 * * * *' });
    const prune = await SELF.fetch(`${BASE}/v1/internal/logs/prune`, { method: 'POST', headers: { 'X-Internal-Token': env.INTERNAL_TOKEN } });
    expect(prune.status).toBe(200);
    const rows = (await env.DB.prepare("SELECT component, last_ok_at IS NOT NULL AS ok FROM telemetry_health WHERE app_id = '' ORDER BY component").all()).results;
    expect(rows).toEqual([{ component: 'evaluator', ok: 1 }, { component: 'prune', ok: 1 }]);
  });

  it("owner-only: another owner cannot read this app's health, a signed-out caller is refused", async () => {
    expect((await health(await session('gh:2'))).status).toBeGreaterThanOrEqual(403);
    expect((await SELF.fetch(`${BASE}/v1/apps/${APP}/telemetry/health`)).status).toBe(401);
  });
});

// #391/#389: after a scheduled-evaluator outage longer than its catch-up horizon,
// status recovers but the alerts for that range were never evaluated; the health
// API says so beside status, from the evaluator's cursor.
describe('alert coverage in telemetry health (#391/#389)', () => {
  const FIVE = 5 * 60_000;
  const aligned = (t: number) => Math.floor(t / FIVE) * FIVE;
  type Coverage = { alertCoverage: { complete: boolean; windowMs: number; gap: { start: number; end: number; recordedAt: number } | null } };

  it('a recorded gap reads incomplete beside a recovered evaluator, and complete once it is a day old', async () => {
    const before = aligned(Date.now() - 3 * 60 * 60_000);
    const after = aligned(Date.now() - 60 * 60_000);
    await evaluateErrorSpikes({ env, now: before, scheduled: true });
    const r = await evaluateErrorSpikes({ env, now: after, scheduled: true });
    expect(r.gap).toEqual({ start: before, end: after - 30 * 60_000 });
    // The tick's own success stamp follows, as index.ts does: the evaluator has recovered.
    await recordHealth(env.DB, 'evaluator', '', true, null);

    const h = await (await health(await session('gh:1'))).json() as Coverage & Health;
    // Recovered: the gap's failure stamp is older than the success, so it no longer degrades the evaluator.
    // (The whole reads degraded in this pool only because it has no AE read token; see above.)
    expect(h.components.evaluator).toMatchObject({ status: 'ok', lastError: 'gap' });
    expect(h.countsReliable).toBe(true);
    expect(h.alertCoverage).toEqual({ complete: false, windowMs: 24 * 60 * 60_000, gap: { start: before, end: after - 30 * 60_000, recordedAt: after } });

    await env.DB.prepare("UPDATE alert_evaluator_cursor SET gap_end = ? WHERE id = 'scheduled'").bind(Date.now() - 25 * 60 * 60_000).run();
    expect((await (await health(await session('gh:1'))).json() as Coverage).alertCoverage).toEqual({ complete: true, windowMs: 24 * 60 * 60_000, gap: null });
  });

  it('with no scheduled run yet there is no recorded gap; the cursor read is one primary-key lookup', async () => {
    expect((await read(await session('gh:1')) as unknown as Coverage).alertCoverage.complete).toBe(true);
    const plan = ((await env.DB.prepare("EXPLAIN QUERY PLAN SELECT gap_start, gap_end, gap_recorded_at FROM alert_evaluator_cursor WHERE id = 'scheduled'").all<{ detail: string }>()).results ?? []).map((x) => x.detail).join(' | ');
    expect(plan).toMatch(/SEARCH alert_evaluator_cursor USING/);
    expect(plan).not.toMatch(/SCAN/);
  });
});
