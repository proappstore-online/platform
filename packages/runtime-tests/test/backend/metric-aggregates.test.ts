import { SELF, env, fetchMock } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resetBurstState } from '../../../backend/src/lib/log-quota';
import { utcDayKey } from '../../../backend/src/lib/day-key';
import { BASE, json, mockNetwork, resetTables, seedApp, seedUser, session } from './helpers';

// #391 stage (a) on real D1: the incident counters move whether or not detail is
// kept, each budget is exhausted independently, and public ingestion can only
// ever add client signals.

const APP = 'agg-demo';
const metrics = async () =>
  Object.fromEntries(((await env.DB.prepare('SELECT signal, SUM(n) AS n FROM app_metric_buckets WHERE app_id = ? GROUP BY signal').bind(APP).all<{ signal: string; n: number }>()).results ?? []).map((r) => [r.signal, r.n]));
const rows = async (source: string) =>
  ((await env.DB.prepare('SELECT COUNT(*) AS n FROM app_logs WHERE app_id = ? AND source = ?').bind(APP, source).first<{ n: number }>())?.n ?? 0);
async function eventually<T>(read: () => Promise<T>, ok: (v: T) => boolean): Promise<T> {
  let v = await read();
  for (let i = 0; i < 50 && !ok(v); i++) { await new Promise((r) => setTimeout(r, 20)); v = await read(); }
  return v;
}
const spend = (column: 'count' | 'server_count', n: number) =>
  env.DB.prepare(`INSERT INTO app_log_usage (app_id, day, ${column}) VALUES (?, ?, ?)`).bind(APP, utcDayKey(Date.now()), n).run();
// A fresh client per call: the client_error counter admits one add per (app, client) per minute (#438),
// and that limiter's state outlives a test.
let clientSeq = 0;
const ingest = (entries: object[]) => SELF.fetch(`${BASE}/v1/apps/${APP}/logs`, json('POST', { entries, clientId: `client-${Date.now()}-${clientSeq++}-xxxx` }));
const errorEntry = { level: 'error', category: 'runtime', message: 'boom', ts: Date.now() };
const actionTool = { name: 'list_cases', description: 'l', operation: 'query', sql: 'SELECT 1 WHERE :__user_id IS NOT NULL', params: {}, requires_auth: true };

beforeEach(async () => {
  mockNetwork();
  resetBurstState();
  await resetTables();
  await env.DB.prepare('DELETE FROM app_metric_buckets').run();
  await seedUser('gh:1'); await seedApp(APP, 'gh:1');
  const now = Date.now();
  await env.DB.prepare("INSERT INTO app_tools (app_id, name, manifest, created_at, updated_at, source) VALUES (?, 'list_cases', ?, ?, ?, 'code')")
    .bind(APP, JSON.stringify(actionTool), now, now).run();
});
afterEach(() => fetchMock.assertNoPendingInterceptors());

describe('incident aggregates (#391 stage a)', () => {
  it('client detail budget exhausted: no rows, but client errors and the drop are counted', async () => {
    await spend('count', 50_000);
    const res = await ingest([errorEntry, errorEntry, { ...errorEntry, level: 'warn' }]);
    expect(res.status).toBe(202);
    expect(await rows('direct')).toBe(0);
    // One request adds 1 to client_error however many errors it carries (#438); the drop counts every entry.
    expect(await metrics()).toEqual({ client_error: 1, detail_dropped_client: 3 });
  });

  it('server detail budget exhausted: no server row, but the action failure and 5xx are counted', async () => {
    await spend('server_count', 10_000);
    fetchMock.get(`https://pas-data-${APP}.${env.DATA_WORKER_HOST}`).intercept({ path: '/query', method: 'POST' })
      .reply(500, { error: 'internal server error' }, { headers: { 'X-PAS-Fault': 'platform' } });
    const res = await SELF.fetch(`${BASE}/v1/apps/${APP}/actions/list_cases`, json('POST', { params: {} }, await session('gh:1')));
    expect(res.status).toBe(500);
    const m = await eventually(metrics, (v) => v.detail_dropped_server === 1);
    expect(m).toEqual({ action_failure: 1, server_5xx: 1, detail_dropped_server: 1 });
    expect(await rows('server')).toBe(0);
  });

  it('the two budgets are independent: a spent client budget does not stop server rows or counts', async () => {
    await spend('count', 50_000);
    fetchMock.get(`https://pas-data-${APP}.${env.DATA_WORKER_HOST}`).intercept({ path: '/query', method: 'POST' })
      .reply(500, { error: 'internal server error' }, { headers: { 'X-PAS-Fault': 'platform' } });
    await SELF.fetch(`${BASE}/v1/apps/${APP}/actions/list_cases`, json('POST', { params: {} }, await session('gh:1')));
    await eventually(() => rows('server'), (n) => n === 1);
    expect(await metrics()).toEqual({ action_failure: 1, server_5xx: 1 });
  });

  it('public ingestion cannot mint server signals, whatever it claims', async () => {
    await ingest([{ ...errorEntry, category: 'action', source: 'server', data: { status: 500 } }]);
    const m = await metrics();
    expect(Object.keys(m).every((s) => s.startsWith('client_') || s === 'detail_dropped_client')).toBe(true);
    expect(m.client_error).toBe(1);
  });

  // #391 bounded cost: every counter read is an index range, never a scan of the table.
  it('the evaluator and health queries search an index, never scan app_metric_buckets', async () => {
    const plan = async (sql: string, ...binds: unknown[]) =>
      ((await env.DB.prepare(`EXPLAIN QUERY PLAN ${sql}`).bind(...binds).all<{ detail: string }>()).results ?? []).map((r) => r.detail).join(' | ');
    const evaluatorAll = await plan(
      'SELECT app_id, CAST(bucket_start / ?1 AS INTEGER) * ?1 AS slice, SUM(n) AS n FROM app_metric_buckets WHERE bucket_start >= ?2 AND bucket_start < ?3 AND signal = ?4 GROUP BY app_id, slice',
      900_000, 0, 1, 'client_error');
    const evaluatorOne = await plan(
      'SELECT app_id, CAST(bucket_start / ?1 AS INTEGER) * ?1 AS slice, SUM(n) AS n FROM app_metric_buckets WHERE bucket_start >= ?2 AND bucket_start < ?3 AND signal = ?4 AND app_id = ?5 GROUP BY app_id, slice',
      900_000, 0, 1, 'client_error', APP);
    const health = await plan(
      'SELECT signal, SUM(CASE WHEN bucket_start >= ?2 THEN n ELSE 0 END) AS last_hour, SUM(n) AS last_day FROM app_metric_buckets WHERE app_id = ?1 AND bucket_start >= ?3 GROUP BY signal',
      APP, 0, 0);
    const sweep = await plan('DELETE FROM app_metric_buckets WHERE rowid IN (SELECT rowid FROM app_metric_buckets WHERE bucket_start < ? LIMIT ?)', 0, 10);
    for (const [name, p] of Object.entries({ evaluatorAll, evaluatorOne, health, sweep })) {
      expect(p, name).toMatch(/SEARCH app_metric_buckets USING (COVERING )?INDEX/);
      expect(p, name).not.toMatch(/SCAN app_metric_buckets(?! USING)/);
    }
  });
});
