import { describe, expect, it, vi } from 'vitest';
import { ACTION_FAILURE_MIN, ERROR_SPIKE_MIN, QA_CONSECUTIVE_FAILURES, SERVER_5XX_MIN, evaluateErrorSpikes } from './error-alerts.js';

// A D1 that answers by SQL shape, so the evaluator's queries can be scripted per
// signal: client errors (current + previous window), action failures, server 5xx,
// QA runs, top-N breakdowns, latest build, and the insert.
type Scenario = {
  clientErrors?: { cur?: { app_id: string; n: number; affected: number }[]; prev?: { app_id: string; n: number; affected: number }[] };
  actionFailures?: { app_id: string; n: number; affected: number }[];
  server5xx?: { app_id: string; n: number; affected: number }[];
  qaRuns?: { app_id: string; status: string; finished_at: number }[];
  build?: string | null;
  webhooks?: { id: string; url: string; secret: string }[];
};
function fakeDb(s: Scenario, now: number) {
  const inserts: unknown[][] = [];
  const windowMs = 15 * 60_000;
  const windowEnd = Math.floor(now / windowMs) * windowMs + windowMs;
  const windowStart = windowEnd - windowMs;
  const prepare = vi.fn((sql: string) => ({
    bind: (...args: unknown[]) => ({
      all: async () => {
        if (/FROM app_logs WHERE ingested_at/.test(sql)) {
          const since = args[0] as number;
          if (/source != 'server'/.test(sql)) return { results: since === windowStart ? s.clientErrors?.cur ?? [] : s.clientErrors?.prev ?? [] };
          if (/category = 'action'/.test(sql)) return { results: s.actionFailures ?? [] };
          if (/level = 'error'/.test(sql)) return { results: s.server5xx ?? [] };
        }
        if (/GROUP BY k/.test(sql)) return { results: [{ k: sql.includes('category') && !sql.includes('json_extract') ? 'runtime' : sql.includes('json_extract') ? 'list_leads' : 'fp-1', n: 7 }] };
        if (/FROM app_test_runs/.test(sql)) return { results: s.qaRuns ?? [] };
        if (/FROM app_webhooks/.test(sql)) return { results: s.webhooks ?? [] };
        return { results: [] };
      },
      first: async () => (/build_meta FROM app_logs/.test(sql) ? (s.build ? { build_meta: s.build } : null) : null),
      run: async () => { if (/INSERT OR IGNORE INTO app_alerts/.test(sql)) { inserts.push(args); return { meta: { changes: 1 } }; } return { meta: { changes: 0 } }; },
    }),
  }));
  return { db: { prepare } as unknown as D1Database, inserts, windowStart, windowEnd };
}
const NOW = 1_700_000_000_000 + 7 * 60_000;

describe('evaluateErrorSpikes (#107)', () => {
  it('records nothing when every signal is below threshold', async () => {
    const { db, inserts } = fakeDb({ clientErrors: { cur: [{ app_id: 'a', n: ERROR_SPIKE_MIN - 1, affected: 3 }] }, actionFailures: [{ app_id: 'a', n: ACTION_FAILURE_MIN - 1, affected: 1 }], server5xx: [{ app_id: 'a', n: SERVER_5XX_MIN - 1, affected: 1 }] }, NOW);
    const r = await evaluateErrorSpikes({ env: { DB: db }, now: NOW });
    expect(r.alerts).toEqual([]);
    expect(r.recorded).toBe(0);
    expect(inserts).toHaveLength(0);
  });

  it('a client error spike needs both the minimum and a jump over the previous window; the payload carries counts, tops and build — no messages or user ids', async () => {
    const { db, inserts, windowStart, windowEnd } = fakeDb({
      clientErrors: { cur: [{ app_id: 'leads', n: 40, affected: 9 }, { app_id: 'steady', n: 40, affected: 9 }], prev: [{ app_id: 'steady', n: 30, affected: 8 }] },
      build: '{"sha":"abc123","version":"1.2.0"}',
    }, NOW);
    const r = await evaluateErrorSpikes({ env: { DB: db }, now: NOW });
    expect(r.alerts.map((a) => [a.app_id, a.kind])).toEqual([['leads', 'error_spike']]);
    const a = r.alerts[0]!;
    expect(a).toMatchObject({ count: 40, affected_users: 9, baseline: 0, window_start: windowStart, window_end: windowEnd, build: { sha: 'abc123' } });
    expect(a.top).toEqual({ categories: [{ category: 'runtime', count: 7 }], operations: [{ operation: 'list_leads', count: 7 }], fingerprints: [{ fingerprint: 'fp-1', count: 7 }] });
    expect(JSON.stringify(a)).not.toMatch(/message|user_id|client_id|password|token/);
    expect(inserts).toHaveLength(1);
    expect(inserts[0]!.slice(0, 4)).toEqual(['leads', 'error_spike', windowStart, windowEnd]);
    expect(r.recorded).toBe(1);
  });

  it('action failures, sustained 5xx and consecutive QA failures each produce their own kind', async () => {
    const t = NOW - 60_000;
    const { db } = fakeDb({
      actionFailures: [{ app_id: 'crm', n: ACTION_FAILURE_MIN, affected: 4 }],
      server5xx: [{ app_id: 'crm', n: SERVER_5XX_MIN, affected: 2 }],
      qaRuns: [
        { app_id: 'crm', status: 'failed', finished_at: t }, { app_id: 'crm', status: 'error', finished_at: t - 1000 }, { app_id: 'crm', status: 'passed', finished_at: t - 2000 },
        { app_id: 'ok', status: 'failed', finished_at: t }, { app_id: 'ok', status: 'passed', finished_at: t - 1000 },
      ],
    }, NOW);
    const r = await evaluateErrorSpikes({ env: { DB: db }, now: NOW });
    expect(r.alerts.map((a) => `${a.app_id}:${a.kind}:${a.count}`).sort()).toEqual([`crm:action_failures:${ACTION_FAILURE_MIN}`, `crm:qa_failures:${QA_CONSECUTIVE_FAILURES}`, `crm:server_5xx:${SERVER_5XX_MIN}`]);
  });

  it('scopes to one app on demand and delivers to a registered webhook only', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('ok', { status: 200 })));
    try {
      const { db } = fakeDb({ clientErrors: { cur: [{ app_id: 'leads', n: 50, affected: 5 }] }, webhooks: [{ id: 'w1', url: 'https://hooks.example/alert', secret: 's' }] }, NOW);
      const r = await evaluateErrorSpikes({ env: { DB: db }, now: NOW, appId: 'leads' });
      expect(r.alerts).toHaveLength(1);
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
