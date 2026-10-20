import { SELF, env, fetchMock } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resetBurstState } from '../../../backend/src/lib/log-quota';
import { BASE, json, mockNetwork, resetTables, seedApp, seedUser, session, viaHostApi } from './helpers';

// #394 on real D1: a data-worker failure followed by one id from the request that
// caused it, through the API (actions) or the host (browser data plane), to the
// owner-only incident lookup — with the worker's fault verdict deciding whether it
// counts as a platform 5xx, and owner A unable to read app B.

const APP = 'incident-demo';
const OTHER = 'incident-other';
const TRACE = 'ab'.repeat(16);
const CALLER_SPAN = 'cd'.repeat(8);
const TRACEPARENT = `00-${TRACE}-${CALLER_SPAN}-01`;

type Incident = {
  traceId: string;
  hops: Record<string, number>;
  records: { hop: string; source: string; level: string; category: string; data: Record<string, unknown> | null; context: Record<string, unknown> | null }[];
  invocation: Record<string, unknown> | null;
  truncated: boolean;
};

const listCases = {
  name: 'list_cases', description: 'list', operation: 'query',
  sql: 'SELECT id FROM cases WHERE owner = :__user_id', params: {}, requires_auth: true,
};

async function eventually<T>(read: () => Promise<T>, ok: (v: T) => boolean): Promise<T> {
  let v = await read();
  for (let i = 0; i < 50 && !ok(v); i++) { await new Promise((r) => setTimeout(r, 20)); v = await read(); }
  return v;
}
const rowsFor = async (traceId: string) =>
  (await env.DB.prepare('SELECT level, category, data, context, source FROM app_logs WHERE app_id = ? AND trace_id = ?').bind(APP, traceId).all<Record<string, string>>()).results ?? [];
const incident = async (appId: string, id: string, token: string) =>
  SELF.fetch(`${BASE}/v1/apps/${appId}/incidents/${id}`, json('GET', undefined, token));

/** The data worker's answer to the action's hop, capturing what it was sent. */
function failingDataWorker(fault: string | null, status = 500) {
  const seen: { traceparent: string | null } = { traceparent: null };
  fetchMock.get(`https://pas-data-${APP}.${env.DATA_WORKER_HOST}`)
    .intercept({ path: '/query', method: 'POST' })
    .reply(status, (req) => {
      seen.traceparent = new Headers(req.headers as HeadersInit).get('traceparent');
      return { error: 'internal server error' };
    }, { headers: fault ? { 'X-PAS-Fault': fault } : {} });
  return seen;
}

const counters = async () =>
  Object.fromEntries(((await env.DB.prepare('SELECT signal, SUM(n) AS n FROM app_metric_buckets WHERE app_id = ? GROUP BY signal').bind(APP).all<{ signal: string; n: number }>()).results ?? []).map((r) => [r.signal, r.n]));

beforeEach(async () => {
  await env.DB.prepare('DELETE FROM app_metric_buckets').run();
  mockNetwork();
  resetBurstState();
  await resetTables();
  await env.DB.prepare('DELETE FROM app_worker_invocations').run();
  await seedUser('gh:1'); await seedApp(APP, 'gh:1');
  await seedUser('gh:2'); await seedApp(OTHER, 'gh:2');
  const now = Date.now();
  await env.DB.prepare("INSERT INTO app_tools (app_id, name, manifest, created_at, updated_at, source) VALUES (?, 'list_cases', ?, ?, ?, 'code')")
    .bind(APP, JSON.stringify(listCases), now, now).run();
});
afterEach(() => fetchMock.assertNoPendingInterceptors());

describe('data-worker failures in incident traces (#394)', () => {
  it('an action whose data worker fails: the worker got the trace, the API row names the hop, the owner follows it by id', async () => {
    const token = await session('gh:1');
    const seen = failingDataWorker('platform');
    const res = await viaHostApi(`${BASE}/v1/apps/${APP}/actions/list_cases`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, 'X-PAS-App': APP, traceparent: TRACEPARENT },
      body: '{"params":{}}',
    });
    expect(res.status).toBe(500);
    const body = await res.json() as { traceId: string; errorCode: string; error: string };
    expect(body).toMatchObject({ traceId: TRACE, errorCode: 'internal_error' });
    expect(JSON.stringify(body)).not.toContain('SELECT');

    // The data worker received this trace, with the API's own span as its parent.
    expect(seen.traceparent).toMatch(new RegExp(`^00-${TRACE}-[0-9a-f]{16}-00$`));
    const apiSpan = seen.traceparent!.slice(36, 52);
    expect(apiSpan).not.toBe(CALLER_SPAN);

    const [row] = await eventually(() => rowsFor(TRACE), (r) => r.length === 1);
    expect(row).toMatchObject({ level: 'error', category: 'action', source: 'server' });
    expect(JSON.parse(row!.context!)).toMatchObject({ spanId: apiSpan, parentSpanId: CALLER_SPAN });
    expect(JSON.parse(row!.data!)).toMatchObject({ fault: 'platform', status: 500, authMode: 'platform-cookie' });

    const found = await incident(APP, TRACE, token);
    expect(found.status).toBe(200);
    expect(found.headers.get('Cache-Control')).toContain('no-store');
    const inc = await found.json() as Incident;
    expect(inc).toMatchObject({ traceId: TRACE, hops: { api: 1 }, truncated: false, invocation: null });
    expect(inc.records[0]).toMatchObject({ hop: 'api', level: 'error', data: { fault: 'platform' } });
  });

  it("the app's own SQL failing (tenant fault) is recorded at warn, so it never counts as a platform 5xx", async () => {
    const token = await session('gh:1');
    failingDataWorker('tenant');
    const res = await SELF.fetch(`${BASE}/v1/apps/${APP}/actions/list_cases`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, traceparent: TRACEPARENT }, body: '{"params":{}}',
    });
    expect(res.status).toBe(500);
    const [row] = await eventually(() => rowsFor(TRACE), (r) => r.length === 1);
    expect(row).toMatchObject({ level: 'warn', category: 'action' });
    expect(JSON.parse(row!.data!)).toMatchObject({ fault: 'tenant' });
  });

  it('a data worker deployed before #394 sends no verdict: recorded as unknown, counted as a platform 5xx', async () => {
    const token = await session('gh:1');
    failingDataWorker(null, 503);
    await SELF.fetch(`${BASE}/v1/apps/${APP}/actions/list_cases`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, traceparent: TRACEPARENT }, body: '{"params":{}}',
    });
    const [row] = await eventually(() => rowsFor(TRACE), (r) => r.length === 1);
    expect(row).toMatchObject({ level: 'error' });
    expect(JSON.parse(row!.data!)).toMatchObject({ fault: 'unknown', status: 503 });
    // Counted as a platform 5xx — never as the app's own (tenant) or the caller's (client) fault.
    expect(await eventually(counters, (v) => v.server_5xx === 1)).toEqual({ action_failure: 1, server_5xx: 1 });
    // And the owner's lookup says so: unverdicted, not some other verdict.
    const inc = await (await incident(APP, TRACE, token)).json() as Incident;
    expect(inc.hops).toEqual({ api: 1 });
    expect(inc.records[0]).toMatchObject({ hop: 'api', level: 'error', data: { fault: 'unknown', status: 503 } });
  });

  it('a host-observed failure with no verdict (an edge 522, or a pre-#394 worker) reads unknown in the lookup and counts as a platform 5xx', async () => {
    const token = await session('gh:1');
    const res = await viaHostApi(`${BASE}/v1/internal/data-plane-failures`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-PAS-App': APP, 'X-PAS-Data-Plane-Failure': '1', traceparent: TRACEPARENT },
      body: JSON.stringify({ status: 522, endpoint: 'query' }),
    });
    expect(res.status).toBe(204);
    const inc = await (await incident(APP, TRACE, token)).json() as Incident;
    expect(inc.hops).toEqual({ 'data-worker': 1 });
    expect(inc.records[0]).toMatchObject({ hop: 'data-worker', level: 'error', data: { status: 522, fault: 'unknown', observedBy: 'host' } });
    expect(await counters()).toEqual({ server_5xx: 1 });
  });

  it('without a caller traceparent the API mints one trace and uses it for the hop, the row and the response', async () => {
    const token = await session('gh:1');
    const seen = failingDataWorker('platform');
    const res = await SELF.fetch(`${BASE}/v1/apps/${APP}/actions/list_cases`, json('POST', { params: {} }, token));
    const { traceId } = await res.json() as { traceId: string };
    expect(res.headers.get('X-PAS-Trace-Id')).toBe(traceId);
    expect(seen.traceparent!.slice(3, 35)).toBe(traceId);
    const [row] = await eventually(() => rowsFor(traceId), (r) => r.length === 1);
    expect(JSON.parse(row!.context!)).not.toHaveProperty('parentSpanId');
  });

  it("the host's data-plane report lands as a data-worker hop under the browser's trace", async () => {
    const token = await session('gh:1');
    const res = await viaHostApi(`${BASE}/v1/internal/data-plane-failures`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-PAS-App': APP, 'X-PAS-Data-Plane-Failure': '1', traceparent: TRACEPARENT },
      body: JSON.stringify({ status: 500, fault: 'platform', endpoint: 'query', cfRay: '8f1e2d3c4b5a6978-LHR' }),
    });
    expect(res.status).toBe(204);
    const inc = await (await incident(APP, TRACE, token)).json() as Incident;
    expect(inc.hops).toEqual({ 'data-worker': 1 });
    expect(inc.records[0]).toMatchObject({
      hop: 'data-worker', source: 'server', level: 'error', category: 'db',
      data: { operation: 'db.query', status: 500, fault: 'platform', route: 'platform.data', observedBy: 'host', cfRay: '8f1e2d3c4b5a6978-LHR' },
      context: { parentSpanId: CALLER_SPAN, errorCode: 'internal_error' },
    });
  });

  it('the data-plane intake is HostApi-only: a direct caller with the marker headers is refused and writes nothing', async () => {
    const res = await SELF.fetch(`${BASE}/v1/internal/data-plane-failures`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-PAS-App': APP, 'X-PAS-Data-Plane-Failure': '1', traceparent: TRACEPARENT },
      body: JSON.stringify({ status: 500, fault: 'platform', endpoint: 'query' }),
    });
    expect(res.status).toBe(403);
    expect(await rowsFor(TRACE)).toHaveLength(0);
  });

  it('the data-plane intake records only 5xx', async () => {
    const res = await viaHostApi(`${BASE}/v1/internal/data-plane-failures`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-PAS-App': APP, 'X-PAS-Data-Plane-Failure': '1', traceparent: TRACEPARENT },
      body: JSON.stringify({ status: 403, fault: 'platform', endpoint: 'query' }),
    });
    expect(res.status).toBe(400);
    expect(await rowsFor(TRACE)).toHaveLength(0);
  });

  it("owner A cannot read app B's incident, even by B's trace id", async () => {
    await env.DB.prepare(
      "INSERT INTO app_logs (app_id, ts, level, category, message, trace_id, source, ingested_at) VALUES (?, ?, 'error', 'db', 'b-only', ?, 'server', ?)",
    ).bind(OTHER, Date.now(), TRACE, Date.now()).run();
    const ownerA = await session('gh:1');
    const cross = await incident(OTHER, TRACE, ownerA);
    expect(cross.status).toBeGreaterThanOrEqual(403);
    expect(await cross.text()).not.toContain('b-only');
    // And A's own app under the same id does not reach into B's rows.
    const own = await (await incident(APP, TRACE, ownerA)).json() as Incident;
    expect(own.records).toEqual([]);
    expect((await incident(APP, TRACE, '')).status).toBe(401);
  });

  it('old ids keep working: a #308 invocation id returns its rows and CPU/wall/outcome; a #353 correlation id its row', async () => {
    const token = await session('gh:1');
    const now = Date.now();
    await env.DB.prepare(
      "INSERT INTO app_worker_invocations (id, app_id, event_id, type, attempt, status, started_at, finished_at, child_cpu_ms, child_wall_ms, child_outcome) VALUES ('inv_01HZX', ?, 'evt', 'http', 1, 'succeeded', ?, ?, 12, 34, 'ok')",
    ).bind(APP, now - 50, now).run();
    await env.DB.prepare(
      "INSERT INTO app_logs (app_id, ts, level, category, message, trace_id, source, ingested_at) VALUES (?, ?, 'info', 'worker', 'hi', 'inv_01HZX', 'worker-console', ?)",
    ).bind(APP, now, now).run();
    const inv = await (await incident(APP, 'inv_01HZX', token)).json() as Incident;
    expect(inv.hops).toEqual({ 'app-worker': 1 });
    expect(inv.invocation).toMatchObject({ id: 'inv_01HZX', type: 'http', status: 'succeeded', cpuMs: 12, wallMs: 34, outcome: 'ok' });

    const correlation = 'ef'.repeat(16);
    await env.DB.prepare(
      "INSERT INTO app_logs (app_id, ts, level, category, message, trace_id, source, ingested_at) VALUES (?, ?, 'warn', 'auth.session_lost', 'lost', ?, 'server', ?)",
    ).bind(APP, now, correlation, now).run();
    const lost = await (await incident(APP, correlation.toUpperCase(), token)).json() as Incident;
    expect(lost).toMatchObject({ traceId: correlation, hops: { host: 1 } });
  });

  it('a malformed id is refused rather than searched', async () => {
    const token = await session('gh:1');
    expect((await incident(APP, encodeURIComponent('x y'), token)).status).toBe(400);
    expect((await incident(APP, 'a'.repeat(129), token)).status).toBe(400);
  });

  it('the lookup is bounded: 200 records and a truncation flag', async () => {
    const token = await session('gh:1');
    const now = Date.now();
    const stmt = env.DB.prepare("INSERT INTO app_logs (app_id, ts, level, category, message, trace_id, source, ingested_at) VALUES (?, ?, 'error', 'runtime', 'x', ?, 'direct', ?)");
    await env.DB.batch(Array.from({ length: 201 }, (_, i) => stmt.bind(APP, now + i, TRACE, now)));
    const inc = await (await incident(APP, TRACE, token)).json() as Incident;
    expect(inc.records).toHaveLength(200);
    expect(inc.truncated).toBe(true);
    expect(inc.hops).toEqual({ browser: 200 });
  });

  // #394 x #391: trusted data-worker failures feed the incident counters, by fault, before any detail budget.
  it('host-reported data-plane failures count by fault in the #391 counters; a forged report counts nothing', async () => {
    const report = (fault: string, status = 500, hostApi = true) =>
      (hostApi ? viaHostApi : (u: string, i: RequestInit) => SELF.fetch(u, i))(`${BASE}/v1/internal/data-plane-failures`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-PAS-App': APP, 'X-PAS-Data-Plane-Failure': '1', traceparent: TRACEPARENT },
        body: JSON.stringify({ status, fault, endpoint: 'query' }),
      });
    expect((await report('platform')).status).toBe(204);
    expect((await report('tenant')).status).toBe(204);
    expect((await report('client')).status).toBe(204);
    expect((await report('', 522)).status).toBe(204); // an edge 522 carries no verdict: unknown, a platform 5xx
    expect((await report('platform', 500, false)).status).toBe(403);
    expect(await counters()).toEqual({ server_5xx: 2, tenant_fault: 1, client_fault: 1 });
  });

  it('a data-worker 5xx on an action counts as an action failure, by fault', async () => {
    const token = await session('gh:1');
    failingDataWorker('tenant');
    await SELF.fetch(`${BASE}/v1/apps/${APP}/actions/list_cases`, json('POST', { params: {} }, token));
    const c = await eventually(counters, (v) => v.action_failure === 1);
    expect(c).toEqual({ action_failure: 1, tenant_fault: 1 });
  });
});
