import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  invokeWorkerRun, runNowDueAt, runScheduledActions, runWorkerSchedules, SCHEDULE_FAILURE_BREAKER,
  STALE_QUEUED_RUN_MS, WORKER_SCHEDULE_TIMEOUT_MS, type ClaimedWorkerRun,
} from './scheduled-actions.js';
import type { AppEventMessage } from './app-event-queue.js';
import * as host from './app-worker-host.js';
import type { Env } from '../types.js';

// #255/#257: app-worker schedules on the #123 scheduler — claimed through the same
// guard, put on the app-events queue (claimed -> queued) after the action loop,
// recorded in scheduled_action_runs/_state as 'worker:<name>'. Delivery, retry and
// dead-lettering are the consumer's: runtime-tests/test/backend/app-events.test.ts. A stateful D1 double; the
// real-D1 + real Worker Loader path is runtime-tests/test/backend/worker-schedules.test.ts.

interface Run { run_id: string; app_id: string; action_name: string; due_at: number; status: string; error?: string | null; claimed_at?: number | null }
interface Sched { app_id: string; name: string; cron: string; params: string }

function fakeDb(schedules: Sched[], seeded: Run[] = []) {
  const runs: Run[] = [...seeded];
  const state = new Map<string, { failures: number; disabled: number | null }>();
  const alerts: unknown[] = [];
  const key = (a: unknown, b: unknown) => `${a}|${b}`;
  const prepare = (sql: string) => {
    const s = sql.replace(/\s+/g, ' ').trim();
    let args: unknown[] = [];
    const stmt = {
      bind: (...v: unknown[]) => { args = v; return stmt; },
      all: async () => {
        if (s.startsWith('SELECT app_id, name, manifest, source FROM app_tools')) return { results: [] };
        if (s.startsWith('SELECT s.app_id, s.name, s.cron, s.params')) return { results: schedules };
        if (s.includes("WHERE status = 'due' AND action_name LIKE 'worker:%'")) {
          return { results: runs.filter((r) => r.status === 'due' && r.action_name.startsWith('worker:') && r.due_at % 60000 !== 0).sort((x, y) => x.due_at - y.due_at) };
        }
        if (s.startsWith('SELECT run_id, app_id, action_name, source, claimed_at')) {
          return { results: runs.filter((r) => s.includes(`status = '${r.status}'`) && (r.claimed_at ?? Infinity) < Number(args[0])).map((r) => ({ ...r, source: 'code' })) };
        }
        return { results: [] };
      },
      first: async () => {
        if (s.startsWith('SELECT schedule_disabled_at')) return state.get(key(args[0], args[1]))?.disabled ? { schedule_disabled_at: 1 } : null;
        if (s.startsWith('SELECT 1 AS active')) return runs.some((r) => r.app_id === args[0] && r.action_name === args[1] && (r.status === 'claimed' || r.status === 'queued')) ? { active: 1 } : null;
        if (s.startsWith('SELECT run_id FROM scheduled_action_runs')) {
          const r = runs.find((x) => x.app_id === args[0] && x.action_name === args[1] && x.due_at === args[2] && x.status === 'claimed');
          return r ? { run_id: r.run_id } : null;
        }
        if (s.startsWith('SELECT consecutive_failures')) {
          const st = state.get(key(args[0], args[1]));
          return st ? { consecutive_failures: st.failures, schedule_disabled_at: st.disabled } : null;
        }
        return null;
      },
      run: async () => {
        if (s.startsWith('INSERT OR IGNORE INTO scheduled_action_runs')) {
          if (!runs.some((r) => r.app_id === args[1] && r.action_name === args[2] && r.due_at === args[4])) {
            runs.push({ run_id: String(args[0]), app_id: String(args[1]), action_name: String(args[2]), due_at: Number(args[4]), status: 'due' });
          }
          return { meta: { changes: 1 } };
        }
        if (s.startsWith("UPDATE scheduled_action_runs SET status = 'claimed'")) {
          const r = runs.find((x) => x.app_id === args[1] && x.action_name === args[2] && x.due_at === args[3] && x.status === 'due');
          const busy = runs.some((x) => x.app_id === args[1] && x.action_name === args[2] && (x.status === 'claimed' || x.status === 'queued'));
          if (!r || busy) return { meta: { changes: 0 } };
          r.status = 'claimed';
          r.claimed_at = Number(args[0]);
          return { meta: { changes: 1 } };
        }
        if (s.startsWith("UPDATE scheduled_action_runs SET status = 'queued'")) {
          const r = runs.find((x) => x.run_id === args[0] && x.status === 'claimed');
          if (r) r.status = 'queued';
          return { meta: { changes: r ? 1 : 0 } };
        }
        if (s.startsWith("UPDATE scheduled_action_runs SET status = 'succeeded'") || s.startsWith("UPDATE scheduled_action_runs SET status = 'failed'")) {
          const from = s.match(/AND status = '(\w+)'$/)![1];
          const r = runs.find((x) => x.run_id === args[2] && x.status === from);
          if (!r) return { meta: { changes: 0 } };
          r.status = s.includes("'succeeded'") ? 'succeeded' : 'failed';
          if (r.status === 'failed') r.error = String(args[1]);
          return { meta: { changes: 1 } };
        }
        if (s.startsWith('INSERT INTO scheduled_action_state')) {
          const k = key(args[0], args[1]);
          const st = state.get(k) ?? { failures: 0, disabled: null };
          if (s.includes('consecutive_failures + 1')) {
            st.failures += 1;
            if (st.failures >= SCHEDULE_FAILURE_BREAKER && st.disabled === null) st.disabled = Number(args.at(-1));
          } else {
            st.failures = 0; st.disabled = null;
          }
          state.set(k, st);
          return { meta: { changes: 1 } };
        }
        if (s.startsWith('INSERT OR IGNORE INTO app_alerts')) { alerts.push(args); return { meta: { changes: 1 } }; }
        return { meta: { changes: 0 } };
      },
    };
    return stmt;
  };
  // The app-events queue: `fail` makes send() throw.
  const sent: AppEventMessage[] = [];
  const queue = { fail: false, send: async (m: AppEventMessage) => { if (queue.fail) throw new Error('queue down'); sent.push(m); } };
  return { env: { DB: { prepare }, APP_EVENTS: queue } as unknown as Env, runs, state, alerts, sent, queue };
}

const TICK = Date.UTC(2026, 9, 6, 10, 10);
const sched = (app_id: string, name: string, cron = '*/5 * * * *', params = '{"n":1}'): Sched => ({ app_id, name, cron, params });
afterEach(() => vi.restoreAllMocks());

describe('worker schedules on the platform tick (#255, #257)', () => {
  it('claims a matching schedule and queues it: run id as the envelope id, the params as payload, status queued', async () => {
    const db = fakeDb([sched('t', 'tick')]);
    const report = await runWorkerSchedules(db.env, TICK, TICK);
    expect(report).toEqual({ due: 1, claimed: 1, queued: 1, failed: 0, skipped: 0 });
    const runId = db.runs[0]!.run_id;
    expect(db.sent).toEqual([{ v: 1, id: runId, app_id: 't', type: 'schedule', name: 'tick', attempt: 1, issued_at: TICK, payload: { n: 1 }, ref: { table: 'scheduled_action_runs', id: runId } }]);
    expect(db.runs[0]).toMatchObject({ action_name: 'worker:tick', due_at: TICK, status: 'queued' });
  });

  it('skips a schedule whose cron does not match the tick', async () => {
    const db = fakeDb([sched('t', 'hourly', '0 * * * *')]);
    expect(await runWorkerSchedules(db.env, TICK, TICK)).toEqual({ due: 0, claimed: 0, queued: 0, failed: 0, skipped: 0 });
    expect(db.sent).toEqual([]);
  });

  it('a queued run is live: the next due minute is not claimed over it, however many ticks pass', async () => {
    const db = fakeDb([sched('t', 'tick')]);
    await runWorkerSchedules(db.env, TICK, TICK);
    for (let i = 1; i <= 3; i++) expect(await runWorkerSchedules(db.env, TICK + i * 300_000, TICK + i * 300_000)).toMatchObject({ due: 1, claimed: 0, skipped: 1 });
    expect(db.runs).toHaveLength(1);
    expect(db.sent).toHaveLength(1);
  });

  it('a queue that rejects the send fails the run once, with the breaker advanced once', async () => {
    const db = fakeDb([sched('t', 'tick')]);
    db.queue.fail = true;
    expect(await runWorkerSchedules(db.env, TICK, TICK)).toMatchObject({ claimed: 1, queued: 0, failed: 1 });
    expect(db.runs[0]).toMatchObject({ status: 'failed', error: 'could not enqueue: queue down' });
    expect(db.state.get('t|worker:tick')?.failures).toBe(1);
  });

  it('claims a run-now row left due (ms due_at) first and does not double-run the same schedule on the tick', async () => {
    const runNow: Run = { run_id: 'manual-1', app_id: 't', action_name: 'worker:tick', due_at: runNowDueAt(TICK - 90_000), status: 'due' };
    const orphan: Run = { run_id: 'orphan', app_id: 't', action_name: 'worker:other', due_at: TICK - 300_000, status: 'due' };
    const db = fakeDb([sched('t', 'tick'), sched('t', 'other', '0 0 * * *')], [runNow, orphan]);
    const report = await runWorkerSchedules(db.env, TICK, TICK);
    // The manual run went; the tick's own claim for the same schedule waited behind it (one live run at a time).
    expect(db.sent.map((m) => m.id)).toEqual(['manual-1']);
    expect(report).toMatchObject({ due: 2, claimed: 1, queued: 1, skipped: 1 });
    // A minute-aligned orphan from a crashed tick is never backfilled.
    expect(db.runs.find((r) => r.run_id === 'orphan')!.status).toBe('due');
  });

  it('queues every due schedule of one tick', async () => {
    const db = fakeDb([1, 2, 3].flatMap((i) => [sched('a', `s${i}`), sched('b', `s${i}`)]));
    expect(await runWorkerSchedules(db.env, TICK, TICK)).toMatchObject({ claimed: 6, queued: 6 });
    expect(db.sent).toHaveLength(6);
  });

  it('runs after the action loop and never fails it', async () => {
    const db = fakeDb([sched('t', 'tick')]);
    db.queue.fail = true;
    const report = await runScheduledActions({ env: db.env, now: TICK });
    expect(report).toMatchObject({ due: 0, claimed: 0, workers: { claimed: 1, failed: 1 } });
    const broken = { DB: { prepare: (q: string) => (q.includes('app_worker_schedules') ? { all: async () => { throw new Error('no table'); } } : db.env.DB.prepare(q)) } } as unknown as Env;
    expect(await runScheduledActions({ env: broken, now: TICK })).toMatchObject({ due: 0, claimed: 0 });
  });

  it('runNowDueAt is never minute-aligned', () => {
    expect(runNowDueAt(TICK) % 60_000).not.toBe(0);
    expect(runNowDueAt(TICK + 1234)).toBe(TICK + 1234);
  });
});

describe('the queued sweep (#257)', () => {
  it('fails a run queued longer than 60 minutes once, and leaves a younger one alone', async () => {
    const stale: Run = { run_id: 'old', app_id: 't', action_name: 'worker:tick', due_at: TICK - 4_000_000, claimed_at: TICK - STALE_QUEUED_RUN_MS - 1, status: 'queued' };
    const young: Run = { run_id: 'young', app_id: 't', action_name: 'worker:other', due_at: TICK - 600_000, claimed_at: TICK - 600_000, status: 'queued' };
    const db = fakeDb([], [stale, young]);
    const report = await runScheduledActions({ env: db.env, now: TICK });
    expect(report.recovered).toBe(1);
    expect(db.runs.map((r) => [r.run_id, r.status])).toEqual([['old', 'failed'], ['young', 'queued']]);
    expect(db.state.get('t|worker:tick')?.failures).toBe(1);
    // A second sweep finds nothing: the run is failed, so the DLQ (guarded on `queued`) cannot count it again.
    expect((await runScheduledActions({ env: db.env, now: TICK + 300_000 })).recovered).toBe(0);
    expect(db.state.get('t|worker:tick')?.failures).toBe(1);
  });
});

describe('invokeWorkerRun (#255)', () => {
  const run: ClaimedWorkerRun = { appId: 't', schedule: 'tick', params: { full: true }, runId: 'r1' };
  const hostAnswering = (result: Partial<host.InvokeResult> | Error) => {
    const invoke = vi.fn(async () => { if (result instanceof Error) throw result; return { invocationId: 'r1:1', httpStatus: null, body: null, status: 'succeeded', ...result } as host.InvokeResult; });
    vi.spyOn(host, 'appWorkerHost').mockReturnValue({ backend: 'loader', invoke, deploy: vi.fn(), remove: vi.fn() } as unknown as host.AppWorkerHost);
    return invoke;
  };

  it('invokes a schedule envelope with the run id, params and the 5-minute budget', async () => {
    const invoke = hostAnswering({ status: 'succeeded', httpStatus: 200 });
    expect(await invokeWorkerRun({} as Env, run)).toEqual({ ok: true });
    expect(invoke).toHaveBeenCalledWith('t', { id: 'r1', type: 'schedule', name: 'tick', attempt: 1, payload: { full: true } }, { timeoutMs: WORKER_SCHEDULE_TIMEOUT_MS });
  });

  it('maps a timeout, a non-2xx and a throw to failures with a readable error', async () => {
    hostAnswering({ status: 'timeout' });
    expect(await invokeWorkerRun({} as Env, run)).toEqual({ ok: false, error: `worker timed out after ${WORKER_SCHEDULE_TIMEOUT_MS} ms` });
    hostAnswering({ status: 'failed', httpStatus: 500, body: 'boom' });
    expect(await invokeWorkerRun({} as Env, run)).toEqual({ ok: false, error: 'worker answered 500: boom' });
    hostAnswering(new Error('this app has no active app worker'));
    expect(await invokeWorkerRun({} as Env, run)).toEqual({ ok: false, error: 'this app has no active app worker' });
  });
});
