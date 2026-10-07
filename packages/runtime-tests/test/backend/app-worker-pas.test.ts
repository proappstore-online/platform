import { SELF, env as providedEnv, fetchMock } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Env } from '../../../backend/src/types';
import { AppWorkerApi } from '../../../backend/src/rpc/app-worker-api';
import { MAX_PAS_CALLS_PER_INVOCATION, SYSTEM_WORKER_USER } from '../../../backend/src/lib/app-worker-calls';
import { disableAppWorker } from '../../../backend/src/lib/app-worker-host';
import { sha256Hex } from '../../../backend/src/lib/app-tokens';
import { sealSecret } from '../../../backend/src/lib/encryption';
import { BASE, json, mockNetwork, resetTables, seedApp, seedUser, session } from './helpers';

const env = providedEnv as unknown as Env;

// #254 on real D1 and R2: the PAS RPC surface (AppWorkerApi, constructed with the
// props the loader sets), its token + invocation authorisation, the atomic call
// budget, `callers`, actions as system:worker, secrets, worker storage and logs.
// Only the app's data worker is intercepted.
//
//   app `t` and app `u` belong to gh:admin; t's worker token is TOKEN, u's is U_TOKEN.

const TOKEN = 'a'.repeat(64);
const U_TOKEN = 'b'.repeat(64);
const INVOCATION = 'evt-1:1';
let queried: { path: string; body: { sql?: string; params?: unknown[]; statements?: unknown[] } }[] = [];

const tools = [
  {
    name: 'add_row', description: 'Worker write', operation: 'execute', requires_auth: true,
    sql: 'INSERT INTO rows (id, by) VALUES (:id, :__user_id)', params: { id: { type: 'string' } },
    auth: { caller_unscoped: { reason: 'the worker writes every row' } }, callers: ['worker'],
  },
  {
    name: 'my_rows', description: 'User read', operation: 'query', requires_auth: true,
    sql: 'SELECT id FROM rows WHERE by = :__user_id LIMIT 10', params: {},
  },
];

const dataWorker = (appId = 't') => fetchMock.get(`https://pas-data-${appId}.${env.DATA_WORKER_HOST}`);
function answers(path: '/execute' | '/batch', reply: (body: { statements?: unknown[] }) => unknown, times = 1) {
  dataWorker().intercept({ path, method: 'POST' }).reply(200, (req) => {
    const body = JSON.parse(String(req.body));
    queried.push({ path, body });
    return reply(body);
  }).times(times);
}
async function seedWorker(appId: string, token: string, opts: { enabled?: number } = {}) {
  await env.DB.prepare(
    `INSERT INTO app_workers (app_id, enabled, backend, token_hash, deployed_at, config_version) VALUES (?, ?, 'loader', ?, ?, 1)
     ON CONFLICT(app_id) DO UPDATE SET enabled = excluded.enabled, token_hash = excluded.token_hash, deployed_at = excluded.deployed_at`,
  ).bind(appId, opts.enabled ?? 1, await sha256Hex(token), Date.now()).run();
}
const invocation = (id = INVOCATION, appId = 't', status = 'running') => env.DB.prepare(
  "INSERT OR REPLACE INTO app_worker_invocations (id, app_id, event_id, type, attempt, status, pas_calls, started_at) VALUES (?, ?, ?, 'schedule', 1, ?, 0, ?)",
).bind(id, appId, id.split(':')[0], status, Date.now()).run();
const pas = (props: unknown) => new AppWorkerApi({ props } as never, env);
const ctx = (over: Record<string, unknown> = {}) => ({ token: TOKEN, invocation: INVOCATION, ...over });

beforeEach(async () => {
  mockNetwork();
  queried = [];
  for (const r of (await env.DB.prepare('SELECT app_id FROM app_workers').all<{ app_id: string }>()).results ?? []) await disableAppWorker(env, r.app_id);
  await resetTables();
  for (const t of ['app_worker_invocations', 'app_worker_manifest', 'app_secrets', 'app_log_usage']) await env.DB.prepare(`DELETE FROM ${t}`).run();
  await seedUser('gh:admin', 'admin');
  await seedApp('t', 'gh:admin');
  await seedApp('u', 'gh:admin');
  dataWorker().intercept({ path: '/validate', method: 'POST' })
    .reply(200, (req) => ({ results: (JSON.parse(String(req.body)) as { statements: { id: string }[] }).statements.map((s) => ({ id: s.id, ok: true })) }));
  const put = await SELF.fetch(`${BASE}/v1/apps/t/tools`, json('PUT', { tools, worker: { secrets: ['GITHUB_TOKEN'] } }, await session('gh:admin')));
  expect(put.status, await put.clone().text()).toBe(200);
  await seedWorker('t', TOKEN);
  await seedWorker('u', U_TOKEN);
  await invocation();
});
afterEach(async () => {
  fetchMock.assertNoPendingInterceptors();
  const keys = (await env.STORAGE.list({ prefix: 't/' })).objects.map((o) => o.key);
  if (keys.length) await env.STORAGE.delete(keys);
});

describe('PAS actions as system:worker (#254)', () => {
  it('actions.call runs a worker action on the data worker with :__user_id = system:worker', async () => {
    answers('/execute', () => ({ meta: { changes: 1 } }));
    expect(await pas({ appId: 't' }).actions.call('add_row', { id: 'r1' }, ctx())).toMatchObject({ meta: { changes: 1 } });
    expect(queried[0]!.body).toEqual({ sql: 'INSERT INTO rows (id, by) VALUES (?, ?)', params: ['r1', SYSTEM_WORKER_USER] });
  });

  it('a worker-only action is refused over HTTP with a valid session; a default action is refused to the worker', async () => {
    const http = await SELF.fetch(`${BASE}/v1/apps/t/actions/add_row`, json('POST', { params: { id: 'x' } }, await session('gh:admin')));
    expect(http.status).toBe(403);
    expect(await http.text()).toContain("this action runs only from the app's worker/hooks");
    await expect(pas({ appId: 't' }).actions.call('my_rows', {}, ctx())).rejects.toThrow(/^Forbidden:/);
  });

  it('actions.batch: 500 statements in one /batch counted as one call; 501 refused before any SQL', async () => {
    const calls = (n: number) => Array.from({ length: n }, (_, i) => ({ name: 'add_row', params: { id: `r${i}` } }));
    await expect(pas({ appId: 't' }).actions.batch(calls(501), ctx())).rejects.toThrow(/^BadRequest: a batch runs at most 500/);
    expect(queried).toHaveLength(0);
    answers('/batch', (b) => ({ results: (b.statements ?? []).map(() => ({ rows: [], meta: { changes: 1 } })) }));
    const out = await pas({ appId: 't' }).actions.batch(calls(500), ctx());
    expect(out).toHaveLength(500);
    expect(queried).toHaveLength(1);
    expect(queried[0]!.body.statements).toHaveLength(500);
    expect((await env.DB.prepare('SELECT pas_calls FROM app_worker_invocations WHERE id = ?').bind(INVOCATION).first<{ pas_calls: number }>())?.pas_calls).toBe(2);
  });
});

describe('PAS -> data worker hop through SELF (#310)', () => {
  const hop = (path: string, headers: Record<string, string>) => SELF.fetch(`${BASE}/v1/internal/data-worker/${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: '{}' });

  it('the internal hop route refuses a missing or wrong internal token and any endpoint but query/execute/batch', async () => {
    expect((await hop('t/execute', {})).status).toBe(403);
    expect((await hop('t/execute', { 'X-Internal-Token': 'wrong' })).status).toBe(403);
    expect((await hop('t/tables', { 'X-Internal-Token': env.INTERNAL_TOKEN! })).status).toBe(404);
  });
});

describe('PAS authorisation, every call (#254)', () => {
  it('refuses a wrong token, a disabled worker, another app\'s token, no props and no running invocation', async () => {
    const refused = (p: Promise<unknown>) => expect(p).rejects.toThrow(/^Unauthorized:/);
    await refused(pas({ appId: 't' }).log('info', 'x', undefined, ctx({ token: 'c'.repeat(64) })));
    await refused(pas({ appId: 't' }).log('info', 'x', undefined, ctx({ token: U_TOKEN })));
    await refused(pas(undefined).log('info', 'x', undefined, ctx()));
    await refused(pas({ appId: 't' }).log('info', 'x', undefined, ctx({ invocation: 'nope:1' })));
    await invocation('done:1', 't', 'succeeded');
    await refused(pas({ appId: 't' }).log('info', 'x', undefined, ctx({ invocation: 'done:1' })));
    await env.DB.prepare("UPDATE app_workers SET enabled = 0 WHERE app_id = 't'").run();
    await refused(pas({ appId: 't' }).log('info', 'x', undefined, ctx()));
    // None of them spent the invocation's budget.
    expect((await env.DB.prepare('SELECT pas_calls FROM app_worker_invocations WHERE id = ?').bind(INVOCATION).first<{ pas_calls: number }>())?.pas_calls).toBe(0);
  });

  it(`the budget is ${MAX_PAS_CALLS_PER_INVOCATION} calls per invocation across isolates (two stubs, concurrent)`, async () => {
    const a = pas({ appId: 't' });
    const b = pas({ appId: 't' });
    const outcomes = await Promise.allSettled(Array.from({ length: 250 }, (_, i) => (i % 2 ? a : b).storage.get('none.json', ctx())));
    expect(outcomes.filter((o) => o.status === 'fulfilled')).toHaveLength(MAX_PAS_CALLS_PER_INVOCATION);
    const rejected = outcomes.filter((o): o is PromiseRejectedResult => o.status === 'rejected');
    expect(rejected).toHaveLength(50);
    expect(rejected.every((r) => /^TooManyCalls:/.test(String(r.reason?.message)))).toBe(true);
    expect((await env.DB.prepare('SELECT pas_calls FROM app_worker_invocations WHERE id = ?').bind(INVOCATION).first<{ pas_calls: number }>())?.pas_calls).toBe(MAX_PAS_CALLS_PER_INVOCATION);
  });
});

describe('PAS secrets, storage and log (#254)', () => {
  it('secrets.get returns a declared secret and null for an undeclared one', async () => {
    const sealed = await sealSecret('ghp_live', env.APP_SECRET_KEK!);
    for (const [name, value] of [['GITHUB_TOKEN', sealed], ['STRIPE_KEY', sealed]] as const) {
      await env.DB.prepare('INSERT INTO app_secrets (app_id, name, key_ciphertext, dek_wrapped, iv, created_at) VALUES (?, ?, ?, ?, ?, ?)')
        .bind('t', name, value.keyCiphertext, value.dekWrapped, value.iv, Date.now()).run();
    }
    expect(await pas({ appId: 't' }).secrets.get('GITHUB_TOKEN', ctx())).toBe('ghp_live');
    expect(await pas({ appId: 't' }).secrets.get('STRIPE_KEY', ctx())).toBeNull();
  });

  it('storage.put lands under t/_worker/ and never in the owner\'s own file list', async () => {
    expect(await pas({ appId: 't' }).storage.put('a.json', '{"n":1}', { contentType: 'application/json' }, ctx())).toEqual({ key: 'a.json', size: 7 });
    expect(await env.STORAGE.head('t/_worker/a.json')).not.toBeNull();
    const listing = await SELF.fetch(`${BASE}/v1/apps/t/files`, json('GET', undefined, await session('gh:admin')));
    expect(listing.status).toBe(200);
    expect((await listing.json() as { files: unknown[] }).files).toEqual([]);
    const got = await pas({ appId: 't' }).storage.get('a.json', ctx());
    expect(new TextDecoder().decode(got!.body)).toBe('{"n":1}');
  });

  it('log appends to app_logs as system:worker, category worker', async () => {
    expect(await pas({ appId: 't' }).log('warn', 'reconcile slow', { ms: 900 }, ctx())).toBe(true);
    const row = await env.DB.prepare("SELECT user_id, level, category, message, source FROM app_logs WHERE app_id = 't' ORDER BY id DESC LIMIT 1").first();
    expect(row).toEqual({ user_id: SYSTEM_WORKER_USER, level: 'warn', category: 'worker', message: 'reconcile slow', source: 'worker' });
  });
});
