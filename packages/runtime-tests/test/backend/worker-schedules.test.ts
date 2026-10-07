import { SELF, env as providedEnv, fetchMock } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../../../backend/src/types';
import { runScheduledActions, SCHEDULE_FAILURE_BREAKER, STALE_QUEUED_RUN_MS } from '../../../backend/src/lib/scheduled-actions';
import { appWorkerHost, disableAppWorker } from '../../../backend/src/lib/app-worker-host';
import { BASE, captureAppEvents, consumeAppEvent, drainAppEvents, json, mockNetwork, resetTables, seedApp, seedUser, session } from './helpers';
import { APP_EVENTS_DLQ } from '../../../backend/src/lib/app-event-queue';

const env = providedEnv as unknown as Env;

// #255 and #257 on real D1, R2 and the Worker Loader: worker schedules registered
// with the manifest, claimed on the platform tick and put on the app-events queue
// (claimed -> queued), run through the shim in a loaded worker by the real queue
// consumer — retried, dead-lettered, swept — and recorded as 'worker:<name>' in
// #123's run tables (breaker included); plus the owner's run-now route. The queue is
// recorded and drained by hand (helpers.captureAppEvents / drainAppEvents).

const APP = `export default { async fetch(req) {
  const e = await req.json();
  if (e.payload?.fail || e.payload?.failUntil > e.attempt) return new Response('worker failed on purpose', { status: 500 });
  return Response.json({ ran: e.name, id: e.id });
} };`;
const TICK = Date.UTC(2026, 9, 6, 10, 10);
const tool = {
  name: 'add_row', description: 'Worker write', operation: 'execute', requires_auth: true,
  sql: 'INSERT INTO rows (id) VALUES (:id)', params: { id: { type: 'string' } },
  auth: { caller_unscoped: { reason: 'the worker writes every row' } }, callers: ['worker'],
};

async function register(schedules: unknown[]) {
  fetchMock.get(`https://pas-data-t.${env.DATA_WORKER_HOST}`).intercept({ path: '/validate', method: 'POST' })
    .reply(200, (req) => ({ results: (JSON.parse(String(req.body)) as { statements: { id: string }[] }).statements.map((s) => ({ id: s.id, ok: true })) }));
  const res = await SELF.fetch(`${BASE}/v1/apps/t/tools`, json('PUT', { tools: [tool], worker: { schedules } }, await session('gh:admin')));
  expect(res.status, await res.clone().text()).toBe(200);
}
async function enableAndDeploy(deploy = true) {
  const enabled = await SELF.fetch(`${BASE}/v1/admin/apps/t/worker-enabled`, json('PUT', { enabled: true }, await session('gh:admin', { roles: ['user', 'admin'] })));
  expect(enabled.status).toBe(200);
  if (deploy) await appWorkerHost(env).deploy('t', { modules: { 'app.js': APP } });
}
const runs = async () => (await env.DB.prepare("SELECT run_id, action_name, source, status, due_at, error FROM scheduled_action_runs WHERE app_id = 't' AND action_name LIKE 'worker:%' ORDER BY due_at").all<Record<string, unknown>>()).results ?? [];
const runNow = async (uid = 'gh:admin', name = 'tick') => SELF.fetch(`${BASE}/v1/apps/t/worker/schedules/${name}/run`, json('POST', undefined, await session(uid)));

let sent: ReturnType<typeof captureAppEvents>;
const failures = async () => (await env.DB.prepare("SELECT consecutive_failures FROM scheduled_action_state WHERE app_id = 't' AND action_name = 'worker:tick'").first<{ consecutive_failures: number }>())?.consecutive_failures;

beforeEach(async () => {
  sent = captureAppEvents();
  mockNetwork();
  for (const r of (await env.DB.prepare('SELECT app_id FROM app_workers').all<{ app_id: string }>()).results ?? []) await disableAppWorker(env, r.app_id);
  await resetTables();
  for (const t of ['scheduled_action_runs', 'scheduled_action_state', 'app_alerts', 'app_worker_schedules', 'app_worker_invocations', 'app_log_usage']) await env.DB.prepare(`DELETE FROM ${t}`).run();
  await seedUser('gh:admin', 'admin');
  await seedUser('gh:7', 'other');
  await seedApp('t', 'gh:admin');
});
afterEach(async () => {
  vi.restoreAllMocks();
  fetchMock.assertNoPendingInterceptors();
  await env.DB.prepare('DELETE FROM app_worker_schedules').run();
});

describe('worker schedules on the platform tick (#255, #257)', () => {
  it('queues a due schedule (claimed -> queued) and the consumer runs it; the owner\'s history shows it', async () => {
    await register([{ name: 'tick', cron: '*/5 * * * *', params: {} }]);
    await enableAndDeploy();
    const report = await runScheduledActions({ env, now: TICK });
    expect(report.workers).toEqual({ due: 1, claimed: 1, queued: 1, failed: 0, skipped: 0 });
    const [run] = await runs();
    expect(run).toMatchObject({ status: 'queued' });
    expect(sent).toEqual([expect.objectContaining({ id: run!.run_id, type: 'schedule', name: 'tick', ref: { table: 'scheduled_action_runs', id: run!.run_id } })]);
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM app_worker_invocations').first<{ n: number }>()).toEqual({ n: 0 });

    expect(await drainAppEvents(sent)).toEqual([{ id: run!.run_id, tries: 1, deadLettered: false }]);
    const history = await SELF.fetch(`${BASE}/v1/apps/t/scheduled-runs`, json('GET', undefined, await session('gh:admin')));
    expect((await history.json() as { runs: unknown[] }).runs).toEqual([expect.objectContaining({ action_name: 'worker:tick', source: 'code', status: 'succeeded' })]);
    // The run id was the envelope id: the invocation record carries it.
    expect(await env.DB.prepare('SELECT status FROM app_worker_invocations WHERE id = ?').bind(`${run!.run_id}:1`).first()).toEqual({ status: 'succeeded' });
    const queued = await SELF.fetch(`${BASE}/v1/apps/t/scheduled-runs?status=queued`, json('GET', undefined, await session('gh:admin')));
    expect(queued.status).toBe(200);
  });

  it('five dead-lettered runs trip the breaker with exactly one alert (one failure per run, not per attempt); re-registering the manifest clears it', async () => {
    await register([{ name: 'tick', cron: '*/5 * * * *', params: { fail: true } }]);
    await enableAndDeploy();
    for (let i = 0; i < SCHEDULE_FAILURE_BREAKER; i++) {
      await runScheduledActions({ env, now: TICK + i * 300_000 });
      expect(await drainAppEvents(sent)).toEqual([expect.objectContaining({ tries: 6, deadLettered: true })]);
      expect(await failures()).toBe(i + 1);
    }
    expect((await runs()).every((r) => r.status === 'failed' && String(r.error).startsWith('dead-lettered after 6 attempts: worker answered 500'))).toBe(true);
    expect(await env.DB.prepare("SELECT schedule_disabled_at FROM scheduled_action_state WHERE app_id = 't' AND action_name = 'worker:tick'").first()).toEqual({ schedule_disabled_at: expect.any(Number) });
    // #261: the owner's worker status carries each schedule with its breaker state.
    const status = await (await SELF.fetch(`${BASE}/v1/apps/t/worker`, json('GET', undefined, await session('gh:admin')))).json() as { schedules: unknown[] };
    expect(status.schedules).toEqual([{ name: 'tick', cron: '*/5 * * * *', consecutive_failures: SCHEDULE_FAILURE_BREAKER, schedule_disabled_at: expect.any(Number) }]);
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM app_alerts WHERE app_id = 't' AND kind = 'scheduled_action_failures'").first<{ n: number }>())?.n).toBe(1);
    expect((await runScheduledActions({ env, now: TICK + 5 * 300_000 })).workers).toMatchObject({ claimed: 0, skipped: 1 });
    await register([{ name: 'tick', cron: '*/5 * * * *', params: {} }]);
    expect(await env.DB.prepare("SELECT 1 FROM scheduled_action_state WHERE app_id = 't' AND action_name = 'worker:tick'").first()).toBeNull();
    expect((await runScheduledActions({ env, now: TICK + 6 * 300_000 })).workers).toMatchObject({ claimed: 1, queued: 1 });
  });

  it('a worker that fails for a while then recovers: claimed -> queued -> succeeded, no second run claimed meanwhile, breaker at 0', async () => {
    await register([{ name: 'tick', cron: '*/5 * * * *', params: { failUntil: 4 } }]);
    await enableAndDeploy();
    await runScheduledActions({ env, now: TICK });
    const m = sent.shift()!;
    for (const attempts of [1, 2, 3]) expect((await consumeAppEvent(m, attempts)).retryDelay).toBe(2 ** attempts * 10);
    // Two more ticks (12 minutes of retrying) find the live queued run and claim nothing.
    for (const i of [1, 2]) expect((await runScheduledActions({ env, now: TICK + i * 300_000 })).workers).toMatchObject({ claimed: 0, skipped: 1 });
    expect(await runs()).toEqual([expect.objectContaining({ status: 'queued' })]);
    expect((await consumeAppEvent(m, 4)).acked).toBe(true);
    expect(await runs()).toEqual([expect.objectContaining({ run_id: m.id, status: 'succeeded' })]);
    expect(await failures()).toBe(0);
    expect(sent).toEqual([]);
  });

  it('a run dead-lettered and swept by the 60-minute queued sweep in the same tick counts one failure, in either order', async () => {
    await register([{ name: 'tick', cron: '0 0 1 1 *', params: { fail: true } }]);
    await enableAndDeploy();
    for (const order of ['sweep-first', 'dlq-first']) {
      await env.DB.prepare("DELETE FROM scheduled_action_runs; ").run();
      await env.DB.prepare('DELETE FROM scheduled_action_state').run();
      const runId = crypto.randomUUID();
      await env.DB.prepare("INSERT INTO scheduled_action_runs (run_id, app_id, action_name, source, due_at, claimed_at, status) VALUES (?, 't', 'worker:tick', 'code', ?, ?, 'queued')").bind(runId, TICK, TICK).run();
      const message = { v: 1 as const, id: runId, app_id: 't', type: 'schedule' as const, name: 'tick', attempt: 1, issued_at: TICK, payload: {}, ref: { table: 'scheduled_action_runs' as const, id: runId } };
      const sweep = () => runScheduledActions({ env, now: TICK + STALE_QUEUED_RUN_MS + 1 });
      if (order === 'sweep-first') { expect((await sweep()).recovered).toBe(1); await consumeAppEvent(message, 1, APP_EVENTS_DLQ); } else { await consumeAppEvent(message, 1, APP_EVENTS_DLQ); expect((await sweep()).recovered).toBe(0); }
      expect(await failures(), order).toBe(1);
      expect((await runs())[0], order).toMatchObject({ status: 'failed' });
    }
  });

  it('an enabled worker that was never deployed gets no runs', async () => {
    await register([{ name: 'tick', cron: '*/5 * * * *', params: {} }]);
    await enableAndDeploy(false);
    expect((await runScheduledActions({ env, now: TICK })).workers).toMatchObject({ due: 0, claimed: 0 });
    expect(await runs()).toEqual([]);
  });

  it('two overlapping ticks never claim the same schedule twice', async () => {
    await register([{ name: 'tick', cron: '*/5 * * * *', params: {} }]);
    await enableAndDeploy();
    const [a, b] = await Promise.all([runScheduledActions({ env, now: TICK }), runScheduledActions({ env, now: TICK + 1_000 })]);
    expect((a.workers?.claimed ?? 0) + (b.workers?.claimed ?? 0)).toBe(1);
    expect(sent).toHaveLength(1);
    await drainAppEvents(sent);
    expect(await runs()).toEqual([expect.objectContaining({ status: 'succeeded' })]);
  });
});

describe('run-now (#255, #257)', () => {
  beforeEach(async () => {
    await register([{ name: 'tick', cron: '0 0 1 1 *', params: {} }]);
    await enableAndDeploy();
  });

  it('enqueues the run at once (status queued) without invoking the worker in the request; the consumer then runs it', async () => {
    const res = await runNow();
    expect(res.status).toBe(202);
    const { run_id, status } = await res.json() as { run_id: string; status: string };
    expect(status).toBe('queued');
    expect(await runs()).toEqual([expect.objectContaining({ run_id, action_name: 'worker:tick', source: 'code', status: 'queued' })]);
    expect(sent).toEqual([expect.objectContaining({ id: run_id, type: 'schedule', name: 'tick' })]);
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM app_worker_invocations').first<{ n: number }>()).toEqual({ n: 0 });
    await drainAppEvents(sent);
    expect(await runs()).toEqual([expect.objectContaining({ run_id, status: 'succeeded' })]);
  });

  it('refuses a non-owner (403), an unknown schedule (404), a run in progress (409) and a second run within 60 s (429)', async () => {
    expect((await runNow('gh:7')).status).toBe(403);
    expect((await runNow('gh:admin', 'nope')).status).toBe(404);
    expect((await runNow()).status).toBe(202);
    const busy = await runNow();
    expect(busy.status).toBe(409);
    expect(await busy.text()).toContain('a run is already in progress');
    await drainAppEvents(sent);
    expect((await runNow()).status).toBe(429);
  });

  it('refuses a breaker-disabled schedule and a worker that is not active (409)', async () => {
    await env.DB.prepare("INSERT INTO scheduled_action_state (app_id, action_name, source, consecutive_failures, schedule_disabled_at) VALUES ('t', 'worker:tick', 'code', 5, 1)").run();
    expect((await runNow()).status).toBe(409);
    await env.DB.prepare("DELETE FROM scheduled_action_state WHERE app_id = 't'").run();
    await disableAppWorker(env, 't');
    expect((await runNow()).status).toBe(409);
  });

  it('a queue that rejects the send fails the run and answers 503', async () => {
    vi.spyOn(env.APP_EVENTS!, 'send').mockRejectedValue(new Error('queue down'));
    expect((await runNow()).status).toBe(503);
    expect(await runs()).toEqual([expect.objectContaining({ status: 'failed', error: 'could not enqueue: queue down' })]);
  });
});
