import { SELF, env as providedEnv, fetchMock } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Env } from '../../../backend/src/types';
import { AppWorkerTail } from '../../../backend/src/rpc/app-worker-tail';
import { MAX_TAIL_LINES } from '../../../backend/src/lib/app-worker-tail';
import { WORKER_LOG_DAILY_LIMIT } from '../../../backend/src/lib/app-worker-usage';
import { BASE, mockNetwork, resetTables, seedApp, seedUser, session } from './helpers';

const env = providedEnv as unknown as Env;

// #308 on real D1: AppWorkerTail turns the trace of an app worker's invocation
// into child_cpu_ms / child_wall_ms / child_outcome on its record and app_logs
// lines traced to it. The traces are built here: local workerd does not hand
// loaded workers ctx.exports, so the runtime cannot attach the tail in this suite.
//
//   app `t` (owner gh:1) has invocation `evt-1:1`; app `u` (owner gh:1) has `evt-u:1`.

const tail = (appId: string) => new AppWorkerTail({ props: { appId } } as never, env);
function trace(invocation: string | null, over: Partial<TraceItem> = {}): TraceItem {
  return {
    event: { request: { url: 'https://app-worker.invalid/', method: 'POST', headers: invocation ? { 'x-pas-invocation': invocation } : {} } },
    eventTimestamp: 1_000, logs: [], exceptions: [], diagnosticsChannelEvents: [], scriptName: null,
    outcome: 'ok', executionModel: 'stateless', truncated: false, cpuTime: 12.4, wallTime: 340.6,
    ...over,
  } as unknown as TraceItem;
}
const record = (id: string) => env.DB.prepare('SELECT child_cpu_ms, child_wall_ms, child_outcome FROM app_worker_invocations WHERE id = ?').bind(id).first();
const lines = (appId: string) => env.DB.prepare('SELECT level, category, message, trace_id, source, user_id FROM app_logs WHERE app_id = ? ORDER BY id').bind(appId).all().then((r) => r.results);

beforeEach(async () => {
  mockNetwork();
  await resetTables();
  for (const t of ['app_worker_invocations', 'app_log_usage', 'app_worker_usage']) await env.DB.prepare(`DELETE FROM ${t}`).run();
  await seedUser('gh:1', 'owner');
  await seedApp('t', 'gh:1');
  await seedApp('u', 'gh:1');
  for (const [id, appId] of [['evt-1:1', 't'], ['evt-u:1', 'u']]) {
    await env.DB.prepare(
      "INSERT INTO app_worker_invocations (id, app_id, event_id, type, attempt, status, started_at, finished_at) VALUES (?, ?, ?, 'hook', 1, 'succeeded', ?, ?)",
    ).bind(id, appId, id.split(':')[0], Date.now() - 500, Date.now()).run();
  }
});
afterEach(() => fetchMock.assertNoPendingInterceptors());

describe('AppWorkerTail (#308)', () => {
  it('records the child CPU, wall time and outcome on the invocation it names', async () => {
    await tail('t').tail([trace('evt-1:1', { outcome: 'exceededCpu', cpuTime: 30_002.7, wallTime: 31_000 })]);
    expect(await record('evt-1:1')).toEqual({ child_cpu_ms: 30_003, child_wall_ms: 31_000, child_outcome: 'exceededCpu' });
  });

  it("stores the worker's console lines and exceptions traced to the invocation, findable from its record", async () => {
    await tail('t').tail([trace('evt-1:1', {
      logs: [
        { timestamp: Date.now(), level: 'log', message: ['synced', { count: 2 }] },
        { timestamp: Date.now() + 1, level: 'warn', message: ['slow upstream'] },
      ],
      exceptions: [{ timestamp: Date.now() + 2, name: 'TypeError', message: 'x is undefined' }],
    })]);
    expect(await lines('t')).toEqual([
      { level: 'info', category: 'worker', message: 'synced {"count":2}', trace_id: 'evt-1:1', source: 'worker-console', user_id: 'system:worker' },
      { level: 'warn', category: 'worker', message: 'slow upstream', trace_id: 'evt-1:1', source: 'worker-console', user_id: 'system:worker' },
      { level: 'error', category: 'worker', message: 'TypeError: x is undefined', trace_id: 'evt-1:1', source: 'worker-console', user_id: 'system:worker' },
    ]);

    // From the record: GET …/worker lists the invocation with its CPU; its id finds its lines.
    const auth = { Authorization: `Bearer ${await session('gh:1')}` };
    const status = await (await SELF.fetch(`${BASE}/v1/apps/t/worker`, { headers: auth })).json<{ invocations: Record<string, unknown>[] }>();
    expect(status.invocations[0]).toMatchObject({ id: 'evt-1:1', child_cpu_ms: 12, child_wall_ms: 341, child_outcome: 'ok' });
    const res = await SELF.fetch(`${BASE}/v1/apps/t/logs?trace_id=${encodeURIComponent('evt-1:1')}`, { headers: auth });
    expect((await res.json<{ logs: { message: string; traceId: string }[] }>()).logs.map((l) => l.message)).toEqual(['TypeError: x is undefined', 'slow upstream', 'synced {"count":2}']);
  });

  it("never touches another app's invocation, and ignores traces without the invocation header", async () => {
    // The tail attached for `u` names t's invocation: no row matches (app_id from props), nothing is written.
    await tail('u').tail([trace('evt-1:1', { logs: [{ timestamp: Date.now(), level: 'log', message: ['forged'] }] })]);
    await tail('t').tail([trace(null, { logs: [{ timestamp: Date.now(), level: 'log', message: ['no header'] }] }), trace('not-an-invocation')]);
    expect(await record('evt-1:1')).toEqual({ child_cpu_ms: null, child_wall_ms: null, child_outcome: null });
    expect(await lines('t')).toEqual([]);
    expect(await lines('u')).toEqual([]);
  });

  it(`keeps at most ${MAX_TAIL_LINES} lines per invocation and says how many it dropped`, async () => {
    const logs = Array.from({ length: MAX_TAIL_LINES + 20 }, (_, i) => ({ timestamp: Date.now() + i, level: 'log', message: [`line ${i}`] }));
    await tail('t').tail([trace('evt-1:1', { logs })]);
    const stored = await lines('t');
    expect(stored).toHaveLength(MAX_TAIL_LINES);
    expect(stored.at(-1)).toMatchObject({ level: 'warn', message: `21 more console lines dropped (max ${MAX_TAIL_LINES} per invocation)` });
  });

  it("console lines count against the worker's own log budget, not the app's log quota (#316)", async () => {
    const day = new Date().toISOString().slice(0, 10);
    // A spent app log quota (anonymous ingestion) does not drop them…
    await env.DB.prepare('INSERT INTO app_log_usage (app_id, day, count) VALUES (?, ?, 50000)').bind('t', day).run();
    await tail('t').tail([trace('evt-1:1', { logs: [{ timestamp: Date.now(), level: 'log', message: ['still kept'] }] })]);
    expect((await lines('t')).map((l) => l.message)).toEqual(['still kept']);
    // …a spent worker budget does, and the CPU is still recorded.
    await env.DB.prepare('UPDATE app_worker_usage SET log_entries = ? WHERE app_id = ? AND day = ?').bind(WORKER_LOG_DAILY_LIMIT, 't', day).run();
    await tail('t').tail([trace('evt-1:1', { cpuTime: 7, logs: [{ timestamp: Date.now(), level: 'log', message: ['over budget'] }] })]);
    expect((await lines('t')).map((l) => l.message)).toEqual(['still kept']);
    expect(await record('evt-1:1')).toMatchObject({ child_cpu_ms: 7 });
  });
});
