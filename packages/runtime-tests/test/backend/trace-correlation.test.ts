import { SELF, env } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetBurstState } from '../../../backend/src/lib/log-quota';
import { BASE, json, mockNetwork, resetTables, seedApp, seedUser, session, viaHostApi } from './helpers';

// The real SDK, loaded by a computed path: its sources need the DOM lib, which
// this workerd project's typecheck does not have. Only the surface used here is typed.
type ActionError = Error & { action: string; status: number; traceId: string | null; body: Record<string, unknown> | null };
type LogsT = { flushAsync(): Promise<void> };
type SdkModules = {
  Actions: new (appId: string, apiBase: string, auth: unknown, logger?: unknown) => { call(name: string, params?: object): Promise<unknown>; callPublic(name: string): Promise<unknown> };
  ActionError: new (...args: never[]) => ActionError;
  Auth: new (appId: string, apiBase: string, mode: 'legacy-bearer') => object;
  Logs: new (appId: string, apiBase: string, auth: { token: string | null; usesPlatformCookie: boolean }, opts: object) => LogsT;
};
const SDK = '../../../sdk/src/';
const { Actions, ActionError } = await import(/* @vite-ignore */ `${SDK}actions`) as Pick<SdkModules, 'Actions' | 'ActionError'>;
const { Auth } = await import(/* @vite-ignore */ `${SDK}auth`) as Pick<SdkModules, 'Auth'>;
const { Logs } = await import(/* @vite-ignore */ `${SDK}logs`) as Pick<SdkModules, 'Logs'>;

// #390 on real D1 with the real SDK: one failing action leaves a client row and a
// server row under the same trace id, told apart by their spans, with the build
// SHA on the client row and the safe error code on the server row.

const APP = 'trace-demo';
const SHA = 'abc1234def';
const TRACE_RE = /^[0-9a-f]{32}$/;
type Row = { source: string; trace_id: string | null; build_meta: string | null; context: string | null; user_id: string | null };
type Ctx = { spanId?: string; parentSpanId?: string; errorCode?: string; operation?: string; result?: string; sdkVersion?: string; v?: number };

const rowsFor = async (traceId: string) =>
  (await env.DB.prepare('SELECT source, trace_id, build_meta, context, user_id FROM app_logs WHERE app_id = ? AND trace_id = ? ORDER BY source').bind(APP, traceId).all<Row>()).results ?? [];
async function eventually<T>(read: () => Promise<T>, ok: (v: T) => boolean): Promise<T> {
  let v = await read();
  for (let i = 0; i < 50 && !ok(v); i++) { await new Promise((r) => setTimeout(r, 20)); v = await read(); }
  return v;
}
const ctxOf = (r: Row | undefined) => JSON.parse(r?.context ?? 'null') as Ctx;

/** The SDK, signed in in legacy-bearer mode, with its platform fetches answered by this worker. */
async function sdk(uid: string) {
  const token = await session(uid);
  const real = globalThis.fetch;
  vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) =>
    String(input instanceof Request ? input.url : input).startsWith(BASE) ? SELF.fetch(input, init) : real(input, init));
  const auth = new Auth(APP, BASE, 'legacy-bearer');
  (auth as unknown as { session: unknown }).session = { token, user: { id: uid, login: uid.slice(3) } };
  const logs = new Logs(APP, BASE, { token, usesPlatformCookie: false }, { build: { sha: SHA } });
  return { token, logs, actions: new Actions(APP, BASE, auth, logs) };
}

beforeEach(async () => {
  mockNetwork();
  resetBurstState();
  await resetTables();
  await env.DB.prepare('DELETE FROM app_logs').run();
  await env.DB.prepare('DELETE FROM app_log_usage').run();
  await seedUser('gh:1'); await seedApp(APP, 'gh:1');
});
afterEach(() => { vi.unstubAllGlobals(); });

describe('trace correlation (#390)', () => {
  it('one failing action: client and server rows share the trace, with distinct spans, the build SHA and a safe error code', async () => {
    const { logs, actions, token } = await sdk('gh:1');
    const err = await actions.call('no_such_action', { email: 'parent@example.com' }).catch((e) => e) as ActionError;
    expect(err).toBeInstanceOf(ActionError);
    expect(err.traceId).toMatch(TRACE_RE);
    expect(err.body).toMatchObject({ traceId: err.traceId, errorCode: expect.any(String) });
    await logs.flushAsync();

    const rows = await eventually(() => rowsFor(err.traceId!), (r) => r.length === 2);
    expect(rows.map((r) => r.source)).toEqual(['direct', 'server']);
    const [client, server] = rows;
    const c = ctxOf(client);
    const s = ctxOf(server);
    expect(c).toMatchObject({ v: 1, operation: 'action.no_such_action', result: 'error', errorCode: err.body!.errorCode, sdkVersion: expect.any(String) });
    expect(JSON.parse(client!.build_meta!)).toEqual({ sha: SHA });
    expect(s).toMatchObject({ v: 1, operation: 'no_such_action', result: 'error', errorCode: err.body!.errorCode, parentSpanId: c.spanId });
    expect(s.spanId).toMatch(/^[0-9a-f]{16}$/);
    expect(s.spanId).not.toBe(c.spanId);
    expect(JSON.stringify(rows)).not.toContain('parent@example.com');

    // The owner reads both through the trace filter, context included.
    const res = await SELF.fetch(`${BASE}/v1/apps/${APP}/logs?trace_id=${err.traceId}`, json('GET', undefined, token));
    const body = await res.json() as { logs: { source: string; context: Ctx | null }[] };
    expect(body.logs.map((l) => [l.source, l.context?.spanId]).sort()).toEqual([['direct', c.spanId], ['server', s.spanId]].sort());
  });

  it('concurrent calls do not cross-contaminate: each server row matches its own client trace and span', async () => {
    const { logs, actions } = await sdk('gh:1');
    const errs = await Promise.all(['no_a', 'no_b', 'no_c'].map((n) => actions.call(n).catch((e: unknown) => e as ActionError))) as ActionError[];
    await logs.flushAsync();
    expect(new Set(errs.map((e) => e.traceId)).size).toBe(3);
    for (const e of errs) {
      const rows = await eventually(() => rowsFor(e.traceId!), (r) => r.length === 2);
      const [client, server] = rows;
      expect(ctxOf(client).operation).toBe(`action.${e.action}`);
      expect(ctxOf(server)).toMatchObject({ operation: e.action, parentSpanId: ctxOf(client).spanId });
    }
  });

  it('through host mediation (platform-cookie mode) the server row joins the forwarded trace and records the mode', async () => {
    const token = await session('gh:1');
    const traceparent = `00-${'ab'.repeat(16)}-${'cd'.repeat(8)}-01`;
    const res = await viaHostApi(`${BASE}/v1/apps/${APP}/actions/no_such_action`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, 'X-PAS-App': APP, traceparent },
      body: '{"params":{}}',
    });
    expect(((await res.json()) as { traceId: string }).traceId).toBe('ab'.repeat(16));
    const [server] = await eventually(() => rowsFor('ab'.repeat(16)), (r) => r.length === 1);
    expect(ctxOf(server)).toMatchObject({ parentSpanId: 'cd'.repeat(8) });
    expect(JSON.parse((await env.DB.prepare("SELECT data FROM app_logs WHERE trace_id = ?").bind('ab'.repeat(16)).first<{ data: string }>())!.data).authMode).toBe('platform-cookie');
  });

  it('a malformed traceparent is not trusted: the server mints its own trace and records no parent span', async () => {
    const token = await session('gh:1');
    const res = await SELF.fetch(`${BASE}/v1/apps/${APP}/actions/no_such_action`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, traceparent: `00-${'ab'.repeat(16)}-not-a-span-01` }, body: '{"params":{}}',
    });
    const { traceId } = await res.json() as { traceId: string };
    expect(traceId).toMatch(TRACE_RE);
    expect(traceId).not.toBe('ab'.repeat(16));
    expect(res.headers.get('X-PAS-Trace-Id')).toBe(traceId);
    const [server] = await eventually(() => rowsFor(traceId), (r) => r.length === 1);
    expect(ctxOf(server)).not.toHaveProperty('parentSpanId');
  });

  it('a trace header never authorizes: signed out, the call is still refused, the client row is anonymous and no server row is written', async () => {
    const real = globalThis.fetch;
    vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) =>
      String(input instanceof Request ? input.url : input).startsWith(BASE) ? SELF.fetch(input, init) : real(input, init));
    const logs = new Logs(APP, BASE, { token: null, usesPlatformCookie: false }, { build: { sha: SHA } });
    const err = await new Actions(APP, BASE, new Auth(APP, BASE, 'legacy-bearer'), logs).callPublic('no_such_action').catch((e) => e) as ActionError;
    expect(err.status).toBeGreaterThanOrEqual(400);
    expect(err.body).toMatchObject({ traceId: err.traceId });
    await logs.flushAsync();
    const rows = await eventually(() => rowsFor(err.traceId!), (r) => r.length >= 1);
    expect(rows.map((r) => [r.source, r.user_id])).toEqual([['direct', null]]);
  });

  it('#308: a non-W3C invocation id stays queryable by trace_id, and pre-envelope rows read with a null context', async () => {
    const token = await session('gh:1');
    await env.DB.prepare(
      "INSERT INTO app_logs (app_id, user_id, client_id, ts, level, category, message, data, build_meta, fingerprint, trace_id, source, ingested_at) VALUES (?, NULL, NULL, ?, 'info', 'worker', 'hi', NULL, NULL, 'fp', 'inv_01HZX', 'server', ?)",
    ).bind(APP, Date.now(), Date.now()).run();
    const res = await SELF.fetch(`${BASE}/v1/apps/${APP}/logs?trace_id=inv_01HZX`, json('GET', undefined, token));
    expect(((await res.json()) as { logs: { traceId: string; context: unknown }[] }).logs).toEqual([expect.objectContaining({ traceId: 'inv_01HZX', context: null })]);
  });
});
