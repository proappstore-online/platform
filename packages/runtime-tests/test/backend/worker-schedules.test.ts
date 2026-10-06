import { SELF, env as providedEnv, fetchMock } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Env } from '../../../backend/src/types';
import { runScheduledActions, SCHEDULE_FAILURE_BREAKER } from '../../../backend/src/lib/scheduled-actions';
import { appWorkerHost, disableAppWorker } from '../../../backend/src/lib/app-worker-host';
import { BASE, json, mockNetwork, resetTables, seedApp, seedUser, session } from './helpers';

const env = providedEnv as unknown as Env;

// #255 on real D1, R2 and the Worker Loader: worker schedules registered with the
// manifest, claimed on the platform tick, run through the shim in a loaded
// worker, recorded as 'worker:<name>' in #123's run tables (breaker included),
// and the owner's run-now route.

const APP = `export default { async fetch(req) {
  const e = await req.json();
  if (e.payload?.fail) return new Response('worker failed on purpose', { status: 500 });
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

beforeEach(async () => {
  mockNetwork();
  for (const r of (await env.DB.prepare('SELECT app_id FROM app_workers').all<{ app_id: string }>()).results ?? []) await disableAppWorker(env, r.app_id);
  await resetTables();
  for (const t of ['scheduled_action_runs', 'scheduled_action_state', 'app_alerts', 'app_worker_schedules', 'app_worker_invocations', 'app_log_usage']) await env.DB.prepare(`DELETE FROM ${t}`).run();
  await seedUser('gh:admin', 'admin');
  await seedUser('gh:7', 'other');
  await seedApp('t', 'gh:admin');
});
afterEach(async () => {
  fetchMock.assertNoPendingInterceptors();
  await env.DB.prepare('DELETE FROM app_worker_schedules').run();
});

describe('worker schedules on the platform tick (#255)', () => {
  it('runs a due schedule in the worker and shows it in the owner\'s run history', async () => {
    await register([{ name: 'tick', cron: '*/5 * * * *', params: {} }]);
    await enableAndDeploy();
    const report = await runScheduledActions({ env, now: TICK });
    expect(report.workers).toEqual({ due: 1, claimed: 1, succeeded: 1, failed: 0, skipped: 0 });
    const history = await SELF.fetch(`${BASE}/v1/apps/t/scheduled-runs`, json('GET', undefined, await session('gh:admin')));
    expect((await history.json() as { runs: unknown[] }).runs).toEqual([expect.objectContaining({ action_name: 'worker:tick', source: 'code', status: 'succeeded' })]);
    // The run id was the envelope id: the invocation record carries it.
    const [run] = await runs();
    expect(await env.DB.prepare('SELECT status FROM app_worker_invocations WHERE id = ?').bind(`${run!.run_id}:1`).first()).toEqual({ status: 'succeeded' });
  });

  it('five failures trip the breaker with exactly one alert; re-registering the manifest clears it', async () => {
    await register([{ name: 'tick', cron: '*/5 * * * *', params: { fail: true } }]);
    await enableAndDeploy();
    for (let i = 0; i < SCHEDULE_FAILURE_BREAKER; i++) await runScheduledActions({ env, now: TICK + i * 300_000 });
    expect((await runs()).every((r) => r.status === 'failed' && String(r.error).includes('worker answered 500'))).toBe(true);
    expect(await env.DB.prepare("SELECT schedule_disabled_at FROM scheduled_action_state WHERE app_id = 't' AND action_name = 'worker:tick'").first()).toEqual({ schedule_disabled_at: expect.any(Number) });
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM app_alerts WHERE app_id = 't' AND kind = 'scheduled_action_failures'").first<{ n: number }>())?.n).toBe(1);
    expect((await runScheduledActions({ env, now: TICK + 5 * 300_000 })).workers).toMatchObject({ claimed: 0, skipped: 1 });
    await register([{ name: 'tick', cron: '*/5 * * * *', params: {} }]);
    expect(await env.DB.prepare("SELECT 1 FROM scheduled_action_state WHERE app_id = 't' AND action_name = 'worker:tick'").first()).toBeNull();
    expect((await runScheduledActions({ env, now: TICK + 6 * 300_000 })).workers).toMatchObject({ claimed: 1, succeeded: 1 });
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
    expect(await runs()).toEqual([expect.objectContaining({ status: 'succeeded' })]);
  });
});

describe('run-now (#255)', () => {
  beforeEach(async () => {
    await register([{ name: 'tick', cron: '0 0 1 1 *', params: {} }]);
    await enableAndDeploy();
  });

  it('queues a due run that the next tick claims and runs; the request itself never invokes the worker', async () => {
    const res = await runNow();
    expect(res.status).toBe(202);
    const { run_id } = await res.json() as { run_id: string };
    expect(await runs()).toEqual([expect.objectContaining({ run_id, action_name: 'worker:tick', source: 'code', status: 'due' })]);
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM app_worker_invocations').first<{ n: number }>()).toEqual({ n: 0 });
    // The cron would not match this tick; the pending run-now row is claimed anyway.
    const report = await runScheduledActions({ env, now: TICK });
    expect(report.workers).toMatchObject({ claimed: 1, succeeded: 1 });
    expect(await runs()).toEqual([expect.objectContaining({ run_id, status: 'succeeded' })]);
  });

  it('refuses a non-owner (403), an unknown schedule (404), a run in progress (409) and a second run within 60 s (429)', async () => {
    expect((await runNow('gh:7')).status).toBe(403);
    expect((await runNow('gh:admin', 'nope')).status).toBe(404);
    expect((await runNow()).status).toBe(202);
    const busy = await runNow();
    expect(busy.status).toBe(409);
    expect(await busy.text()).toContain('a run is already in progress');
    await runScheduledActions({ env, now: TICK });
    expect((await runNow()).status).toBe(429);
  });

  it('refuses a breaker-disabled schedule and a worker that is not active (409)', async () => {
    await env.DB.prepare("INSERT INTO scheduled_action_state (app_id, action_name, source, consecutive_failures, schedule_disabled_at) VALUES ('t', 'worker:tick', 'code', 5, 1)").run();
    expect((await runNow()).status).toBe(409);
    await env.DB.prepare("DELETE FROM scheduled_action_state WHERE app_id = 't'").run();
    await disableAppWorker(env, 't');
    expect((await runNow()).status).toBe(409);
  });
});
