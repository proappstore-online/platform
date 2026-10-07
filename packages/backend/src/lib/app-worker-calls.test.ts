import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  MAX_BATCH_STATEMENTS, MAX_PAS_CALLS_PER_INVOCATION, SYSTEM_WORKER_USER, WorkerCallError,
  authorizeWorkerCall, workerActionBatch, workerActionCall, workerLog, workerSecretGet, workerStorageGet,
  workerStorageKey, workerStoragePut,
} from './app-worker-calls.js';
import { AppWorkerApi } from '../rpc/app-worker-api.js';
import { sha256Hex } from './app-tokens.js';
import { sealSecret } from './encryption.js';
import { mintCallerGrant } from './caller-grant.js';
import { resetBurstState } from './log-quota.js';
import type { Env } from '../types.js';

// #254 (ADR-009 §2, §4): what an app worker's PAS binding may do, against an
// in-memory D1/R2 and a stubbed data worker. Real D1 semantics (the atomic budget
// across isolates, batch rollback) are in runtime-tests/test/backend/app-worker-pas.test.ts.

const KEK = 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=';
const TOKEN = 't'.repeat(64);
const OLD_TOKEN = 'o'.repeat(64);

type Row = Record<string, unknown>;
let worker: Row | null;
let invocations: Map<string, Row>;
let tools: Map<string, Row>;
let workerSecrets: string[] | null;
let appSecrets: Map<string, Row>;
let logs: unknown[][];
let r2: Map<string, { bytes: Uint8Array; contentType?: string }>;
let sent: { url: string; body: unknown }[];
let points: unknown[];
let appRoles: Map<string, string[]>;
let audits: unknown[][];

const tool = (m: Row) => tools.set(String(m.name), m);
const workerTool = (name: string, extra: Row = {}) => tool({
  name, description: name, operation: 'execute', requires_auth: true, params: { id: { type: 'string' } },
  sql: 'INSERT INTO t (id, by) VALUES (:id, :__user_id)', auth: { caller_unscoped: { reason: 'worker' } }, callers: ['worker'], ...extra,
});

function fakeDb(): D1Database {
  const handle = (sql: string, args: unknown[]): { first?: unknown; changes?: number; all?: unknown[] } => {
    const s = sql.replace(/\s+/g, ' ').trim();
    if (s.startsWith('SELECT w.* FROM app_workers')) return { first: worker && worker.app_id === args[0] && worker.enabled === 1 && worker.deployed_at ? { ...worker } : null };
    if (s.startsWith('UPDATE app_worker_invocations SET pas_calls')) {
      const inv = invocations.get(String(args[0]));
      if (!inv || inv.app_id !== args[1] || inv.status !== 'running' || Number(inv.pas_calls) >= Number(args[2])) return { changes: 0 };
      inv.pas_calls = Number(inv.pas_calls) + 1;
      return { changes: 1 };
    }
    if (s.startsWith('SELECT status FROM app_worker_invocations')) {
      const inv = invocations.get(String(args[0]));
      return { first: inv && inv.app_id === args[1] ? { status: inv.status } : null };
    }
    if (s.startsWith('SELECT manifest FROM app_tools')) {
      const m = tools.get(String(args[1]));
      return { first: m ? { manifest: JSON.stringify(m) } : null };
    }
    if (s.startsWith('SELECT secrets FROM app_worker_manifest')) return { first: workerSecrets ? { secrets: JSON.stringify(workerSecrets) } : null };
    if (s.startsWith('SELECT key_ciphertext')) return { first: appSecrets.get(String(args[1])) ?? null };
    if (s.startsWith('UPDATE app_secrets SET last_used_at')) return { changes: 1 };
    if (s.startsWith('SELECT role_name FROM app_roles')) return { all: (appRoles.get(String(args[1])) ?? []).map((role_name) => ({ role_name })) };
    if (s.startsWith('INSERT INTO app_action_audit')) { audits.push(args); return { changes: 1 }; }
    if (s.startsWith('SELECT count FROM app_log_usage')) return { first: null };
    if (s.startsWith('INSERT INTO app_log_usage')) return { changes: 1 };
    if (s.startsWith('INSERT INTO app_logs')) { logs.push(args); return { changes: 1 }; }
    throw new Error(`fake D1: unexpected SQL ${s.slice(0, 90)}`);
  };
  return {
    prepare: (sql: string) => {
      const exec = (args: unknown[]) => ({
        first: async () => handle(sql, args).first ?? null,
        run: async () => ({ meta: { changes: handle(sql, args).changes ?? 0 } }),
        all: async () => ({ results: handle(sql, args).all ?? [] }),
      });
      return { ...exec([]), bind: (...args: unknown[]) => exec(args) };
    },
  } as unknown as D1Database;
}

function fakeR2(): R2Bucket {
  return {
    head: async (k: string) => (r2.has(k) ? {} : null),
    list: async ({ prefix }: { prefix: string }) => ({ objects: [...r2.keys()].filter((k) => k.startsWith(prefix)).map((key) => ({ key })) }),
    put: async (k: string, bytes: Uint8Array, o?: { httpMetadata?: { contentType?: string } }) => { r2.set(k, { bytes, contentType: o?.httpMetadata?.contentType }); },
    get: async (k: string) => {
      const v = r2.get(k);
      return v ? { arrayBuffer: async () => v.bytes.slice().buffer, httpMetadata: { contentType: v.contentType } } : null;
    },
  } as unknown as R2Bucket;
}

let env: Env;
const ctx = (over: Row = {}) => ({ token: TOKEN, invocation: 'e1:1', ...over });

async function code(p: Promise<unknown>): Promise<string> {
  try { await p; } catch (e) { expect(e).toBeInstanceOf(WorkerCallError); return (e as WorkerCallError).code; }
  return 'ok';
}

beforeEach(async () => {
  resetBurstState();
  worker = { app_id: 't', enabled: 1, deployed_at: 1, token_hash: await sha256Hex(TOKEN), prev_token_hash: null, prev_token_until: null };
  invocations = new Map([['e1:1', { app_id: 't', status: 'running', pas_calls: 0 }]]);
  tools = new Map();
  workerSecrets = null;
  appSecrets = new Map();
  logs = [];
  r2 = new Map();
  sent = [];
  points = [];
  appRoles = new Map();
  audits = [];
  env = {
    DB: fakeDb(), STORAGE: fakeR2(), APP_SECRET_KEK: KEK, DATA_WORKER_HOST: 'test.workers.dev', INTERNAL_TOKEN: 'internal', SESSION_SIGNING_KEY: 'sk',
    APP_WORKER_CALLS: { writeDataPoint: (p: unknown) => points.push(p) },
  } as unknown as Env;
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    sent.push({ url: String(url), body });
    if (String(url).endsWith('/batch')) return Response.json({ results: (body.statements as unknown[]).map(() => ({ rows: [], meta: { changes: 1 } })) });
    return Response.json({ rows: [{ ok: 1 }], meta: { changes: 1 } });
  }));
});
afterEach(() => vi.unstubAllGlobals());

describe('authorizeWorkerCall: token is authoritative, every call (#254)', () => {
  it('accepts the current token for a running invocation and counts the call', async () => {
    await authorizeWorkerCall(env, 't', ctx());
    expect(invocations.get('e1:1')!.pas_calls).toBe(1);
  });

  it('refuses no app, no ctx, a wrong token, another app, a disabled worker and a forged caller grant', async () => {
    expect(await code(authorizeWorkerCall(env, undefined, ctx()))).toBe('Unauthorized');
    expect(await code(authorizeWorkerCall(env, 't', null))).toBe('Unauthorized');
    expect(await code(authorizeWorkerCall(env, 't', { token: TOKEN }))).toBe('Unauthorized');
    expect(await code(authorizeWorkerCall(env, 't', ctx({ token: 'x'.repeat(64) })))).toBe('Unauthorized');
    expect(await code(authorizeWorkerCall(env, 'u', ctx()))).toBe('Unauthorized');
    expect(await code(authorizeWorkerCall(env, 't', ctx({ as: { grant: 'g' } })))).toBe('Unauthorized');
    worker!.enabled = 0;
    expect(await code(authorizeWorkerCall(env, 't', ctx()))).toBe('Unauthorized');
    // None of the refusals spent budget.
    expect(invocations.get('e1:1')!.pas_calls).toBe(0);
  });

  it('accepts the previous token only inside the rotation overlap; after remove() nothing is accepted', async () => {
    worker!.prev_token_hash = await sha256Hex(OLD_TOKEN);
    worker!.prev_token_until = Date.now() + 60_000;
    expect(await code(authorizeWorkerCall(env, 't', ctx({ token: OLD_TOKEN })))).toBe('ok');
    worker!.prev_token_until = Date.now() - 1;
    expect(await code(authorizeWorkerCall(env, 't', ctx({ token: OLD_TOKEN })))).toBe('Unauthorized');
    worker!.token_hash = null;
    worker!.prev_token_hash = null;
    expect(await code(authorizeWorkerCall(env, 't', ctx()))).toBe('Unauthorized');
  });

  it(`the ${MAX_PAS_CALLS_PER_INVOCATION + 1}st call is TooManyCalls; a finished or unknown invocation is Unauthorized`, async () => {
    for (let i = 0; i < MAX_PAS_CALLS_PER_INVOCATION; i++) await authorizeWorkerCall(env, 't', ctx());
    expect(await code(authorizeWorkerCall(env, 't', ctx()))).toBe('TooManyCalls');
    invocations.get('e1:1')!.status = 'succeeded';
    expect(await code(authorizeWorkerCall(env, 't', ctx()))).toBe('Unauthorized');
    expect(await code(authorizeWorkerCall(env, 't', ctx({ invocation: 'nope:1' })))).toBe('Unauthorized');
  });
});

describe('actions as system:worker (#254)', () => {
  it('runs an action whose callers include worker, binding :__user_id to system:worker', async () => {
    workerTool('add_row');
    const out = await workerActionCall(env, 't', 'add_row', { id: 'r1' });
    expect(out).toMatchObject({ meta: { changes: 1 } });
    expect(sent).toHaveLength(1);
    expect(sent[0]!.url).toBe('https://pas-data-t.test.workers.dev/execute');
    expect(sent[0]!.body).toEqual({ sql: 'INSERT INTO t (id, by) VALUES (?, ?)', params: ['r1', SYSTEM_WORKER_USER] });
  });

  it('refuses default-callers, scheduled, role-gated, verify and unknown actions before any SQL', async () => {
    workerTool('user_only', { callers: undefined });
    workerTool('sched', { callers: undefined, schedule: { cron: '*/5 * * * *', params: {} } });
    workerTool('gated', { auth: { app_roles: ['admin'] } });
    workerTool('verified', { operation: 'verify' });
    expect(await code(workerActionCall(env, 't', 'user_only', {}))).toBe('Forbidden');
    expect(await code(workerActionCall(env, 't', 'sched', {}))).toBe('Forbidden');
    expect(await code(workerActionCall(env, 't', 'gated', { id: 'x' }))).toBe('Forbidden');
    expect(await code(workerActionCall(env, 't', 'verified', { id: 'x' }))).toBe('Forbidden');
    expect(await code(workerActionCall(env, 't', 'missing', {}))).toBe('NotFound');
    expect(await code(workerActionCall(env, 't', '', {}))).toBe('BadRequest');
    expect(await code(workerActionCall(env, 't', 'user_only', [] as never))).toBe('BadRequest');
    expect(sent).toHaveLength(0);
  });

  it('a query runs on /query; a batch tool on /batch', async () => {
    workerTool('read', { operation: 'query', sql: 'SELECT * FROM t WHERE by = :__user_id', params: {} });
    workerTool('two', { operation: 'batch', sql: undefined, statements: ['DELETE FROM t WHERE id = :id', 'INSERT INTO t (id) VALUES (:id)'] });
    await workerActionCall(env, 't', 'read', {});
    await workerActionCall(env, 't', 'two', { id: 'a' });
    expect(sent.map((s) => s.url.split('/').pop())).toEqual(['query', 'batch']);
  });

  it(`batch: ${MAX_BATCH_STATEMENTS} statements go in one /batch; one more is refused before any SQL; results split per call`, async () => {
    workerTool('add_row');
    const calls = (n: number) => Array.from({ length: n }, (_, i) => ({ name: 'add_row', params: { id: `r${i}` } }));
    expect(await code(workerActionBatch(env, 't', calls(MAX_BATCH_STATEMENTS + 1)))).toBe('BadRequest');
    expect(sent).toHaveLength(0);
    const out = await workerActionBatch(env, 't', calls(MAX_BATCH_STATEMENTS));
    expect(sent).toHaveLength(1);
    expect((sent[0]!.body as { statements: unknown[] }).statements).toHaveLength(MAX_BATCH_STATEMENTS);
    expect(out).toHaveLength(MAX_BATCH_STATEMENTS);
    expect(out[0]).toEqual({ name: 'add_row', results: [{ rows: [], meta: { changes: 1 } }] });
    expect(await code(workerActionBatch(env, 't', []))).toBe('BadRequest');
  });

  it('refuses a batch over 1 MB and surfaces a data-worker failure', async () => {
    workerTool('add_row');
    expect(await code(workerActionBatch(env, 't', Array.from({ length: 300 }, () => ({ name: 'add_row', params: { id: 'x'.repeat(4000) } }))))).toBe('BadRequest');
    vi.stubGlobal('fetch', vi.fn(async () => new Response('boom', { status: 500 })));
    expect(await code(workerActionCall(env, 't', 'add_row', { id: 'a' }))).toBe('Failed');
  });
});

describe('secrets, storage and log (#254)', () => {
  it('secrets.get returns a declared secret, null for an undeclared or missing one, Unavailable without a KEK', async () => {
    const sealed = await sealSecret('ghp_secret', KEK);
    appSecrets.set('GITHUB_TOKEN', { key_ciphertext: sealed.keyCiphertext, dek_wrapped: sealed.dekWrapped, iv: sealed.iv });
    workerSecrets = ['GITHUB_TOKEN', 'MISSING'];
    expect(await workerSecretGet(env, 't', 'GITHUB_TOKEN')).toBe('ghp_secret');
    expect(await workerSecretGet(env, 't', 'MISSING')).toBeNull();
    expect(await workerSecretGet(env, 't', 'STRIPE_KEY')).toBeNull();
    expect(await code(workerSecretGet({ ...env, APP_SECRET_KEK: undefined } as Env, 't', 'GITHUB_TOKEN'))).toBe('Unavailable');
    workerSecrets = null;
    expect(await workerSecretGet(env, 't', 'GITHUB_TOKEN')).toBeNull();
  });

  it('storage lives under <app>/_worker/ and refuses path tricks and oversized objects', async () => {
    expect(await workerStoragePut(env, 't', 'state/a.json', '{"n":1}', { contentType: 'application/json' })).toEqual({ key: 'state/a.json', size: 7 });
    expect([...r2.keys()]).toEqual(['t/_worker/state/a.json']);
    const got = await workerStorageGet(env, 't', 'state/a.json');
    expect(new TextDecoder().decode(got!.body)).toBe('{"n":1}');
    expect(got!.contentType).toBe('application/json');
    expect(await workerStorageGet(env, 't', 'none.json')).toBeNull();
    for (const bad of ['../x', 'a/../b', '/abs', 'a//b', '', 'x'.repeat(600)]) expect(() => workerStorageKey('t', bad), bad).toThrow(WorkerCallError);
    expect(await code(workerStoragePut(env, 't', 'big.bin', new Uint8Array(10 * 1024 * 1024 + 1)))).toBe('BadRequest');
    expect(await code(workerStoragePut(env, 't', 'x.bin', 42))).toBe('BadRequest');
  });

  it('log writes app_logs as system:worker, category worker, traced to its invocation (#308)', async () => {
    expect(await workerLog(env, 't', 'info', 'synced', { count: 3 }, 'evt-1:1')).toBe(true);
    expect(logs[0]).toEqual(expect.arrayContaining(['t', SYSTEM_WORKER_USER, 'info', 'worker', 'synced', 'evt-1:1', 'worker']));
    expect(await code(workerLog(env, 't', 'loud', 'x', undefined, 'evt-1:1'))).toBe('BadRequest');
    expect(await code(workerLog(env, 't', 'info', '', undefined, 'evt-1:1'))).toBe('BadRequest');
  });
});

describe('AppWorkerApi RPC surface (#254)', () => {
  const api = (props: unknown) => new AppWorkerApi({ props } as never, env);

  it('every namespace authorises first, then runs, and records one AE point per call', async () => {
    workerTool('add_row');
    const pas = api({ appId: 't' });
    await pas.actions.call('add_row', { id: 'a' }, ctx());
    await pas.actions.batch([{ name: 'add_row', params: { id: 'b' } }], ctx());
    await pas.storage.put('k.txt', 'v', undefined, ctx());
    expect(await pas.storage.get('k.txt', ctx())).not.toBeNull();
    expect(await pas.secrets.get('NONE', ctx())).toBeNull();
    expect(await pas.log('warn', 'hello', undefined, ctx())).toBe(true);
    expect(invocations.get('e1:1')!.pas_calls).toBe(6);
    expect(points).toHaveLength(6);
    expect(points[0]).toEqual({ indexes: ['t'], blobs: ['actions.call', 'add_row', 'ok'], doubles: [1] });
  });

  it('refuses a binding without props and a wrong token, recording the outcome', async () => {
    await expect(api(undefined).actions.call('add_row', {}, ctx())).rejects.toThrow(/^Unauthorized:/);
    await expect(api({ appId: 't' }).actions.call('add_row', {}, ctx({ token: 'bad' }))).rejects.toThrow(/^Unauthorized:/);
    expect(points).toEqual([{ indexes: ['t'], blobs: ['actions.call', 'add_row', 'Unauthorized'], doubles: [1] }]);
  });

  it('an unexpected failure is reported as Failed, never leaking the cause', async () => {
    env.DB = { prepare: () => { throw new Error('D1 exploded with secrets'); } } as unknown as D1Database;
    await expect(api({ appId: 't' }).log('info', 'x', undefined, ctx())).rejects.toThrow(/^Failed: log failed$/);
  });
});

describe('actions as the caller of an http request (#260)', () => {
  const userTool = (name: string, extra: Row = {}) => tool({
    name, description: name, operation: 'query', requires_auth: true, params: {},
    sql: 'SELECT id FROM notes WHERE owner = :__user_id LIMIT 10', ...extra,
  });
  const grant = (over: Row = {}) => mintCallerGrant(env, 't', { id: 'gh:42', roles: ['user'] }).then((g) => ({ ...g, ...over }));

  it('runs a user action with :__user_id = the grant\'s user', async () => {
    userTool('my_notes');
    const pas = new AppWorkerApi({ props: { appId: 't' } } as never, env);
    await pas.actions.call('my_notes', {}, ctx({ as: await grant() }));
    expect(sent[0]!.body).toEqual({ sql: 'SELECT id FROM notes WHERE owner = ? LIMIT 10', params: ['gh:42'] });
  });

  it('applies the action\'s role gate as the user, and records the role-gated success audit', async () => {
    userTool('mod_queue', { auth: { app_roles: ['moderator'] } });
    const g = await grant();
    expect(await code(workerActionCall(env, 't', 'mod_queue', {}, { id: 'gh:42', roles: ['user'] }))).toBe('Forbidden');
    appRoles.set('gh:42', ['moderator']);
    const pas = new AppWorkerApi({ props: { appId: 't' } } as never, env);
    await pas.actions.batch([{ name: 'mod_queue' }], ctx({ as: g }));
    expect(audits).toEqual([expect.arrayContaining(['t', 'mod_queue', 'gh:42', 'moderator', 200])]);
  });

  it('refuses worker-only and step-up actions as a user; a grant for another app or an expired one spends no budget', async () => {
    workerTool('add_row');
    userTool('id_docs', { step_up: true });
    const caller = { id: 'gh:42', roles: ['user'] };
    expect(await code(workerActionCall(env, 't', 'add_row', { id: 'x' }, caller))).toBe('Forbidden');
    expect(await code(workerActionCall(env, 't', 'id_docs', {}, caller))).toBe('Forbidden');
    const other = await mintCallerGrant(env, 'u', caller);
    expect(await code(authorizeWorkerCall(env, 't', ctx({ as: other })))).toBe('Unauthorized');
    expect(await code(authorizeWorkerCall(env, 't', ctx({ as: await grant() }), Date.now() + 31_000))).toBe('Unauthorized');
    expect(invocations.get('e1:1')!.pas_calls).toBe(0);
    expect(sent).toHaveLength(0);
  });
});
