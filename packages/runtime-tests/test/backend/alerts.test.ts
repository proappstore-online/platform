import { SELF, env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { evaluateErrorSpikes } from '../../../backend/src/lib/error-alerts';
import { BASE, json, mockNetwork, resetTables, seedApp, seedUser, session } from './helpers';

beforeEach(async () => { mockNetwork(); await resetTables(); await env.DB.prepare('DELETE FROM app_alerts').run(); await env.DB.prepare('DELETE FROM app_test_runs').run(); });

// #107 on a real D1: the evaluator's GROUP BY / json_extract / DISTINCT queries
// run against the actual app_logs schema, the unique bucket index absorbs a
// re-run, and the owner route reads the row back.
describe('error-spike alerts against real D1', () => {
  it('detects a client error spike, records it once across re-runs, and the owner reads it', async () => {
    await seedUser('gh:1'); await seedApp('demo', 'gh:1');
    const now = Date.now();
    const rows = Array.from({ length: 25 }, (_, i) =>
      env.DB.prepare("INSERT INTO app_logs (app_id, user_id, client_id, ts, level, category, message, data, build_meta, fingerprint, trace_id, source, ingested_at) VALUES ('demo', ?, NULL, ?, 'error', 'runtime', 'boom', '{\"route\":\"/\"}', '{\"sha\":\"abc123\"}', ?, NULL, 'mediated', ?)")
        .bind(`gh:u${i % 6}`, now - 1000, i % 2 ? 'fp-a' : 'fp-b', now - 1000));
    await env.DB.batch(rows);
    const first = await evaluateErrorSpikes({ env, now });
    expect(first.alerts.map((a) => [a.app_id, a.kind, a.count, a.affected_users])).toEqual([['demo', 'error_spike', 25, 6]]);
    expect(first.alerts[0]!.top.fingerprints.map((f) => f.fingerprint).sort()).toEqual(['fp-a', 'fp-b']);
    expect(first.alerts[0]!.build).toEqual({ sha: 'abc123' });
    expect(first.recorded).toBe(1);
    const again = await evaluateErrorSpikes({ env, now: now + 60_000 });
    expect(again.recorded).toBe(0);
    const stored = await env.DB.prepare("SELECT COUNT(*) AS n FROM app_alerts WHERE app_id = 'demo'").first<{ n: number }>();
    expect(stored?.n).toBe(1);

    const res = await SELF.fetch(`${BASE}/v1/apps/demo/alerts`, json('GET', undefined, await session('gh:1')));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { alerts: { id: number; kind: string; count: number; top: { fingerprints: unknown[] }; build: { sha: string } }[] };
    expect(body.alerts).toHaveLength(1);
    expect(body.alerts[0]).toMatchObject({ kind: 'error_spike', count: 25, build: { sha: 'abc123' } });
    const ack = await SELF.fetch(`${BASE}/v1/apps/demo/alerts/${body.alerts[0]!.id}/ack`, json('POST', undefined, await session('gh:1')));
    expect(ack.status).toBe(200);
    const open = await SELF.fetch(`${BASE}/v1/apps/demo/alerts?open=1`, json('GET', undefined, await session('gh:1')));
    expect(((await open.json()) as { alerts: unknown[] }).alerts).toEqual([]);
  });

  it('two consecutive failed QA runs raise qa_failures; a pass in between does not', async () => {
    await seedUser('gh:1'); await seedApp('demo', 'gh:1');
    const now = Date.now();
    const run = (id: string, status: string, at: number) => env.DB.prepare("INSERT INTO app_test_runs (run_id, app_id, flow_id, trigger_kind, status, started_at, finished_at) VALUES (?, 'demo', 'f1', 'deploy', ?, ?, ?)").bind(id, status, at - 10, at);
    await env.DB.batch([run('r1', 'passed', now - 30_000), run('r2', 'failed', now - 20_000), run('r3', 'error', now - 10_000)]);
    const r = await evaluateErrorSpikes({ env, now });
    expect(r.alerts.map((a) => [a.kind, a.count])).toEqual([['qa_failures', 2]]);
  });
});
