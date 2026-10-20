import { SELF, fetchMock } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { _resetJwksCache } from '../../../backend/src/lib/github-oidc';
import { resetBurstState } from '../../../backend/src/lib/log-quota';
import { utcDayKey } from '../../../backend/src/lib/day-key';
import { BUCKET_MS, evaluateReliability, evaluationEnd, type OutcomeBucket } from '../../../backend/src/lib/reliability';
import { retryDueDeliveries } from '../../../backend/src/lib/webhook-dispatch';
import { evaluateErrorSpikes } from '../../../backend/src/lib/error-alerts';
import { recordHealth } from '../../../backend/src/lib/metric-aggregates';
import { BASE, json, mockNetwork, session, viaHostApi } from './helpers';
import {
  cleanFixtureApp, counters, E2E_APP_ID as APP, E2E_OTHER_APP_ID as OTHER, E2E_OTHER_USER, E2E_USER,
  env, eventually, ingestLog, oidcToken, seedFixtureApp,
} from './fixtures/e2e-fixture';

/**
 * #396 — the diagnostics conformance suite. One synthetic fixture app per run,
 * driven through the real SDK and the real backend on workerd + D1 + R2:
 *
 *   capture → sanitize → ingest → aggregate → correlate → symbolize → owner query → alert/recovery
 *
 * including deliberately unavailable components. No real app, user or student
 * is touched. Run it with:
 *   pnpm --filter @proappstore/runtime-tests exec vitest run --config vitest.backend.ts test/backend/e2e-conformance.test.ts
 */

type SdkModules = {
  Actions: new (appId: string, apiBase: string, auth: unknown, logger?: unknown) => { call(name: string, params?: object): Promise<unknown> };
  Auth: new (appId: string, apiBase: string, mode: 'legacy-bearer') => object;
  Logs: new (appId: string, apiBase: string, auth: { token: string | null; usesPlatformCookie: boolean }, opts: object) => {
    flushAsync(): Promise<void>;
    captureException(error: unknown, context?: object): void;
    captureReactError(error: unknown, componentStack?: string | null): void;
    capture(level: string, category: string, message: string, data?: unknown, context?: object): void;
    health(): { queued: number; sent: number; dropped: number; quietUntil: number | null };
  };
};
const SDK = '../../../sdk/src/';
const { Actions } = await import(/* @vite-ignore */ `${SDK}actions`) as Pick<SdkModules, 'Actions'>;
const { Auth } = await import(/* @vite-ignore */ `${SDK}auth`) as Pick<SdkModules, 'Auth'>;
const { Logs } = await import(/* @vite-ignore */ `${SDK}logs`) as Pick<SdkModules, 'Logs'>;

const SHA_A = 'a'.repeat(40);
const ASSET = `https://${APP}.proappstore.online/assets/index-abc.js`;
const ISSUER = 'https://token.actions.githubusercontent.com';
// One signing key for the whole file: the JWKS interceptor persists across tests.
const pair = await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']) as CryptoKeyPair;
const priv = pair.privateKey;
const jwk = { ...(await crypto.subtle.exportKey('jwk', pair.publicKey) as JsonWebKey), kid: 'k1', alg: 'RS256', use: 'sig' };

/** The real SDK, signed in as the fixture owner, its platform calls answered by this worker. */
async function sdk(opts: { failTelemetry?: boolean } = {}) {
  const token = await session(E2E_USER);
  const real = globalThis.fetch;
  vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (opts.failTelemetry && url.includes('/logs')) return Promise.reject(new TypeError('Failed to fetch'));
    return url.startsWith(BASE) ? SELF.fetch(input, init) : real(input, init);
  });
  const auth = new Auth(APP, BASE, 'legacy-bearer');
  (auth as unknown as { session: unknown }).session = { token, user: { id: E2E_USER, login: 'diag-synthetic' } };
  const logs = new Logs(APP, BASE, { token, usesPlatformCookie: false }, { build: { sha: SHA_A } });
  return { token, logs, actions: new Actions(APP, BASE, auth, logs) };
}
const owner = () => session(E2E_USER);
const rows = async (where: string, ...binds: unknown[]) =>
  ((await env.DB.prepare(`SELECT level, category, message, data, source, trace_id, context FROM app_logs WHERE app_id = ? AND ${where}`).bind(APP, ...binds).all<Record<string, string>>()).results ?? []);

/** Upload release SHA_A's private source maps keyless, as the canonical deploy does. */
async function uploadMaps(sha = SHA_A): Promise<Response> {
  const bundle = JSON.stringify({ files: { 'assets/index-abc.js': { version: 3, sources: ['src/App.tsx'], names: [], mappings: 'AASI' } } });
  return SELF.fetch(`${BASE}/v1/apps/${APP}/sourcemaps?commitSha=${sha}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${await oidcToken(priv, sha)}` }, body: bundle,
  });
}
async function registerAction(name: string) {
  const tool = { name, description: name, operation: 'query', sql: 'SELECT 1 WHERE :__user_id IS NOT NULL', params: {}, requires_auth: true };
  await env.DB.prepare("INSERT INTO app_tools (app_id, name, manifest, created_at, updated_at, source) VALUES (?, ?, ?, ?, ?, 'code')")
    .bind(APP, name, JSON.stringify(tool), Date.now(), Date.now()).run();
}

beforeEach(async () => {
  mockNetwork();
  resetBurstState();
  _resetJwksCache();
  fetchMock.get(ISSUER).intercept({ path: '/.well-known/jwks' }).reply(200, () => ({ keys: [jwk] })).persist();
  await cleanFixtureApp();
  await seedFixtureApp();
});
afterEach(async () => { vi.unstubAllGlobals(); await cleanFixtureApp(); });

describe('diagnostics conformance (#396)', () => {
  it('1. browser crash: captured, sanitized, ingested, counted, and symbolicated against its own release for the owner', async () => {
    expect((await uploadMaps()).status).toBe(201);
    const { logs } = await sdk();
    const crash = new TypeError('boom for parent@example.com');
    crash.stack = `TypeError: boom\n    at onClick (${ASSET}:1:1)`;
    logs.captureException(crash);
    await logs.flushAsync();

    const [row] = await eventually(() => rows("category = 'exception'"), (r) => r.length === 1);
    expect(row!.message).not.toContain('parent@example.com'); // sanitized at capture
    expect((await counters(APP)).client_error).toBe(1);
    const res = await SELF.fetch(`${BASE}/v1/apps/${APP}/logs?symbolicate=true`, json('GET', undefined, await owner()));
    const [entry] = ((await res.json()) as { logs: { symbolication: { status: string; frames: Record<string, unknown>[] } }[] }).logs;
    expect(entry!.symbolication).toMatchObject({ status: 'ok' });
    expect(entry!.symbolication.frames[0]).toMatchObject({ originalSource: 'src/App.tsx', originalLine: 10, originalCol: 5 });
  });

  it('2. caught React error: one event with its component stack, counted', async () => {
    const { logs } = await sdk();
    logs.captureReactError(new Error('render failed'), '\n    at Board\n    at App');
    await logs.flushAsync();
    const [row] = await eventually(() => rows("level = 'error'"), (r) => r.length === 1);
    expect(JSON.parse(row!.data!)).toMatchObject({ componentStack: expect.stringContaining('at Board') });
    expect((await counters(APP)).client_error).toBe(1);
  });

  it('3. action failure: client and server rows share one trace, counted as an action failure', async () => {
    const { logs, actions } = await sdk();
    const err = await actions.call('no_such_action').catch((e: unknown) => e) as { traceId: string };
    await logs.flushAsync();
    const trace = await eventually(() => rows('trace_id = ?', err.traceId), (r) => r.length === 2);
    expect(trace.map((r) => r.source).sort()).toEqual(['direct', 'server']);
    expect((await counters(APP)).action_failure).toBe(1);
  });

  it('4. auth loss: the host records the session loss server-side; the owner finds it by correlation id', async () => {
    const id = 'd'.repeat(32);
    const res = await viaHostApi(`${BASE}/v1/internal/session-invalidations`, {
      method: 'POST', headers: { 'X-PAS-App': APP, 'X-PAS-Session-Invalidation': 'api_401', 'X-PAS-Session-Invalidation-Id': id },
    });
    expect(res.status).toBe(204);
    const inc = await (await SELF.fetch(`${BASE}/v1/apps/${APP}/incidents/${id}`, json('GET', undefined, await owner()))).json() as { hops: Record<string, number> };
    expect(inc.hops).toEqual({ host: 1 });
  });

  it('5. offline: a failed telemetry upload never fails the app operation, and the loss is explicit', async () => {
    await registerAction('ok_action');
    fetchMock.get(`https://pas-data-${APP}.${env.DATA_WORKER_HOST}`).intercept({ path: '/query', method: 'POST' }).reply(200, { rows: [{ one: 1 }], meta: {} });
    const { logs, actions } = await sdk({ failTelemetry: true });
    logs.capture('error', 'runtime', 'while offline');
    await expect(logs.flushAsync()).resolves.toBeUndefined();
    expect(await actions.call('ok_action')).toMatchObject({ rows: [{ one: 1 }] });
    const h = logs.health();
    expect(h.sent).toBe(0);
    expect(h.queued + h.dropped).toBeGreaterThan(0); // held for retry or counted as dropped — never reported as sent
    expect(await rows('1 = 1')).toEqual([]);
  });

  it('6. room recovery failure: the SDK error entry is ingested and counted', async () => {
    const { logs } = await sdk();
    logs.capture('error', 'room', 'room recovery failed', { outcome: 'still_failing', attempts: 6 });
    await logs.flushAsync();
    const [row] = await eventually(() => rows("category = 'room'"), (r) => r.length === 1);
    expect(JSON.parse(row!.data!)).toMatchObject({ outcome: 'still_failing' });
    expect((await counters(APP)).client_error).toBe(1);
  });

  it('7. data-worker 5xx: recorded by the API and the host, counted as a platform 5xx, followed by trace', async () => {
    await registerAction('db_action');
    fetchMock.get(`https://pas-data-${APP}.${env.DATA_WORKER_HOST}`).intercept({ path: '/query', method: 'POST' })
      .reply(500, { error: 'internal server error' }, { headers: { 'X-PAS-Fault': 'platform' } });
    const res = await SELF.fetch(`${BASE}/v1/apps/${APP}/actions/db_action`, json('POST', { params: {} }, await owner()));
    const { traceId } = await res.json() as { traceId: string };
    await viaHostApi(`${BASE}/v1/internal/data-plane-failures`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-PAS-App': APP, 'X-PAS-Data-Plane-Failure': '1', traceparent: `00-${traceId}-${'cd'.repeat(8)}-01` },
      body: JSON.stringify({ status: 522, fault: null, endpoint: 'query' }),
    });
    const c = await eventually(() => counters(APP), (v) => v.server_5xx === 2);
    expect(c).toMatchObject({ server_5xx: 2, action_failure: 1 });
    const inc = await (await SELF.fetch(`${BASE}/v1/apps/${APP}/incidents/${traceId}`, json('GET', undefined, await owner()))).json() as { hops: Record<string, number> };
    expect(inc.hops).toEqual({ api: 1, 'data-worker': 1 });
  });

  it('8. quota exhaustion: detail stops, the count and the drop are explicit, and health is not called healthy', async () => {
    await env.DB.prepare('INSERT INTO app_log_usage (app_id, day, count) VALUES (?, ?, 50000)').bind(APP, utcDayKey(Date.now())).run();
    const res = await ingestLog(APP, [{ level: 'error', category: 'runtime', message: 'x', ts: Date.now() }]);
    expect(res.status).toBe(202);
    expect(await res.json()).toMatchObject({ ingested: 0, throttled: 'daily_quota' });
    expect(await counters(APP)).toEqual({ client_error: 1, detail_dropped_client: 1 });
    const h = await (await SELF.fetch(`${BASE}/v1/apps/${APP}/telemetry/health`, json('GET', undefined, await owner()))).json() as { status: string; windows: { lastHour: { detailDropped: { client: number } } } };
    expect(h.windows.lastHour.detailDropped.client).toBe(1);
    expect(h.status).not.toBe('ok');
  });

  it('9. map mismatch: altered release bytes are reported as mismatched, never symbolicated against another release', async () => {
    expect((await uploadMaps()).status).toBe(201);
    await env.STORAGE.put(`_sourcemaps/${APP}/${SHA_A}/bundle.json`, '{"files":{}}');
    const res = await SELF.fetch(`${BASE}/v1/apps/${APP}/sourcemaps/${SHA_A}/symbolicate`, json('POST', { frames: [{ source: ASSET, line: 1, col: 1 }] }, await owner()));
    expect(await res.json()).toMatchObject({ status: 'mismatched', frames: [{ unresolved: true }] });
  });

  it('10. alert delivery failure and recovery: one incident, a failed then retried delivery, one recovery', async () => {
    const NOW = 1_800_000_000_000 + 7 * BUCKET_MS + 60_000;
    const END = evaluationEnd(NOW);
    const series = (bad: (i: number) => number): OutcomeBucket[] =>
      Array.from({ length: 72 }, (_, i) => ({ app: APP, family: 'actions', start: END - (72 - i) * BUCKET_MS, total: 50, bad: bad(i) }));
    await env.DB.prepare("INSERT INTO app_reliability_objectives (app_id, family, target, enabled, updated_at) VALUES (?, 'actions', 0.99, 1, 1)").bind(APP).run();
    await env.DB.prepare("INSERT INTO app_webhooks (id, app_id, event, url, secret, created_at) VALUES ('diag-wh', ?, 'app.alert', 'https://hooks.example/diag', 'synthetic', 1)").bind(APP).run();
    const hook = fetchMock.get('https://hooks.example');
    hook.intercept({ path: '/diag', method: 'POST' }).reply(503, 'down');
    await evaluateReliability({ env, now: NOW, read: async () => series((i) => (i >= 68 ? 30 : 0)) });
    await evaluateReliability({ env, now: NOW + 60_000, read: async () => series((i) => (i >= 68 ? 30 : 0)) });

    const deliveries = async () => ((await SELF.fetch(`${BASE}/v1/apps/${APP}/reliability/deliveries`, json('GET', undefined, await owner()))).json()) as Promise<{ deliveries: Record<string, unknown>[] }>;
    let [d] = (await deliveries()).deliveries;
    expect(d).toMatchObject({ status: 503, attempts: 1, last_error: 'HTTP 503' });
    hook.intercept({ path: '/diag', method: 'POST' }).reply(200, 'ok');
    expect(await retryDueDeliveries(env.DB, Number(d!.next_attempt_at) * 1000)).toBe(1);
    [d] = (await deliveries()).deliveries;
    expect(d).toMatchObject({ status: 200, attempts: 2, next_attempt_at: null });

    hook.intercept({ path: '/diag', method: 'POST' }).reply(200, 'ok');
    await evaluateReliability({ env, now: NOW + 120_000, read: async () => series(() => 0) });
    const inc = await (await SELF.fetch(`${BASE}/v1/apps/${APP}/reliability/incidents`, json('GET', undefined, await owner()))).json() as { incidents: { rule: string; state: string }[] };
    expect(inc.incidents.map((i) => [i.rule, i.state])).toEqual([['burn_fast:actions', 'recovered']]);
  });

  it('11. owner query: filters work, and another app never sees this app — not even with the same trace id', async () => {
    const trace = 'ab'.repeat(16);
    await ingestLog(APP, [{ level: 'error', category: 'runtime', message: 'mine', ts: Date.now(), traceId: trace }]);
    await ingestLog(OTHER, [{ level: 'error', category: 'runtime', message: 'theirs', ts: Date.now(), traceId: trace }]);
    const mine = await (await SELF.fetch(`${BASE}/v1/apps/${APP}/logs?level=error&trace_id=${trace}&since=0`, json('GET', undefined, await owner()))).json() as { logs: { message: string }[] };
    expect(mine.logs.map((l) => l.message)).toEqual(['mine']);
    const inc = await (await SELF.fetch(`${BASE}/v1/apps/${APP}/incidents/${trace}`, json('GET', undefined, await owner()))).text();
    expect(inc).not.toContain('theirs');
    for (const path of ['logs', `incidents/${trace}`, 'telemetry/health', 'reliability/incidents', 'reliability/deliveries']) {
      expect((await SELF.fetch(`${BASE}/v1/apps/${APP}/${path}`, json('GET', undefined, await session(E2E_OTHER_USER)))).status, path).toBeGreaterThanOrEqual(403);
    }
  });

  it('12. evaluator outage: incidents are still counted, and alert coverage for the gap is explicitly incomplete (#389, #391)', async () => {
    // The evaluator's cursor and health row are platform-wide; this scenario owns them for its duration.
    await env.DB.prepare('DELETE FROM alert_evaluator_cursor').run();
    await env.DB.prepare("DELETE FROM telemetry_health WHERE component = 'evaluator' AND app_id = ''").run();
    try {
      const FIVE = 5 * 60_000;
      const before = Math.floor((Date.now() - 3 * 60 * 60_000) / FIVE) * FIVE;
      const after = Math.floor((Date.now() - 60 * 60_000) / FIVE) * FIVE;
      await evaluateErrorSpikes({ env, now: before, scheduled: true });
      // Two hours without a scheduled run, then one: the range it can no longer catch up is recorded.
      expect((await evaluateErrorSpikes({ env, now: after, scheduled: true })).gap).toEqual({ start: before, end: after - 30 * 60_000 });
      await recordHealth(env.DB, 'evaluator', '', true, null);
      // Capture keeps counting whatever the evaluator did.
      expect((await ingestLog(APP, [{ level: 'error', category: 'runtime', message: 'during-recovery', ts: Date.now() }])).status).toBeLessThan(300);
      const h = await (await SELF.fetch(`${BASE}/v1/apps/${APP}/telemetry/health`, json('GET', undefined, await owner()))).json() as {
        countsReliable: boolean;
        components: { evaluator: { status: string; lastError: string | null } };
        alertCoverage: { complete: boolean; gap: { start: number; end: number } | null };
        windows: { lastHour: { signals: Record<string, number> } };
      };
      expect(h.components.evaluator).toMatchObject({ status: 'ok', lastError: 'gap' });
      expect(h.countsReliable).toBe(true);
      expect(h.windows.lastHour.signals.client_error).toBeGreaterThanOrEqual(1);
      expect(h.alertCoverage).toMatchObject({ complete: false, gap: { start: before, end: after - 30 * 60_000 } });
    } finally {
      // Leave the platform rows as found: later scenarios rely on an evaluator that has not run.
      await env.DB.prepare('DELETE FROM alert_evaluator_cursor').run();
      await env.DB.prepare("DELETE FROM telemetry_health WHERE component = 'evaluator' AND app_id = ''").run();
    }
  });

  it('unavailable components are explicit: Analytics Engine down opens monitoring_degraded; a missing map is missing', async () => {
    await env.DB.prepare("INSERT INTO app_reliability_objectives (app_id, family, target, enabled, updated_at) VALUES (?, 'actions', 0.99, 1, 1)").bind(APP).run();
    await evaluateReliability({ env, read: async () => { throw new Error('CF Analytics SQL failed (503)'); } });
    const open = (await env.DB.prepare("SELECT rule FROM app_incidents WHERE app_id = ? AND state != 'recovered'").bind(APP).all<{ rule: string }>()).results;
    expect(open).toEqual([{ rule: 'monitoring_degraded' }]);
    const res = await SELF.fetch(`${BASE}/v1/apps/${APP}/sourcemaps/${'f'.repeat(40)}/symbolicate`, json('POST', { frames: [{ source: ASSET, line: 1, col: 1 }] }, await owner()));
    expect(await res.json()).toMatchObject({ status: 'missing' });
    const health = await (await SELF.fetch(`${BASE}/v1/apps/${APP}/telemetry/health`, json('GET', undefined, await owner()))).json() as { countsReliable: boolean; requests: { status: string } };
    expect(health).toMatchObject({ countsReliable: false, requests: { status: 'unknown' } });
  });
});
