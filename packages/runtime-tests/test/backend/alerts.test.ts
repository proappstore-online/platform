import { SELF, env, fetchMock } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { evaluateErrorSpikes } from '../../../backend/src/lib/error-alerts';
import { BASE, json, mockNetwork, resetTables, seedApp, seedUser, session } from './helpers';

beforeEach(async () => { mockNetwork(); await resetTables(); await env.DB.prepare('DELETE FROM app_alerts').run(); await env.DB.prepare('DELETE FROM app_test_runs').run(); });

// A quarter-hour boundary (1_800_000_000_000 is a multiple of 15 minutes).
const B = 1_800_000_000_000;
const log = (app: string, at: number, source: string, category: string, level = 'error') =>
  env.DB.prepare("INSERT INTO app_logs (app_id, user_id, client_id, ts, level, category, message, data, build_meta, fingerprint, trace_id, source, ingested_at) VALUES (?, 'gh:u1', NULL, ?, ?, ?, 'boom', '{\"action\":\"save\"}', NULL, 'fp', NULL, ?, ?)")
    .bind(app, at, level, category, source, at);

// #107 on a real D1: the evaluator's GROUP BY / json_extract / DISTINCT queries
// run against the actual app_logs schema, the unique bucket index absorbs a
// re-run, and the owner route reads the row back.
describe('error-spike alerts against real D1', () => {
  it('detects a client error spike, records it once across re-runs, and the owner reads it', async () => {
    await seedUser('gh:1'); await seedApp('demo', 'gh:1');
    // Rows midway through the 15-minute interval [B, B + 15m); the evaluator runs
    // once it has completed, at an explicit time (no wall clock).
    const at = B + 450_000;
    const rows = Array.from({ length: 25 }, (_, i) =>
      env.DB.prepare("INSERT INTO app_logs (app_id, user_id, client_id, ts, level, category, message, data, build_meta, fingerprint, trace_id, source, ingested_at) VALUES ('demo', ?, NULL, ?, 'error', 'runtime', 'boom', '{\"route\":\"/\"}', '{\"sha\":\"abc123\"}', ?, NULL, 'mediated', ?)")
        .bind(`gh:u${i % 6}`, at, i % 2 ? 'fp-a' : 'fp-b', at));
    await env.DB.batch(rows);
    // #389: while the interval is still open nothing is evaluated over it.
    expect((await evaluateErrorSpikes({ env, now: at + 1000 })).alerts).toEqual([]);
    const now = B + 15 * 60_000;
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
    // Its own app id + the evaluator's per-app mode: another file's deploy nudge
    // can land a fresh `queued` run for 'demo' after this test's cleanup, which
    // would sit in front of the two failures and hide them (order-dependent flake).
    await seedUser('gh:1'); await seedApp('qa-demo', 'gh:1');
    // Runs inside [B, B + 15m), evaluated at an explicit time once it has completed.
    const now = B + 15 * 60_000;
    const run = (id: string, status: string, at: number) => env.DB.prepare("INSERT INTO app_test_runs (run_id, app_id, flow_id, trigger_kind, status, started_at, finished_at) VALUES (?, 'qa-demo', 'f1', 'deploy', ?, ?, ?)").bind(id, status, at - 10, at);
    await env.DB.batch([run('r1', 'passed', now - 30_000), run('r2', 'failed', now - 20_000), run('r3', 'error', now - 10_000)]);
    const r = await evaluateErrorSpikes({ env, now, appId: 'qa-demo' });
    expect(r.alerts.map((a) => [a.kind, a.count])).toEqual([['qa_failures', 2]]);
  });

  // #389: the real SQL's interval edges, the five-minute action slices, and one
  // row + one webhook delivery however often an interval is evaluated.
  it('counts a row at windowEnd - 1 ms in the completed interval and one at windowEnd in the next', async () => {
    await seedUser('gh:1'); await seedApp('edge', 'gh:1');
    const end = B + 15 * 60_000;
    await env.DB.batch([
      ...Array.from({ length: 20 }, () => log('edge', end - 1, 'mediated', 'runtime')),
      ...Array.from({ length: 30 }, () => log('edge', end, 'mediated', 'runtime')),
    ]);
    const r = await evaluateErrorSpikes({ env, now: end, appId: 'edge' });
    expect(r.alerts.map((a) => [a.kind, a.window_start, a.window_end, a.count])).toEqual([['error_spike', B, end, 20]]);
  });

  it('action failures are counted per completed five-minute slice, at every tick through the period', async () => {
    await seedUser('gh:1'); await seedApp('act', 'gh:1');
    // A burst straddling no boundary, in the middle slice [B + 5m, B + 10m).
    await env.DB.batch(Array.from({ length: 20 }, (_, i) => log('act', B + 6 * 60_000 + i * 1000, 'server', 'action')));
    const seen: number[] = [];
    for (let tick = B; tick <= B + 15 * 60_000; tick += 5 * 60_000) seen.push((await evaluateErrorSpikes({ env, now: tick, appId: 'act' })).recorded);
    // The slice alerts at the B + 10m tick; the same server error rows also raise the
    // 15-minute server_5xx window once it completes at B + 15m.
    expect(seen).toEqual([0, 0, 1, 1]);
    const rows = await env.DB.prepare("SELECT kind, window_start, window_end, count FROM app_alerts WHERE app_id = 'act' ORDER BY window_start, kind").all();
    expect(rows.results).toEqual([
      { kind: 'server_5xx', window_start: B, window_end: B + 15 * 60_000, count: 20 },
      { kind: 'action_failures', window_start: B + 5 * 60_000, window_end: B + 10 * 60_000, count: 20 },
    ]);
  });

  it('re-evaluating the same interval keeps one row and makes one webhook delivery', async () => {
    await seedUser('gh:1'); await seedApp('dup', 'gh:1');
    await env.DB.prepare('DELETE FROM app_webhooks').run();
    await env.DB.prepare("INSERT INTO app_webhooks (id, app_id, event, url, secret, created_at) VALUES ('wh1', 'dup', 'app.alert', 'https://hooks.example/alert', 's', ?)").bind(B).run();
    let deliveries = 0;
    fetchMock.get('https://hooks.example').intercept({ path: '/alert', method: 'POST' }).reply(200, () => { deliveries += 1; return 'ok'; }).persist();
    await env.DB.batch(Array.from({ length: 25 }, () => log('dup', B + 1000, 'mediated', 'runtime')));
    const now = B + 15 * 60_000;
    const recorded: number[] = [];
    for (const t of [now, now, now + 5 * 60_000]) recorded.push((await evaluateErrorSpikes({ env, now: t })).recorded);
    expect(recorded).toEqual([1, 0, 0]);
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM app_alerts WHERE app_id = 'dup'").first<{ n: number }>())?.n).toBe(1);
    expect(deliveries).toBe(1);
  });
});
