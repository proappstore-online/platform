import { SELF, env as providedEnv, fetchMock } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Env } from '../../../backend/src/types';
import { runScheduledActions } from '../../../backend/src/lib/scheduled-actions';
import { appWorkerHost, disableAppWorker } from '../../../backend/src/lib/app-worker-host';
import { sealSecret } from '../../../backend/src/lib/encryption';
import { BASE, json, mockNetwork, resetTables, seedApp, seedUser, session } from './helpers';

const env = providedEnv as unknown as Env;

// #275 on real D1, R2 and the Worker Loader: every invocation type is metered in
// app_worker_usage and gated by the same daily quota before invoke — a schedule
// over quota fails `quota exceeded`, a hook is recorded `quota_exceeded` with a
// 202 and no invocation, a browser request gets 429 + Retry-After — plus the 80 %
// alert and the APP_WORKER_OPEN flag on new enables.

const GH_SECRET = 'gh-hook-secret';
const enc = new TextEncoder();
const APP = `export default { async fetch(req) {
  const e = await req.json();
  if (e.type === 'http') return Response.json({ v: 1, status: 200, headers: { 'content-type': 'text/plain' }, body: 'ok', body_encoding: 'utf8' });
  return Response.json({ ok: true });
} };`;
const tool = {
  name: 'add_row', description: 'Worker write', operation: 'execute', requires_auth: true,
  sql: 'INSERT INTO rows (id) VALUES (:id)', params: { id: { type: 'string' } },
  auth: { caller_unscoped: { reason: 'the worker writes every row' } }, callers: ['worker'],
};
const TICK = Date.UTC(2026, 9, 6, 10, 10);
const admin = () => session('gh:admin', { roles: ['user', 'admin'] });

async function hmacHex(secret: string, data: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return [...new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(data)))].map((b) => b.toString(16).padStart(2, '0')).join('');
}
async function github(delivery: string, body = '{"zen":"ok"}') {
  return SELF.fetch(`${BASE}/v1/apps/t/hooks/github`, {
    method: 'POST', body,
    headers: { 'content-type': 'application/json', 'x-github-event': 'push', 'x-github-delivery': delivery, 'x-hub-signature-256': `sha256=${await hmacHex(GH_SECRET, body)}` },
  });
}
const deliveryRow = (id: string) => env.DB.prepare('SELECT id, status, attempts, error FROM app_hook_deliveries WHERE delivery_id = ?').bind(id).first<{ id: string; status: string; attempts: number; error: string | null }>();
async function settled(id: string) {
  for (let i = 0; i < 100; i++) {
    const row = await deliveryRow(id);
    if (row && row.status !== 'received') return row;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`delivery ${id} never finished`);
}
async function viaHost(path = '/v1/ping') {
  return SELF.fetch(`${BASE}/v1/apps/t/worker/http`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${await session('gh:42')}`, 'X-PAS-App': 't', 'X-PAS-Worker-Method': 'GET', 'X-PAS-Worker-Path': path },
  });
}
async function usage() {
  const res = await SELF.fetch(`${BASE}/v1/apps/t/worker/usage`, json('GET', undefined, await session('gh:admin')));
  expect(res.status).toBe(200);
  return res.json() as Promise<{ quotas: Record<string, number>; cpu_ms_source: string; today: Record<string, number> }>;
}
const setQuotas = async (body: unknown) => SELF.fetch(`${BASE}/v1/admin/apps/t/worker-quotas`, json('PUT', body, await admin()));
const invocationCount = async () => (await env.DB.prepare("SELECT COUNT(*) AS n FROM app_worker_invocations WHERE app_id = 't'").first<{ n: number }>())!.n;

beforeEach(async () => {
  mockNetwork();
  for (const r of (await env.DB.prepare('SELECT app_id FROM app_workers').all<{ app_id: string }>()).results ?? []) await disableAppWorker(env, r.app_id);
  await resetTables();
  for (const t of ['app_hooks', 'app_hook_deliveries', 'app_secrets', 'app_worker_invocations', 'app_worker_usage', 'app_worker_schedules', 'app_alerts',
    'scheduled_action_runs', 'scheduled_action_state']) await env.DB.prepare(`DELETE FROM ${t}`).run();
  await env.DB.prepare('UPDATE app_worker_platform SET open = 1, closed_reason = NULL, closed_at = NULL').run();
  await env.DB.prepare('UPDATE app_workers SET quota_overrides = NULL').run();
  await seedUser('gh:admin', 'admin');
  await seedUser('gh:42', 'user42');
  await seedApp('t', 'gh:admin');
  const s = await sealSecret(GH_SECRET, env.APP_SECRET_KEK!);
  await env.DB.prepare("INSERT INTO app_secrets (app_id, name, key_ciphertext, dek_wrapped, iv, created_at) VALUES ('t', 'GITHUB_WEBHOOK_SECRET', ?, ?, ?, ?)").bind(s.keyCiphertext, s.dekWrapped, s.iv, Date.now()).run();
  expect((await SELF.fetch(`${BASE}/v1/admin/apps/t/worker-enabled`, json('PUT', { enabled: true }, await admin()))).status).toBe(200);
  await appWorkerHost(env).deploy('t', { modules: { 'app.js': APP } });
  fetchMock.get(`https://pas-data-t.${env.DATA_WORKER_HOST}`).intercept({ path: '/validate', method: 'POST' })
    .reply(200, (req) => ({ results: (JSON.parse(String(req.body)) as { statements: { id: string }[] }).statements.map((st) => ({ id: st.id, ok: true })) }));
  const put = await SELF.fetch(`${BASE}/v1/apps/t/tools`, json('PUT', {
    tools: [tool],
    worker: { schedules: [{ name: 'tick', cron: '*/5 * * * *', params: {} }] },
    hooks: [{ name: 'github', verify: { kind: 'github-hmac-sha256', secret: 'GITHUB_WEBHOOK_SECRET' }, to: 'worker' }],
  }, await session('gh:admin')));
  expect(put.status, await put.clone().text()).toBe(200);
});
afterEach(async () => {
  fetchMock.assertNoPendingInterceptors();
  await env.DB.prepare('DELETE FROM app_worker_schedules').run();
});

describe('metering (#275)', () => {
  it('counts every invocation type — http included — and labels cpu_ms as wall-clock', async () => {
    for (let i = 0; i < 2; i++) expect((await viaHost()).status).toBe(200);
    await github('m-1');
    await settled('m-1');
    expect((await runScheduledActions({ env, now: TICK })).workers).toMatchObject({ succeeded: 1 });
    const u = await usage();
    expect(u.today).toMatchObject({ invocations: 4, hook_deliveries: 1 });
    expect(u.today.cpu_ms).toBeGreaterThanOrEqual(0);
    expect(u.cpu_ms_source).toBe('wall');
    expect(u.quotas.invocations).toBe(5000);
    expect((await SELF.fetch(`${BASE}/v1/apps/t/worker/usage`, json('GET', undefined, await session('gh:42')))).status).toBe(403);
  });
});

describe('the daily invocation quota (#275)', () => {
  it('with invocations 3: the 4th http request is 429 + Retry-After, a schedule fails, a hook is recorded quota_exceeded with a 202 and no invocation', async () => {
    expect((await setQuotas({ invocations: 3 })).status).toBe(200);
    for (let i = 0; i < 3; i++) expect((await viaHost()).status).toBe(200);

    const refused = await viaHost();
    expect(refused.status).toBe(429);
    expect(Number(refused.headers.get('retry-after'))).toBeGreaterThan(0);
    expect(await refused.json()).toEqual({ error: 'quota exceeded', quota: 'invocations' });

    const report = await runScheduledActions({ env, now: TICK });
    expect(report.workers).toMatchObject({ claimed: 1, failed: 1 });
    expect(await env.DB.prepare("SELECT status, error FROM scheduled_action_runs WHERE action_name = 'worker:tick'").first()).toEqual({ status: 'failed', error: 'quota exceeded' });

    const before = await invocationCount();
    const hook = await github('q-1');
    expect(hook.status).toBe(202);
    expect(await settled('q-1')).toMatchObject({ status: 'quota_exceeded', error: expect.stringContaining('redeliver') });
    expect(await invocationCount()).toBe(before);

    // The next UTC day (today's row gone): the sender redelivers the same delivery and it runs.
    await env.DB.prepare("DELETE FROM app_worker_usage WHERE app_id = 't'").run();
    expect((await github('q-1')).status).toBe(202);
    expect(await settled('q-1')).toMatchObject({ status: 'delivered', attempts: 2 });
  });

  it('with hook_deliveries 1: the 2nd delivery is quota_exceeded at once, before any delivery runs', async () => {
    expect((await setQuotas({ hook_deliveries: 1 })).status).toBe(200);
    await github('h-1');
    expect(await settled('h-1')).toMatchObject({ status: 'delivered' });
    const res = await github('h-2');
    expect(res.status).toBe(202);
    expect(await res.json()).toMatchObject({ processed: false });
    expect(await deliveryRow('h-2')).toMatchObject({ status: 'quota_exceeded', error: expect.stringContaining('hook_deliveries') });
  });

  it('80 % of a quota raises exactly one app_alerts row that day', async () => {
    expect((await setQuotas({ invocations: 5 })).status).toBe(200);
    for (let i = 0; i < 6; i++) await viaHost();
    expect((await env.DB.prepare("SELECT kind, count, baseline FROM app_alerts WHERE app_id = 't'").all()).results).toEqual([{ kind: 'app_worker_quota', count: 4, baseline: 5 }]);
  });

  it('only an admin sets overrides; null clears them', async () => {
    expect((await SELF.fetch(`${BASE}/v1/admin/apps/t/worker-quotas`, json('PUT', { invocations: 3 }, await session('gh:42')))).status).toBe(403);
    expect((await setQuotas({ invocations: -1 })).status).toBe(400);
    expect((await setQuotas({ invocations: 3 })).status).toBe(200);
    expect((await usage()).quotas.invocations).toBe(3);
    expect((await setQuotas(null)).status).toBe(200);
    expect((await usage()).quotas.invocations).toBe(5000);
  });
});

describe('APP_WORKER_OPEN (#275)', () => {
  it('closed: a new enable is 409 while an enabled app\'s schedule still runs; an admin reopens it', async () => {
    await seedApp('second', 'gh:admin');
    expect((await SELF.fetch(`${BASE}/v1/admin/app-workers/open`, json('PUT', { open: false }, await admin()))).status).toBe(200);
    const refused = await SELF.fetch(`${BASE}/v1/admin/apps/second/worker-enabled`, json('PUT', { enabled: true }, await admin()));
    expect(refused.status).toBe(409);
    expect(await refused.json()).toMatchObject({ error: 'app workers are closed to new apps (account ceiling)' });
    // Re-enabling an app that is already enabled is not a new enable.
    expect((await SELF.fetch(`${BASE}/v1/admin/apps/t/worker-enabled`, json('PUT', { enabled: true }, await admin()))).status).toBe(200);
    expect((await runScheduledActions({ env, now: TICK })).workers).toMatchObject({ succeeded: 1 });

    expect((await SELF.fetch(`${BASE}/v1/admin/app-workers/open`, json('PUT', { open: true }, await session('gh:42')))).status).toBe(403);
    expect((await SELF.fetch(`${BASE}/v1/admin/app-workers/open`, json('PUT', { open: true }, await admin()))).status).toBe(200);
    expect((await SELF.fetch(`${BASE}/v1/admin/apps/second/worker-enabled`, json('PUT', { enabled: true }, await admin()))).status).toBe(200);
  });
});
