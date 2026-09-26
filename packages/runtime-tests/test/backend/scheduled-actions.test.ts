import { SELF, createExecutionContext, env as providedEnv, fetchMock, waitOnExecutionContext } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import worker from '../../../backend/src/index';
import type { Env } from '../../../backend/src/types';
import { runScheduledActions, SCHEDULE_FAILURE_BREAKER, STALE_SCHEDULE_CLAIM_MS } from '../../../backend/src/lib/scheduled-actions';
import { BASE, json, mockNetwork, resetTables, seedApp, seedUser, session } from './helpers';

// vitest.backend.ts binds the backend worker's real bindings; ProvidedEnv only
// declares the ones tests touch directly, so name the backend's type once here.
const env = providedEnv as unknown as Env;

/**
 * Scheduled registered actions (#123 / #147) on real D1 with the real
 * migrations: tenant isolation, idempotency of the durable claim, and failure
 * observability. The app data workers are the only thing mocked: each
 * interceptor stands for one real execution against that app's database.
 */
afterEach(() => fetchMock.assertNoPendingInterceptors());
beforeEach(async () => {
  mockNetwork();
  await resetTables();
  for (const t of ['scheduled_action_runs', 'scheduled_action_state', 'app_alerts']) await env.DB.prepare(`DELETE FROM ${t}`).run();
  await seedUser('gh:1', 'alice');
  await seedUser('gh:2', 'bob');
  await seedApp('alpha', 'gh:1');
  await seedApp('beta', 'gh:2');
});

const reap = {
  name: 'reap_stale',
  description: 'Abandon games idle past the threshold',
  operation: 'execute',
  sql: "UPDATE games SET status = 'abandoned' WHERE status = 'active' AND updated_at < :__now - :idle_ms",
  params: { idle_ms: { type: 'integer' } },
  requires_auth: true,
  auth: { caller_unscoped: { reason: 'Scheduled maintenance; rows are bounded by stale state.' } },
  schedule: { cron: '*/5 * * * *', params: { idle_ms: 1_800_000 } },
};
/** Ticks on a five-minute boundary that is not a fifteen-minute one (no drift/payout/alert jobs). */
const tick = (n: number) => Date.UTC(2026, 8, 26, 10, 5) + n * 5 * 60_000;

async function register(appId: string): Promise<void> {
  const now = Date.now();
  await env.DB.prepare("INSERT INTO app_tools (app_id, name, manifest, created_at, updated_at, source) VALUES (?, ?, ?, ?, ?, 'code')")
    .bind(appId, reap.name, JSON.stringify(reap), now, now).run();
}
const dataWorker = (appId: string) => fetchMock.get(`https://pas-data-${appId}.${env.DATA_WORKER_HOST}`);
/** One execution against the app's data worker, recording what it was sent. */
function executes(appId: string, status: number, body: unknown, seen: unknown[] = []): unknown[] {
  dataWorker(appId).intercept({ path: '/execute', method: 'POST' }).reply(status, (req) => {
    seen.push(JSON.parse(String(req.body)));
    return body;
  });
  return seen;
}
const runs = (appId: string) =>
  env.DB.prepare('SELECT status, changes, error, due_at FROM scheduled_action_runs WHERE app_id = ? ORDER BY due_at').bind(appId)
    .all<{ status: string; changes: number | null; error: string | null; due_at: number }>().then((r) => r.results ?? []);
const state = (appId: string) =>
  env.DB.prepare('SELECT consecutive_failures, schedule_disabled_at FROM scheduled_action_state WHERE app_id = ? AND action_name = ?').bind(appId, reap.name)
    .first<{ consecutive_failures: number; schedule_disabled_at: number | null }>();
const alerts = (appId: string) =>
  env.DB.prepare("SELECT COUNT(*) AS n FROM app_alerts WHERE app_id = ? AND kind = 'scheduled_action_failures'").bind(appId).first<{ n: number }>().then((r) => r?.n ?? 0);

describe('scheduled actions — tenant isolation', () => {
  it("two apps with a same-named action: each runs against only its own data worker, with separate breaker state", async () => {
    await register('alpha');
    await register('beta');
    const alphaSeen = executes('alpha', 200, { meta: { changes: 3 } });
    executes('beta', 500, { error: 'no such table: games' });

    const report = await runScheduledActions({ env, now: tick(0) });
    expect(report).toMatchObject({ due: 2, claimed: 2, succeeded: 1, failed: 1 });
    expect(await runs('alpha')).toEqual([expect.objectContaining({ status: 'succeeded', changes: 3 })]);
    expect(await runs('beta')).toEqual([expect.objectContaining({ status: 'failed' })]);
    expect(alphaSeen[0]).toMatchObject({ params: [expect.any(Number), 1_800_000] }); // fixed schedule params, no caller input
    expect(await state('alpha')).toMatchObject({ consecutive_failures: 0, schedule_disabled_at: null });
    expect(await state('beta')).toMatchObject({ consecutive_failures: 1 });
  });

  it("one app's breaker never stops another app's same-named schedule", async () => {
    await register('alpha');
    await register('beta');
    for (let i = 0; i < SCHEDULE_FAILURE_BREAKER; i++) {
      executes('alpha', 200, { meta: { changes: 0 } });
      executes('beta', 500, { error: 'boom' });
      await runScheduledActions({ env, now: tick(i) });
    }
    expect((await state('beta'))?.schedule_disabled_at).not.toBeNull();
    expect(await alerts('beta')).toBe(1);
    expect(await alerts('alpha')).toBe(0);

    executes('alpha', 200, { meta: { changes: 1 } }); // beta has no interceptor: it must not be called
    const next = await runScheduledActions({ env, now: tick(SCHEDULE_FAILURE_BREAKER) });
    expect(next).toMatchObject({ due: 2, claimed: 1, succeeded: 1, skipped: 1 });
    expect((await state('alpha'))?.schedule_disabled_at).toBeNull();
  });
});

describe('scheduled actions — idempotency of the durable claim', () => {
  it('a tick repeated for the same minute executes once', async () => {
    await register('alpha');
    executes('alpha', 200, { meta: { changes: 2 } });
    expect(await runScheduledActions({ env, now: tick(0) })).toMatchObject({ claimed: 1, succeeded: 1 });
    expect(await runScheduledActions({ env, now: tick(0) + 30_000 })).toMatchObject({ due: 1, claimed: 0, skipped: 1 });
    expect(await runs('alpha')).toHaveLength(1);
  });

  it('overlapping ticks for the same minute claim it exactly once', async () => {
    await register('alpha');
    executes('alpha', 200, { meta: { changes: 2 } });
    const reports = await Promise.all([0, 1, 2].map(() => runScheduledActions({ env, now: tick(0) })));
    expect(reports.reduce((n, r) => n + r.claimed, 0)).toBe(1);
    expect(reports.reduce((n, r) => n + r.succeeded, 0)).toBe(1);
    expect(await runs('alpha')).toEqual([expect.objectContaining({ status: 'succeeded' })]);
  });

  it('the durable row is unique per (app, action, minute): a second insert for the minute is ignored', async () => {
    const insert = (id: string) => env.DB.prepare("INSERT OR IGNORE INTO scheduled_action_runs (run_id, app_id, action_name, source, due_at, status) VALUES (?, 'alpha', 'reap_stale', 'code', ?, 'due')").bind(id, tick(0)).run();
    expect((await insert('run-1')).meta.changes).toBe(1);
    expect((await insert('run-2')).meta.changes).toBe(0);
  });

  it('a still-claimed earlier run suppresses the next due minute instead of stacking', async () => {
    await register('alpha');
    await env.DB.prepare("INSERT INTO scheduled_action_runs (run_id, app_id, action_name, source, due_at, claimed_at, status) VALUES ('live', 'alpha', 'reap_stale', 'code', ?, ?, 'claimed')")
      .bind(tick(0), tick(1) - 60_000).run();
    expect(await runScheduledActions({ env, now: tick(1) })).toMatchObject({ due: 1, claimed: 0, skipped: 1 });
  });

  it('runs through the real scheduled() handler, and a duplicate delivery of the tick is a no-op', async () => {
    await register('alpha');
    executes('alpha', 200, { meta: { changes: 1 } });
    // The handler hands its work to ctx.waitUntil; wait for all of it.
    const deliver = async () => {
      const ctx = createExecutionContext();
      // Production delivers scheduledTime in epoch ms.
      await worker.scheduled({ scheduledTime: tick(0), cron: '*/5 * * * *', noRetry() {} } as ScheduledEvent, env, ctx);
      await waitOnExecutionContext(ctx);
    };
    await deliver();
    await deliver();
    expect(await runs('alpha')).toEqual([expect.objectContaining({ status: 'succeeded', changes: 1 })]);
  });
});

describe('scheduled actions — failure observability', () => {
  it('five consecutive failures disable the schedule, raise exactly one alert, and later ticks skip it', async () => {
    await register('beta');
    for (let i = 0; i < SCHEDULE_FAILURE_BREAKER; i++) {
      executes('beta', 500, { error: 'boom' });
      await runScheduledActions({ env, now: tick(i) });
    }
    expect(await state('beta')).toMatchObject({ consecutive_failures: SCHEDULE_FAILURE_BREAKER, schedule_disabled_at: expect.any(Number) });
    expect(await alerts('beta')).toBe(1);
    for (let i = SCHEDULE_FAILURE_BREAKER; i < SCHEDULE_FAILURE_BREAKER + 3; i++) {
      expect(await runScheduledActions({ env, now: tick(i) })).toMatchObject({ claimed: 0, skipped: 1 });
    }
    expect(await alerts('beta')).toBe(1);
    expect(await runs('beta')).toHaveLength(SCHEDULE_FAILURE_BREAKER);
  });

  it('a success resets the consecutive-failure count', async () => {
    await register('beta');
    for (const [i, status] of [500, 500, 200].entries()) {
      executes('beta', status, status === 200 ? { meta: { changes: 1 } } : { error: 'boom' });
      await runScheduledActions({ env, now: tick(i) });
    }
    expect(await state('beta')).toMatchObject({ consecutive_failures: 0, schedule_disabled_at: null });
    for (let i = 3; i < 3 + SCHEDULE_FAILURE_BREAKER - 1; i++) {
      executes('beta', 500, { error: 'boom' });
      await runScheduledActions({ env, now: tick(i) });
    }
    expect(await state('beta')).toMatchObject({ consecutive_failures: SCHEDULE_FAILURE_BREAKER - 1, schedule_disabled_at: null });
    expect(await alerts('beta')).toBe(0);
  });

  it('re-registering the manifest (the owner reviewed it) re-enables a disabled schedule', async () => {
    await register('beta');
    for (let i = 0; i < SCHEDULE_FAILURE_BREAKER; i++) {
      executes('beta', 500, { error: 'boom' });
      await runScheduledActions({ env, now: tick(i) });
    }
    expect((await state('beta'))?.schedule_disabled_at).not.toBeNull();

    dataWorker('beta').intercept({ path: '/validate', method: 'POST' }).reply(200, { results: [{ id: 'reap_stale#0', ok: true }] });
    const reg = await SELF.fetch(`${BASE}/v1/apps/beta/tools`, json('PUT', { tools: [reap] }, await session('gh:2')));
    expect(reg.status).toBe(200);
    expect(await state('beta')).toBeNull();

    executes('beta', 200, { meta: { changes: 4 } });
    expect(await runScheduledActions({ env, now: tick(SCHEDULE_FAILURE_BREAKER) })).toMatchObject({ claimed: 1, succeeded: 1 });
  });

  it("records a truncated error, readable only by the app's owner in run history", async () => {
    await register('beta');
    executes('beta', 500, { error: 'x'.repeat(5_000) });
    await runScheduledActions({ env, now: tick(0) });
    const [run] = await runs('beta');
    expect(run!.status).toBe('failed');
    expect(run!.error).toMatch(/^data worker 500: /);
    expect(run!.error!.length).toBeLessThanOrEqual(1_000);

    const owner = await SELF.fetch(`${BASE}/v1/apps/beta/scheduled-runs?status=failed`, json('GET', undefined, await session('gh:2')));
    expect(owner.status).toBe(200);
    expect(owner.headers.get('Cache-Control')).toBe('private, no-store');
    expect(await owner.json()).toMatchObject({ runs: [{ app_id: 'beta', action_name: 'reap_stale', status: 'failed', error: run!.error }] });

    const otherOwner = await SELF.fetch(`${BASE}/v1/apps/beta/scheduled-runs`, json('GET', undefined, await session('gh:1')));
    expect(otherOwner.status).toBe(403);
    await otherOwner.text();
  });

  it('recovers a stale claim as a failure that counts toward the breaker, then runs normally', async () => {
    await register('alpha');
    const claimedAt = tick(1) - STALE_SCHEDULE_CLAIM_MS - 60_000;
    await env.DB.prepare("INSERT INTO scheduled_action_runs (run_id, app_id, action_name, source, due_at, claimed_at, status) VALUES ('stuck', 'alpha', 'reap_stale', 'code', ?, ?, 'claimed')")
      .bind(tick(0) - 15 * 60_000, claimedAt).run();
    executes('alpha', 200, { meta: { changes: 1 } });

    const report = await runScheduledActions({ env, now: tick(1) });
    expect(report).toMatchObject({ recovered: 1, claimed: 1, succeeded: 1 });
    const stuck = await env.DB.prepare("SELECT status, error FROM scheduled_action_runs WHERE run_id = 'stuck'").first<{ status: string; error: string }>();
    expect(stuck).toEqual({ status: 'failed', error: 'scheduled executor did not finish (stale claim recovered)' });
    // The recovered failure counted, and the next success reset the count.
    expect(await state('alpha')).toMatchObject({ consecutive_failures: 0, schedule_disabled_at: null });
  });
});
