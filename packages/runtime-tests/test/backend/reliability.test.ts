import { SELF, env as providedEnv, fetchMock } from 'cloudflare:test';
import type { Env } from '../../../backend/src/types';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BUCKET_MS, evaluateReliability, evaluationEnd, type OutcomeBucket } from '../../../backend/src/lib/reliability';
import { dispatchWebhook, MAX_DELIVERY_ATTEMPTS, retryDueDeliveries } from '../../../backend/src/lib/webhook-dispatch';
import { BASE, json, mockNetwork, resetTables, seedApp, seedUser, session } from './helpers';

// #395 on real D1: reliability incidents fire once, can be acknowledged and
// recover, notify only an owner-configured webhook, retry failed deliveries
// visibly and boundedly, and turn unreadable telemetry into monitoring_degraded.

const env = providedEnv as unknown as Env;
const APP = 'rel-demo';
const NOW = 1_800_000_000_000 + 7 * BUCKET_MS + 60_000;
const END = evaluationEnd(NOW);
const HOOK = 'https://hooks.example';

const series = (bad: (i: number) => number, total = 50): OutcomeBucket[] =>
  Array.from({ length: 72 }, (_, i) => ({ app: APP, family: 'actions', start: END - (72 - i) * BUCKET_MS, total, bad: bad(i) }));
const severe = series((i) => (i >= 68 ? 30 : 0));
const clean = series(() => 0);
const evaluate = (buckets: OutcomeBucket[] | 'down', now = NOW) =>
  evaluateReliability({ env, now, read: async () => { if (buckets === 'down') throw new Error('CF Analytics SQL failed (503)'); return buckets; } });
const incidents = async () => ((await env.DB.prepare('SELECT id, rule, state FROM app_incidents WHERE app_id = ? ORDER BY id').bind(APP).all<{ id: number; rule: string; state: string }>()).results ?? []);
const deliveries = async () => ((await env.DB.prepare('SELECT status, attempts, next_attempt_at, last_error, payload FROM webhook_deliveries ORDER BY created_at, rowid').all<Record<string, unknown>>()).results ?? []);

async function webhook(id = 'wh1', event = 'app.alert') {
  await env.DB.prepare("INSERT INTO app_webhooks (id, app_id, event, url, secret, created_at) VALUES (?, ?, ?, 'https://hooks.example/alert', 's3cret', 1)").bind(id, APP, event).run();
}

beforeEach(async () => {
  mockNetwork();
  await resetTables();
  for (const t of ['app_incidents', 'app_reliability_objectives', 'webhook_deliveries', 'app_webhooks']) await env.DB.prepare(`DELETE FROM ${t}`).run();
  await seedUser('gh:1'); await seedApp(APP, 'gh:1');
  await seedUser('gh:2'); await seedApp('rel-other', 'gh:2');
  await env.DB.prepare("INSERT INTO app_reliability_objectives (app_id, family, target, enabled, updated_at) VALUES (?, 'actions', 0.99, 1, 1)").bind(APP).run();
});
afterEach(() => fetchMock.assertNoPendingInterceptors());

describe('reliability incidents (#395)', () => {
  it('fires once across repeated evaluation, stays quiet when acknowledged, recovers once', async () => {
    await webhook();
    const sent: string[] = [];
    fetchMock.get(HOOK).intercept({ path: '/alert', method: 'POST' }).reply(200, (req) => { sent.push(String(req.body)); return 'ok'; }).times(2);

    expect(await evaluate(severe)).toMatchObject({ opened: 1, recovered: 0 });
    for (let i = 0; i < 3; i++) expect(await evaluate(severe, NOW + i * 60_000)).toMatchObject({ opened: 0, recovered: 0 });
    expect((await incidents()).filter((r) => r.state !== 'recovered').map((r) => [r.rule, r.state])).toEqual([['burn_fast:actions', 'firing']]);
    expect(sent).toHaveLength(1);

    const [inc] = await incidents();
    const ack = await SELF.fetch(`${BASE}/v1/apps/${APP}/reliability/incidents/${inc!.id}/ack`, json('POST', undefined, await session('gh:1')));
    expect(ack.status).toBe(200);
    await evaluate(severe);
    expect((await incidents())[0]!.state).toBe('acknowledged');
    expect(sent).toHaveLength(1);

    expect(await evaluate(clean)).toMatchObject({ recovered: 1 });
    expect((await incidents())[0]!.state).toBe('recovered');
    await evaluate(clean);
    expect(sent).toHaveLength(2);
    const [firing, recovered] = sent.map((s) => JSON.parse(s) as Record<string, unknown>);
    expect(firing).toMatchObject({ event: 'app.alert', kind: 'reliability', state: 'firing', app_id: APP, rule: 'burn_fast:actions' });
    expect(recovered).toMatchObject({ state: 'recovered', rule: 'burn_fast:actions' });
    // No secrets, user ids or raw payloads in an alert.
    expect(sent.join('')).not.toMatch(/s3cret|gh:1|Bearer|password/);
  });

  it('no owner-configured webhook, no notification — the incident is still recorded', async () => {
    expect(await evaluate(severe)).toMatchObject({ opened: 1 });
    expect(await deliveries()).toEqual([]);
  });

  it('a different event type is not an alert destination', async () => {
    await webhook('wh-other', 'storage.uploaded');
    await evaluate(severe);
    expect(await deliveries()).toEqual([]);
  });

  it('unreadable telemetry opens monitoring_degraded, changes no burn incident, and clears on recovery', async () => {
    await evaluate(severe);
    await evaluate('down');
    expect((await incidents()).filter((r) => r.state !== 'recovered').map((r) => r.rule).sort()).toEqual(['burn_fast:actions', 'monitoring_degraded']);
    await evaluate(clean);
    expect((await incidents()).every((r) => r.state === 'recovered')).toBe(true);
  });

  it('an app without objectives is never evaluated', async () => {
    await env.DB.prepare('DELETE FROM app_reliability_objectives').run();
    expect(await evaluate(severe)).toEqual({ opened: 0, recovered: 0, notified: 0, evaluated: 0 });
  });
});

describe('alert delivery retry (#395)', () => {
  it('a failed app.alert delivery retries with backoff, is visible to the owner, and stops on success', async () => {
    await webhook();
    fetchMock.get(HOOK).intercept({ path: '/alert', method: 'POST' }).reply(503, 'down');
    await dispatchWebhook(env.DB, APP, 'app.alert', { event: 'app.alert', rule: 'x' });
    let [d] = await deliveries();
    expect(d).toMatchObject({ status: 503, attempts: 1, last_error: 'HTTP 503' });
    const due = Number(d!.next_attempt_at);
    expect(due).toBeGreaterThan(Date.now() / 1000);

    expect(await retryDueDeliveries(env.DB, (due - 1) * 1000)).toBe(0); // not yet due
    fetchMock.get(HOOK).intercept({ path: '/alert', method: 'POST' }).reply(200, 'ok');
    expect(await retryDueDeliveries(env.DB, due * 1000)).toBe(1);
    [d] = await deliveries();
    expect(d).toMatchObject({ status: 200, attempts: 2, next_attempt_at: null, last_error: null });

    const log = await SELF.fetch(`${BASE}/v1/apps/${APP}/reliability/deliveries`, json('GET', undefined, await session('gh:1')));
    const body = await log.json() as { deliveries: Record<string, unknown>[] };
    expect(body.deliveries[0]).toMatchObject({ event: 'app.alert', status: 200, attempts: 2 });
    expect(JSON.stringify(body)).not.toMatch(/payload|s3cret|hooks\.example/);
    expect((await SELF.fetch(`${BASE}/v1/apps/${APP}/reliability/deliveries`, json('GET', undefined, await session('gh:2')))).status).toBeGreaterThanOrEqual(403);
  });

  it('retries are bounded, a refusing 4xx is not retried, and other events keep a single attempt', async () => {
    await webhook();
    fetchMock.get(HOOK).intercept({ path: '/alert', method: 'POST' }).reply(500, 'x').times(MAX_DELIVERY_ATTEMPTS);
    await dispatchWebhook(env.DB, APP, 'app.alert', { event: 'app.alert' });
    for (let i = 0; i < MAX_DELIVERY_ATTEMPTS + 2; i++) {
      const [d] = await deliveries();
      if (d!.next_attempt_at === null) break;
      await retryDueDeliveries(env.DB, Number(d!.next_attempt_at) * 1000);
    }
    expect((await deliveries())[0]).toMatchObject({ attempts: MAX_DELIVERY_ATTEMPTS, next_attempt_at: null, last_error: 'HTTP 500' });

    await env.DB.prepare('DELETE FROM webhook_deliveries').run();
    fetchMock.get(HOOK).intercept({ path: '/alert', method: 'POST' }).reply(410, 'gone');
    await dispatchWebhook(env.DB, APP, 'app.alert', { event: 'app.alert' });
    expect((await deliveries())[0]).toMatchObject({ attempts: 1, next_attempt_at: null, last_error: 'HTTP 410' });

    await env.DB.prepare('DELETE FROM webhook_deliveries').run();
    await webhook('wh-up', 'storage.uploaded');
    fetchMock.get(HOOK).intercept({ path: '/alert', method: 'POST' }).reply(500, 'x');
    await dispatchWebhook(env.DB, APP, 'storage.uploaded', { event: 'storage.uploaded' });
    expect((await deliveries())[0]).toMatchObject({ attempts: 1, next_attempt_at: null });
  });
});

describe('owner routes (#395)', () => {
  it('objectives are owner-only and validated; dry run evaluates a fixture and writes nothing', async () => {
    const owner = await session('gh:1');
    expect((await SELF.fetch(`${BASE}/v1/apps/${APP}/reliability/objectives/actions`, json('PUT', { target: 0.995 }, owner))).status).toBe(200);
    expect((await SELF.fetch(`${BASE}/v1/apps/${APP}/reliability/objectives/not-a-family`, json('PUT', { target: 0.99 }, owner))).status).toBe(400);
    expect((await SELF.fetch(`${BASE}/v1/apps/${APP}/reliability/objectives/actions`, json('PUT', { target: 1 }, owner))).status).toBe(400);
    expect((await SELF.fetch(`${BASE}/v1/apps/${APP}/reliability/objectives/actions`, json('PUT', { target: 0.99 }, await session('gh:2')))).status).toBeGreaterThanOrEqual(403);
    expect((await SELF.fetch(`${BASE}/v1/apps/${APP}/reliability/objectives`, json('GET'))).status).toBe(401);

    const res = await SELF.fetch(`${BASE}/v1/apps/${APP}/reliability/evaluate`, json('POST', {
      now: NOW, objectives: [{ family: 'actions', target: 0.99 }], buckets: severe.map(({ family, start, total, bad }) => ({ family, start, total, bad })),
    }, owner));
    const dry = await res.json() as { dryRun: boolean; source: string; results: { rule: string; status: string }[] };
    expect(dry).toMatchObject({ dryRun: true, source: 'fixture' });
    expect(dry.results.find((r) => r.rule === 'burn_fast:actions')?.status).toBe('firing');
    expect(await incidents()).toEqual([]);
    expect(await deliveries()).toEqual([]);
  });

  it('incidents are listed to the owner only', async () => {
    await evaluate(severe);
    const list = await (await SELF.fetch(`${BASE}/v1/apps/${APP}/reliability/incidents?open=1`, json('GET', undefined, await session('gh:1')))).json() as { incidents: { rule: string; detail: Record<string, unknown> }[] };
    expect(list.incidents.map((i) => i.rule)).toEqual(['burn_fast:actions']);
    expect(list.incidents[0]!.detail).toMatchObject({ family: 'actions', target: 0.99 });
    expect((await SELF.fetch(`${BASE}/v1/apps/${APP}/reliability/incidents`, json('GET', undefined, await session('gh:2')))).status).toBeGreaterThanOrEqual(403);
  });
});
