import { describe, expect, it, vi } from 'vitest';
import {
  ACTION_FAILURE_MIN, ACTION_FAILURE_WINDOW_MS, ALERT_WINDOW_MS, CATCH_UP_MS, ERROR_SPIKE_MIN, QA_CONSECUTIVE_FAILURES, SERVER_5XX_MIN, evaluateErrorSpikes,
} from './error-alerts.js';

// A D1 that answers by SQL shape (#391: counts from the counters, affected users from rows). Log signals are scripted as timestamped events
// and bucketed exactly as the evaluator's grouped query asks (slice size and
// [since, until) from its binds), so the time edges are exercised here; the real
// SQL runs against workerd D1 in runtime-tests/test/backend/alerts.test.ts.
type LogEvent = { app_id: string; at: number; n: number; affected?: number };
type Scenario = {
  clientErrors?: LogEvent[];
  actionFailures?: LogEvent[];
  server5xx?: LogEvent[];
  qaRuns?: { app_id: string; status: string; finished_at: number }[];
  build?: string | null;
  webhooks?: { id: string; url: string; secret: string }[];
};
function fakeDb(s: Scenario) {
  const inserts: unknown[][] = [];
  const stored = new Set<string>();
  // #389: the stored rows, so the delivery claim (dispatched_at / dispatch_claimed_at) behaves as in D1.
  const rows: Record<string, unknown>[] = [];
  const logQueries: { sliceMs: number; since: number; until: number }[] = [];
  const grouped = (events: LogEvent[] | undefined, [sliceMs, since, until, appId]: unknown[]) => {
    logQueries.push({ sliceMs: sliceMs as number, since: since as number, until: until as number });
    const out = new Map<string, { app_id: string; slice: number; n: number; affected: number }>();
    for (const e of events ?? []) {
      if (e.at < (since as number) || e.at >= (until as number) || (appId && e.app_id !== appId)) continue;
      const slice = Math.floor(e.at / (sliceMs as number)) * (sliceMs as number);
      const row = out.get(`${e.app_id}|${slice}`) ?? { app_id: e.app_id, slice, n: 0, affected: 0 };
      row.n += e.n; row.affected += e.affected ?? 1;
      out.set(`${e.app_id}|${slice}`, row);
    }
    return [...out.values()];
  };
  const prepare = vi.fn((sql: string) => ({
    bind: (...args: unknown[]) => ({
      all: async () => {
        // #391: the counters hold the same events, bucketed to 5 minutes; affected users are not in them.
        if (/FROM app_metric_buckets/.test(sql)) {
          const [sliceMs, since, until, signal, appId] = args;
          const events = { client_error: s.clientErrors, action_failure: s.actionFailures, server_5xx: s.server5xx }[signal as string];
          const bucketed = (events ?? []).map((e) => ({ ...e, at: Math.floor(e.at / 300_000) * 300_000 }));
          return { results: grouped(bucketed, [sliceMs, since, until, appId]).map(({ affected: _a, ...r }) => r) };
        }
        if (/GROUP BY app_id, slice/.test(sql)) {
          if (/source != 'server'/.test(sql)) return { results: grouped(s.clientErrors, args) };
          if (/category = 'action'/.test(sql)) return { results: grouped(s.actionFailures, args) };
          if (/level = 'error'/.test(sql)) return { results: grouped(s.server5xx, args) };
        }
        if (/GROUP BY k/.test(sql)) return { results: [{ k: sql.includes('category') && !sql.includes('json_extract') ? 'runtime' : sql.includes('json_extract') ? 'list_leads' : 'fp-1', n: 7 }] };
        if (/FROM app_test_runs/.test(sql)) {
          const [since, until, appId] = args as [number, number, string?];
          return { results: (s.qaRuns ?? []).filter((r) => r.finished_at >= since && r.finished_at < until && (!appId || r.app_id === appId))
            .sort((a, b) => a.app_id.localeCompare(b.app_id) || b.finished_at - a.finished_at) };
        }
        if (/FROM app_webhooks/.test(sql)) return { results: s.webhooks ?? [] };
        if (/FROM app_alerts\s+WHERE dispatched_at IS NULL/.test(sql)) {
          const [after, ...rest] = args as [number, ...string[]];
          const appId = rest.length > 4 ? rest[4] : undefined;
          return { results: rows.filter((r) => r.dispatched_at === null && (r.created_at as number) > after && (!appId || r.app_id === appId)) };
        }
        return { results: [] };
      },
      first: async () => (/build_meta FROM app_logs/.test(sql) ? (s.build ? { build_meta: s.build } : null) : null),
      run: async () => {
        if (/INSERT OR IGNORE INTO app_alerts/.test(sql)) {
          // The unique (app_id, kind, window_start) index.
          const key = `${args[0]}|${args[1]}|${args[2]}`;
          if (stored.has(key)) return { meta: { changes: 0 } };
          stored.add(key); inserts.push(args);
          const [app_id, kind, window_start, window_end, count, affected_users, baseline, top, build_meta, created_at] = args;
          rows.push({ id: rows.length + 1, app_id, kind, window_start, window_end, count, affected_users, baseline, top, build_meta, created_at, dispatched_at: null, dispatch_claimed_at: null });
          return { meta: { changes: 1 } };
        }
        if (/SET dispatch_claimed_at/.test(sql)) {
          const [now, id, lease] = args as [number, number, number];
          const r = rows.find((x) => x.id === id);
          if (!r || r.dispatched_at !== null || (r.dispatch_claimed_at !== null && (r.dispatch_claimed_at as number) > now - lease)) return { meta: { changes: 0 } };
          r.dispatch_claimed_at = now;
          return { meta: { changes: 1 } };
        }
        if (/SET dispatched_at/.test(sql)) {
          const [now, id] = args as [number, number];
          const r = rows.find((x) => x.id === id && x.dispatch_claimed_at === now);
          if (!r) return { meta: { changes: 0 } };
          r.dispatched_at = now;
          return { meta: { changes: 1 } };
        }
        return { meta: { changes: 0 } };
      },
    }),
  }));
  return { db: { prepare } as unknown as D1Database, inserts, logQueries };
}

// A quarter-hour boundary: the interval [Q - 15m, Q) has just completed at Q.
const Q = 1_800_000_000_000 + ALERT_WINDOW_MS;
const PREV = Q - ALERT_WINDOW_MS;
const burst = (app_id: string, at: number, n: number): LogEvent[] => [{ app_id, at, n, affected: 3 }];

describe('evaluateErrorSpikes (#107)', () => {
  it('records nothing when every signal is below threshold', async () => {
    const { db, inserts } = fakeDb({ clientErrors: burst('a', PREV + 1000, ERROR_SPIKE_MIN - 1), actionFailures: burst('a', Q - 1000, ACTION_FAILURE_MIN - 1), server5xx: burst('a', Q - 1000, SERVER_5XX_MIN - 1) });
    const r = await evaluateErrorSpikes({ env: { DB: db }, now: Q });
    expect(r.alerts).toEqual([]);
    expect(r.recorded).toBe(0);
    expect(inserts).toHaveLength(0);
  });

  it('a client error spike needs both the minimum and a jump over the previous window; the payload carries counts, tops and build — no messages or user ids', async () => {
    const { db, inserts } = fakeDb({
      clientErrors: [...burst('leads', PREV + 1000, 40), ...burst('steady', PREV + 1000, 40), ...burst('steady', PREV - 1000, ERROR_SPIKE_MIN - 1)],
      build: '{"sha":"abc123","version":"1.2.0"}',
    });
    const r = await evaluateErrorSpikes({ env: { DB: db }, now: Q });
    expect(r.alerts.map((a) => [a.app_id, a.kind])).toEqual([['leads', 'error_spike']]);
    const a = r.alerts[0]!;
    expect(a).toMatchObject({ count: 40, affected_users: 3, baseline: 0, window_start: PREV, window_end: Q, build: { sha: 'abc123' } });
    expect(a.top).toEqual({ categories: [{ category: 'runtime', count: 7 }], operations: [{ operation: 'list_leads', count: 7 }], fingerprints: [{ fingerprint: 'fp-1', count: 7 }] });
    expect(JSON.stringify(a)).not.toMatch(/message|user_id|client_id|password|token/);
    expect(inserts).toHaveLength(1);
    expect(inserts[0]!.slice(0, 4)).toEqual(['leads', 'error_spike', PREV, Q]);
    expect(r.recorded).toBe(1);
  });

  it('action failures, sustained 5xx and consecutive QA failures each produce their own kind', async () => {
    const t = Q - 60_000;
    const { db } = fakeDb({
      actionFailures: burst('crm', t, ACTION_FAILURE_MIN),
      server5xx: burst('crm', t, SERVER_5XX_MIN),
      qaRuns: [
        { app_id: 'crm', status: 'failed', finished_at: t }, { app_id: 'crm', status: 'error', finished_at: t - 1000 }, { app_id: 'crm', status: 'passed', finished_at: t - 2000 },
        { app_id: 'ok', status: 'failed', finished_at: t }, { app_id: 'ok', status: 'passed', finished_at: t - 1000 },
      ],
    });
    const r = await evaluateErrorSpikes({ env: { DB: db }, now: Q });
    expect(r.alerts.map((a) => `${a.app_id}:${a.kind}:${a.count}`).sort()).toEqual([`crm:action_failures:${ACTION_FAILURE_MIN}`, `crm:qa_failures:${QA_CONSECUTIVE_FAILURES}`, `crm:server_5xx:${SERVER_5XX_MIN}`]);
  });

  it('scopes to one app on demand and delivers to a registered webhook only', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('ok', { status: 200 })));
    try {
      const { db } = fakeDb({ clientErrors: [...burst('leads', PREV + 1000, 50), ...burst('other', PREV + 1000, 50)], webhooks: [{ id: 'w1', url: 'https://hooks.example/alert', secret: 's' }] });
      const r = await evaluateErrorSpikes({ env: { DB: db }, now: Q, appId: 'leads' });
      expect(r.alerts.map((a) => a.app_id)).toEqual(['leads']);
      const calls = (fetch as unknown as { mock: { calls: unknown[][] } }).mock.calls;
      expect(calls).toHaveLength(1);
      expect(String(calls[0]![0])).toBe('https://hooks.example/alert');
      const body = JSON.parse(String((calls[0]![1] as RequestInit).body)) as { event: string; kind: string; app_id: string };
      expect(body).toMatchObject({ event: 'app.alert', kind: 'error_spike', app_id: 'leads' });
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe('completed intervals, cadence and catch-up (#389)', () => {
  it.each([['exactly on the quarter-hour', Q], ['1 ms after it', Q + 1], ['on the next five-minute tick', Q + 5 * 60_000]])(
    'at %s, no query ends after the evaluation time and the preceding interval alerts', async (_when, now) => {
      const { db, logQueries } = fakeDb({ clientErrors: burst('leads', Q - 1, ERROR_SPIKE_MIN), server5xx: burst('api', PREV, SERVER_5XX_MIN) });
      const r = await evaluateErrorSpikes({ env: { DB: db }, now });
      expect(logQueries.length).toBeGreaterThan(0);
      for (const q of logQueries) expect(q.until).toBeLessThanOrEqual(now);
      for (const a of r.alerts) expect(a.window_end).toBeLessThanOrEqual(now);
      expect(r.alerts.map((a) => [a.app_id, a.kind, a.window_start, a.window_end]).sort()).toEqual([['api', 'server_5xx', PREV, Q], ['leads', 'error_spike', PREV, Q]]);
    });

  it('rows at or after the evaluation time are not counted — they belong to an interval that has not completed', async () => {
    const { db } = fakeDb({ clientErrors: burst('leads', Q, ERROR_SPIKE_MIN), actionFailures: burst('leads', Q, ACTION_FAILURE_MIN), server5xx: burst('leads', Q + 1, SERVER_5XX_MIN) });
    const r = await evaluateErrorSpikes({ env: { DB: db }, now: Q });
    expect(r.alerts).toEqual([]);
  });

  it('a five-minute action-failure burst anywhere in a 15-minute period is caught by the five-minute ticks', async () => {
    for (const offset of [0, 3, 5, 9, 10, 14]) {
      const at = PREV + offset * 60_000 + 30_000;
      const { db, inserts } = fakeDb({ actionFailures: burst('crm', at, ACTION_FAILURE_MIN) });
      for (let tick = PREV; tick <= Q + 15 * 60_000; tick += ACTION_FAILURE_WINDOW_MS) await evaluateErrorSpikes({ env: { DB: db }, now: tick });
      const sliceStart = Math.floor(at / ACTION_FAILURE_WINDOW_MS) * ACTION_FAILURE_WINDOW_MS;
      expect(inserts.map((i) => i.slice(0, 4)), `burst at +${offset}m`).toEqual([['crm', 'action_failures', sliceStart, sliceStart + ACTION_FAILURE_WINDOW_MS]]);
    }
  });

  it('an action-failure slice that has not completed yet is not evaluated', async () => {
    const { db } = fakeDb({ actionFailures: burst('crm', Q + 60_000, ACTION_FAILURE_MIN) });
    expect((await evaluateErrorSpikes({ env: { DB: db }, now: Q + 4 * 60_000 })).alerts).toEqual([]);
    expect((await evaluateErrorSpikes({ env: { DB: db }, now: Q + 5 * 60_000 })).alerts.map((a) => [a.window_start, a.window_end])).toEqual([[Q, Q + 5 * 60_000]]);
  });

  it('repeated evaluation of an interval records and delivers one alert', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('ok', { status: 200 })));
    try {
      const { db, inserts } = fakeDb({ clientErrors: burst('leads', PREV + 1000, 50), actionFailures: burst('leads', Q - 1000, ACTION_FAILURE_MIN), webhooks: [{ id: 'w1', url: 'https://hooks.example/alert', secret: 's' }] });
      const recorded: number[] = [];
      for (const now of [Q, Q, Q + 1, Q + 5 * 60_000, Q + 10 * 60_000, Q + 15 * 60_000 - 1]) recorded.push((await evaluateErrorSpikes({ env: { DB: db }, now })).recorded);
      expect(recorded).toEqual([2, 0, 0, 0, 0, 0]);
      expect(inserts).toHaveLength(2);
      expect((fetch as unknown as { mock: { calls: unknown[] } }).mock.calls).toHaveLength(2);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('delayed or missed ticks are caught up within CATCH_UP_MS; older intervals are a gap, not a burst', async () => {
    const scenario = { clientErrors: burst('leads', PREV + 1000, 50), actionFailures: burst('crm', PREV + 1000, ACTION_FAILURE_MIN) };
    // A tick 2 minutes late evaluates the same completed interval.
    const late = await evaluateErrorSpikes({ env: { DB: fakeDb(scenario).db }, now: Q + 2 * 60_000 });
    expect(late.alerts.map((a) => [a.kind, a.window_start]).sort()).toEqual([['action_failures', PREV], ['error_spike', PREV]]);
    // The Q, Q+5m and Q+10m ticks were all missed: the Q+15m tick still evaluates [PREV, Q).
    const caughtUp = await evaluateErrorSpikes({ env: { DB: fakeDb(scenario).db }, now: Q + 15 * 60_000 });
    expect(caughtUp.alerts.map((a) => [a.kind, a.window_start]).sort()).toEqual([['action_failures', PREV], ['error_spike', PREV]]);
    // Past the horizon the interval is no longer evaluated.
    const tooLate = await evaluateErrorSpikes({ env: { DB: fakeDb(scenario).db }, now: Q + CATCH_UP_MS });
    expect(tooLate.alerts).toEqual([]);
  });

  it('QA: a streak whose latest failure is before the window is not raised again; one inside it is', async () => {
    const runs = (latest: number) => [
      { app_id: 'crm', status: 'failed', finished_at: latest }, { app_id: 'crm', status: 'failed', finished_at: latest - 1000 }, { app_id: 'crm', status: 'passed', finished_at: latest - 2000 },
    ];
    const inside = await evaluateErrorSpikes({ env: { DB: fakeDb({ qaRuns: runs(Q - 1) }).db }, now: Q });
    expect(inside.alerts.map((a) => [a.kind, a.window_start, a.window_end])).toEqual([['qa_failures', PREV, Q]]);
    // Its window is the one that held the latest failure, so later windows don't repeat it.
    const later = await evaluateErrorSpikes({ env: { DB: fakeDb({ qaRuns: runs(PREV - 1) }).db }, now: Q + 15 * 60_000 });
    expect(later.alerts).toEqual([]);
    // A failure finishing after the evaluation time is not counted yet.
    expect((await evaluateErrorSpikes({ env: { DB: fakeDb({ qaRuns: runs(Q) }).db }, now: Q })).alerts).toEqual([]);
  });
});
