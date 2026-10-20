import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  applyResults,
  assessAll,
  evaluateReliability,
  loadObjectives,
  assessObjective,
  BUCKET_MS,
  EVAL_LAG_MS,
  evaluationEnd,
  FIXTURE_TARGET,
  readOutcomesFromAnalytics,
  type Objective,
  type OutcomeBucket,
} from './reliability.js';
import type { Env } from '../types.js';

// #395 on synthetic fixtures: severe-short and moderate-long incidents, low
// traffic, sustained outage, recovery and degraded telemetry behave as documented.

const NOW = 1_800_000_000_000 + 7 * BUCKET_MS + 60_000; // a minute into a bucket
const END = evaluationEnd(NOW);
const o: Objective = { app: 'demo', family: 'actions', target: FIXTURE_TARGET };
const status = (rs: { rule: string; status: string }[], rule: string) => rs.find((r) => r.rule === rule)?.status;

/** `count` buckets ending at END, newest last; `bad(i)` for bucket i (0 = oldest). */
function series(count: number, total: number, bad: (i: number) => number): OutcomeBucket[] {
  return Array.from({ length: count }, (_, i) => ({ app: 'demo', family: 'actions', start: END - (count - i) * BUCKET_MS, total, bad: bad(i) }));
}

afterEach(() => vi.unstubAllGlobals());

describe('reliability rules (#395)', () => {
  it('windows end a lag before evaluation, on a bucket boundary, never in the future', () => {
    expect(END % BUCKET_MS).toBe(0);
    expect(END).toBeLessThanOrEqual(NOW - EVAL_LAG_MS);
    expect(NOW - EVAL_LAG_MS - END).toBeLessThan(BUCKET_MS);
  });

  it('a short severe incident fires the fast burn only', () => {
    // 6 h of 50 req/bucket, all good, then the last 4 buckets 60% 5xx.
    const rs = assessObjective(o, series(72, 50, (i) => (i >= 68 ? 30 : 0)), END);
    expect(status(rs, 'burn_fast:actions')).toBe('firing');
    expect(status(rs, 'burn_slow:actions')).toBe('ok');
    expect(status(rs, 'outage:actions')).toBe('ok'); // 60% is bad, not a total outage
  });

  it('a long moderate incident fires the slow burn only', () => {
    // 6 h at 8% 5xx: burn 8 — above the slow factor (6), below the fast one (14.4).
    const rs = assessObjective(o, series(72, 50, () => 4), END);
    expect(status(rs, 'burn_slow:actions')).toBe('firing');
    expect(status(rs, 'burn_fast:actions')).toBe('ok');
  });

  it('recovery: once the recent window is clean the fast rule evaluates ok', () => {
    const rs = assessObjective(o, series(72, 50, (i) => (i >= 66 && i < 71 ? 30 : 0)), END);
    expect(status(rs, 'burn_fast:actions')).toBe('ok'); // last 5 min clean: short burn 0
  });

  it('low traffic: burn rules are not evaluated (no state change), whatever the ratio', () => {
    const rs = assessObjective(o, series(6, 2, () => 2), END);
    expect(status(rs, 'burn_fast:actions')).toBe('low_traffic');
    expect(status(rs, 'burn_slow:actions')).toBe('low_traffic');
    expect(status(rs, 'outage:actions')).toBe('ok'); // under 3 requests a bucket is not an outage
  });

  it('a sustained outage needs 3 consecutive buckets of ≥ 90% 5xx with real traffic', () => {
    expect(status(assessObjective(o, series(3, 5, () => 5), END), 'outage:actions')).toBe('firing');
    expect(status(assessObjective(o, series(3, 5, (i) => (i === 0 ? 3 : 5)), END), 'outage:actions')).toBe('ok');
    expect(status(assessObjective(o, series(2, 5, () => 5), END), 'outage:actions')).toBe('ok');
  });

  it('unreadable telemetry is monitoring_degraded and leaves every burn rule unevaluated', async () => {
    const rs = await assessAll({} as Env, [o], NOW, async () => { throw new Error('CF Analytics SQL failed (500)'); });
    expect(status(rs, 'monitoring_degraded')).toBe('firing');
    expect(rs.filter((r) => r.rule !== 'monitoring_degraded').map((r) => r.status)).toEqual(['degraded', 'degraded', 'degraded']);
    const ok = await assessAll({} as Env, [o], NOW, async () => series(72, 50, () => 0));
    expect(status(ok, 'monitoring_degraded')).toBe('ok');
  });

  it('detail carries rates and counts only', () => {
    const rs = assessObjective(o, series(72, 50, () => 4), END);
    const keys = new Set(rs.flatMap((r) => Object.keys(r.detail)));
    expect([...keys].every((k) => /^(family|target|factor|long_|short_|window_end|buckets|ratios)/.test(k))).toBe(true);
  });
});

describe('Analytics Engine reader (#395)', () => {
  it('weights by sample interval and counts only 5xx as bad — a 4xx (validation, cancellation) is good', async () => {
    const t = (END - BUCKET_MS) / 1000;
    let sql = '';
    vi.stubGlobal('fetch', vi.fn(async (_u: string, init: RequestInit) => {
      sql = String(init.body);
      return Response.json({ data: [
        { app: 'demo', family: 'actions', outcome: 'ok', t, n: '40' },
        { app: 'demo', family: 'actions', outcome: '4xx', t, n: 8 },
        { app: 'demo', family: 'actions', outcome: '5xx', t, n: 2 },
      ] });
    }));
    const env = { CF_ACCOUNT_ID: 'acct', CF_ANALYTICS_API_TOKEN: 'tok' } as unknown as Env;
    const buckets = await readOutcomesFromAnalytics(env, ['demo', "x'; DROP"], END - 6 * 3_600_000, END);
    expect(buckets).toEqual([{ app: 'demo', family: 'actions', start: END - BUCKET_MS, total: 50, bad: 2 }]);
    expect(sql).toContain("index1 IN ('demo')"); // a non-slug app id never reaches the query
  });
});

// #395: the incident writes, against a scripted D1 (real-D1 coverage is in runtime-tests).
describe('incident lifecycle writes (#395)', () => {
  function scriptedDb(opts: { inserted: boolean; recovered: boolean; objectives?: { app_id: string; family: string; target: number }[] }) {
    const calls: string[] = [];
    const db = {
      prepare: (sql: string) => ({
        bind: (..._a: unknown[]) => ({
          all: async () => {
            if (sql.includes('FROM app_reliability_objectives')) return { results: opts.objectives ?? [] };
            if (sql.includes("state = 'recovered'") && sql.includes('RETURNING')) { calls.push('recover'); return { results: opts.recovered ? [{ id: 1 }] : [] }; }
            return { results: [] }; // app_webhooks: none registered
          },
          run: async () => {
            if (sql.startsWith('INSERT OR IGNORE INTO app_incidents')) { calls.push('insert'); return { meta: { changes: opts.inserted ? 1 : 0 } }; }
            if (sql.startsWith('UPDATE app_incidents')) calls.push('touch');
            return { meta: { changes: 0 } };
          },
        }),
      }),
    } as unknown as D1Database;
    return { db, calls };
  }
  const warn = () => vi.spyOn(console, 'warn').mockImplementation(() => {});

  it('firing opens once, re-firing only touches, ok recovers, low_traffic/degraded change nothing', async () => {
    const w = warn();
    const rule = (status: 'firing' | 'ok' | 'low_traffic' | 'degraded') => [{ app: 'demo', rule: 'burn_fast:actions', status, detail: {} }];
    const open = scriptedDb({ inserted: true, recovered: false });
    // #395/#389: applyResults only records; deliverPendingIncidents sends what each change owes.
    expect(await applyResults(open.db, rule('firing'), 1)).toEqual({ opened: 1, recovered: 0, notified: 0 });
    const again = scriptedDb({ inserted: false, recovered: false });
    expect(await applyResults(again.db, rule('firing'), 2)).toEqual({ opened: 0, recovered: 0, notified: 0 });
    expect(again.calls).toEqual(['insert', 'touch']);
    const rec = scriptedDb({ inserted: false, recovered: true });
    expect(await applyResults(rec.db, rule('ok'), 3)).toEqual({ opened: 0, recovered: 1, notified: 0 });
    const quiet = scriptedDb({ inserted: true, recovered: true });
    await applyResults(quiet.db, [...rule('low_traffic'), ...rule('degraded')], 4);
    expect(quiet.calls).toEqual([]);
    w.mockRestore();
  });

  it('evaluateReliability does nothing without objectives, and evaluates them when set', async () => {
    const none = scriptedDb({ inserted: true, recovered: false });
    expect(await evaluateReliability({ env: { DB: none.db } as unknown as Env, now: NOW, read: async () => [] })).toEqual({ opened: 0, recovered: 0, notified: 0, evaluated: 0 });
    const some = scriptedDb({ inserted: false, recovered: false, objectives: [{ app_id: 'demo', family: 'actions', target: 0.99 }] });
    expect(await loadObjectives(some.db, 'demo')).toEqual([{ app: 'demo', family: 'actions', target: 0.99 }]);
    const r = await evaluateReliability({ env: { DB: some.db } as unknown as Env, now: NOW, read: async () => series(72, 50, () => 0) });
    expect(r.evaluated).toBe(4); // monitoring_degraded + three rules
  });
});
