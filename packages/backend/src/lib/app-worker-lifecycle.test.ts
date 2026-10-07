import { beforeEach, describe, expect, it } from 'vitest';
import { appWorkerHost, disableAppWorker, rotateAppWorkerCredentials, ROTATION_OVERLAP_MS, KEPT_BUNDLES } from './app-worker-host.js';
import { createShim } from '../app-worker-shim/entry.js';
import { resetBurstState } from './log-quota.js';
import type { Env } from '../types.js';

// #253: the loader backend's deploy → invoke → rotate → remove lifecycle against
// in-memory D1, R2 and Worker Loader fakes. The fake loader runs the REAL entry
// shim over the env and modules the host builds, so a wrong signature, key or
// module layout fails here. The same lifecycle runs on workerd with real D1, R2
// and the Worker Loader in packages/runtime-tests/test/backend/app-workers.test.ts.

const KEK = 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=';

type Row = Record<string, unknown>;
let worker: Row | null;
let invocations: Map<string, Row>;
let r2: Map<string, { text: string; uploaded: Date }>;
let loads: { id: string; code: { env: Record<string, string>; modules: Record<string, string>; globalOutbound: unknown; limits: unknown; mainModule: string } }[];
let appBehaviour: (body: Record<string, unknown>) => Response | Promise<Response>;

function fakeDb(): D1Database {
  const handle = (sql: string, args: unknown[]) => {
    const s = sql.replace(/\s+/g, ' ');
    if (s.startsWith('SELECT token_hash FROM app_workers')) {
      if (!worker || (s.includes('enabled = 1') && worker.enabled !== 1)) return { first: null };
      return { first: { token_hash: worker.token_hash ?? null } };
    }
    if (s.startsWith('SELECT w.* FROM app_workers')) return { first: worker && worker.enabled === 1 && worker.deployed_at ? { ...worker } : null };
    if (s.startsWith("UPDATE app_workers SET backend = 'loader'")) {
      const minting = s.includes('token_hash = ?5');
      if (!worker || worker.enabled !== 1 || (minting ? worker.token_hash : !worker.token_hash)) return { changes: 0 };
      Object.assign(worker, { backend: 'loader', bundle_sha256: args[0], deployed_sha: args[1], deployed_ref: args[2], deployed_at: args[3] });
      if (minting) {
        Object.assign(worker, { token_hash: args[4], token_ct: args[5], token_dek: args[6], token_iv: args[7], event_key_ct: args[8], event_key_dek: args[9], event_key_iv: args[10] });
        worker.config_version = Number(worker.config_version) + 1;
      }
      return { changes: 1 };
    }
    if (s.startsWith('UPDATE app_workers SET prev_token_hash = token_hash')) {
      if (!worker || worker.token_hash !== args[9]) return { first: null };
      Object.assign(worker, {
        prev_token_hash: worker.token_hash, prev_token_until: args[0],
        prev_event_key_ct: worker.event_key_ct, prev_event_key_dek: worker.event_key_dek, prev_event_key_iv: worker.event_key_iv, prev_key_until: args[0],
        token_hash: args[1], token_ct: args[2], token_dek: args[3], token_iv: args[4], event_key_ct: args[5], event_key_dek: args[6], event_key_iv: args[7],
        config_version: Number(worker.config_version) + 1,
      });
      return { first: { config_version: worker.config_version } };
    }
    if (s.startsWith('UPDATE app_workers SET prev_token_hash = NULL')) {
      if (worker) Object.assign(worker, { prev_token_hash: null, prev_token_until: null, prev_event_key_ct: null, prev_event_key_dek: null, prev_event_key_iv: null, prev_key_until: null });
      return { changes: 1 };
    }
    if (s.startsWith('UPDATE app_workers SET token_hash = NULL')) {
      if (worker) {
        for (const k of Object.keys(worker)) if (/token|event_key|key_until|bundle_sha256|script_name|deployed_/.test(k)) worker[k] = null;
        worker.config_version = Number(worker.config_version) + 1;
      }
      return { changes: 1 };
    }
    if (s.startsWith('UPDATE app_workers SET enabled = 0')) { if (worker) worker.enabled = 0; return { changes: 1 }; }
    if (s.startsWith('SELECT count FROM app_log_usage')) return { first: null };
    if (s.startsWith('INSERT INTO app_log_usage')) return { changes: 1 };
    // #275: the invocation reservation and the finished invocation's metering (lib/app-worker-usage.test.ts covers them).
    if (s.startsWith('INSERT INTO app_worker_usage') || s.startsWith('UPDATE app_worker_usage')) return { first: { invocations: 1, cpu_ms: 0, hook_deliveries: 0, pas_calls: 0 } };
    if (s.startsWith('INSERT INTO app_worker_invocations')) {
      if (invocations.has(String(args[0]))) throw new Error('D1_ERROR: UNIQUE constraint failed: app_worker_invocations.id');
      invocations.set(String(args[0]), { status: 'running', started_at: args[6] });
      return { changes: 1 };
    }
    if (s.startsWith('UPDATE app_worker_invocations')) {
      Object.assign(invocations.get(String(args[5]))!, { status: args[0], http_status: args[1], body_excerpt: args[2], finished_at: args[3], error: args[4] });
      return { changes: 1 };
    }
    throw new Error(`fake D1: unexpected SQL ${s.slice(0, 80)}`);
  };
  return {
    prepare: (sql: string) => {
      const exec = (args: unknown[]) => ({
        first: async () => handle(sql, args).first ?? null,
        run: async () => ({ meta: { changes: handle(sql, args).changes ?? 0 } }),
      });
      return { ...exec([]), bind: (...args: unknown[]) => exec(args) };
    },
  } as unknown as D1Database;
}

function fakeR2(): R2Bucket {
  return {
    put: async (key: string, text: string) => { r2.set(key, { text, uploaded: new Date(Date.now() + r2.size) }); },
    get: async (key: string) => (r2.has(key) ? { text: async () => r2.get(key)!.text } : null),
    list: async ({ prefix }: { prefix: string }) => ({
      objects: [...r2.entries()].filter(([k]) => k.startsWith(prefix)).map(([key, v]) => ({ key, uploaded: v.uploaded })),
      truncated: false,
    }),
    delete: async (keys: string | string[]) => { for (const k of [keys].flat()) r2.delete(k); },
  } as unknown as R2Bucket;
}

function fakeLoader(): WorkerLoader {
  return {
    get: (id: string, getCode: () => Promise<unknown>) => ({
      getEntrypoint: () => ({
        fetch: async (req: Request) => {
          const code = (await getCode()) as (typeof loads)[number]['code'];
          loads.push({ id, code });
          const shim = createShim(async () => ({ default: { fetch: async (r: Request) => appBehaviour(await r.json() as Record<string, unknown>) } }));
          return shim.fetch(req, code.env, {});
        },
      }),
    }),
  } as unknown as WorkerLoader;
}

let env: Env;
const bundle = (src = 'export default {}') => ({ modules: { 'app.js': src, 'lib/x.js': 'export const x = 1;' } });
const event = (id = crypto.randomUUID(), payload: unknown = {}) => ({ id, type: 'schedule' as const, name: 'sync', attempt: 1, payload });

beforeEach(() => {
  resetBurstState();
  worker = { app_id: 'demo', enabled: 1, config_version: 1, token_hash: null };
  invocations = new Map();
  r2 = new Map();
  loads = [];
  appBehaviour = (b) => Response.json({ ok: true, name: b.name });
  env = { DB: fakeDb(), STORAGE: fakeR2(), LOADER: fakeLoader(), APP_WORKER_BACKEND: 'loader', APP_SECRET_KEK: KEK } as unknown as Env;
});

describe('loader backend lifecycle (#253)', () => {
  it('first deploy mints sealed credentials and bumps config_version; a redeploy keeps them', async () => {
    const host = appWorkerHost(env);
    const first = await host.deploy('demo', bundle(), { sha: 'abc', ref: 'refs/heads/main' });
    expect(first).toMatchObject({ backend: 'loader', firstDeploy: true });
    expect(worker).toMatchObject({ bundle_sha256: first.bundleSha256, deployed_sha: 'abc', deployed_ref: 'refs/heads/main', config_version: 2 });
    expect(worker!.token_hash).toMatch(/^[0-9a-f]{64}$/);
    expect([...r2.keys()].sort()).toEqual([`_app-workers/demo/${first.bundleSha256}/app.js`, `_app-workers/demo/${first.bundleSha256}/lib/x.js`]);
    const hash = worker!.token_hash;
    const second = await host.deploy('demo', bundle('export default { v: 2 }'));
    expect(second.firstDeploy).toBe(false);
    expect(worker!.token_hash).toBe(hash);
    expect(worker!.config_version).toBe(2);
  });

  it(`keeps only the newest ${KEPT_BUNDLES} bundles in R2`, async () => {
    const host = appWorkerHost(env);
    const shas: string[] = [];
    for (let i = 0; i < 5; i++) shas.push((await host.deploy('demo', bundle(`export default { v: ${i} }`))).bundleSha256);
    const left = new Set([...r2.keys()].map((k) => k.split('/')[2]));
    expect([...left].sort()).toEqual(shas.slice(-KEPT_BUNDLES).sort());
  });

  it('refuses a deploy for a disabled app and a missing KEK', async () => {
    worker!.enabled = 0;
    await expect(appWorkerHost(env).deploy('demo', bundle())).rejects.toMatchObject({ status: 403 });
    await expect(appWorkerHost({ ...env, APP_SECRET_KEK: undefined } as unknown as Env).deploy('demo', bundle())).rejects.toMatchObject({ status: 503 });
  });

  it('invokes through the real shim: signed, isolated, limited, recorded', async () => {
    const host = appWorkerHost(env);
    await host.deploy('demo', bundle());
    const result = await host.invoke('demo', event(), { timeoutMs: 5_000 });
    expect(result).toMatchObject({ status: 'succeeded', httpStatus: 200 });
    expect(JSON.parse(result.body!)).toEqual({ ok: true, name: 'sync' });
    const { id, code } = loads[0]!;
    expect(id).toMatch(new RegExp(`^demo:${worker!.bundle_sha256}:2:[0-9a-f]{64}$`));
    expect(code.mainModule).toBe('__pas_entry.js');
    expect(Object.keys(code.modules).sort()).toEqual(['__pas_entry.js', 'app.js', 'lib/x.js']);
    expect(Object.keys(code.env).sort()).toEqual(['APP_ID', 'PAS_EVENT_KEY', 'PAS_WORKER_TOKEN']);
    expect(code.globalOutbound).toBeNull();
    expect(code.limits).toEqual({ cpuMs: 30_000, subRequests: 500 });
    expect(invocations.get(result.invocationId)).toMatchObject({ status: 'succeeded', http_status: 200, body_excerpt: null });
  });

  it('hands the worker a PAS stub made from ctx.exports with platform-set props (#254)', async () => {
    const made: unknown[] = [];
    const ctx = { exports: { AppWorkerApi: (opts: { props: { appId: string } }) => { made.push(opts); return { stub: 'pas' }; } } };
    const host = appWorkerHost(env, ctx);
    await host.deploy('demo', bundle());
    await host.invoke('demo', event(), { timeoutMs: 5_000 });
    expect(made).toEqual([{ props: { appId: 'demo' } }]);
    expect(Object.keys(loads[0]!.code.env).sort()).toEqual(['APP_ID', 'PAS', 'PAS_EVENT_KEY', 'PAS_WORKER_TOKEN']);
  });

  it('routes outbound fetch through the AppWorkerEgress gateway with platform-set props, else none (#311)', async () => {
    const made: unknown[] = [];
    const ctx = { exports: { AppWorkerEgress: (opts: { props: { appId: string } }) => { made.push(opts); return { stub: 'egress' }; } } };
    const host = appWorkerHost(env, ctx);
    await host.deploy('demo', bundle());
    await host.invoke('demo', event(), { timeoutMs: 5_000 });
    expect(made).toEqual([{ props: { appId: 'demo' } }]);
    expect(loads[0]!.code.globalOutbound).toEqual({ stub: 'egress' });
  });

  it('records a non-2xx with the first 1 KB, a timeout, and refuses a duplicate id', async () => {
    const host = appWorkerHost(env);
    await host.deploy('demo', bundle());
    appBehaviour = () => new Response('E'.repeat(3000), { status: 500 });
    const failed = await host.invoke('demo', event(), { timeoutMs: 5_000 });
    expect(invocations.get(failed.invocationId)).toMatchObject({ status: 'failed', http_status: 500, body_excerpt: 'E'.repeat(1024) });

    appBehaviour = () => new Promise(() => {});
    const slow = await host.invoke('demo', event(), { timeoutMs: 20 });
    expect(slow.status).toBe('timeout');
    expect(invocations.get(slow.invocationId)).toMatchObject({ status: 'timeout', http_status: null });

    appBehaviour = (b) => Response.json(b);
    const e = event('same-id');
    await host.invoke('demo', e, { timeoutMs: 5_000 });
    await expect(host.invoke('demo', e, { timeoutMs: 5_000 })).rejects.toThrow(/already exists/);
  });

  it('refuses to invoke a worker that is not active', async () => {
    await expect(appWorkerHost(env).invoke('demo', event(), { timeoutMs: 5_000 })).rejects.toMatchObject({ status: 409 });
  });

  it('rotation signs with both keys during the overlap, then clears the old ones', async () => {
    const host = appWorkerHost(env);
    await host.deploy('demo', bundle());
    const before = { ...worker! };
    const { configVersion } = await rotateAppWorkerCredentials(env, 'demo');
    expect(configVersion).toBe(Number(before.config_version) + 1);
    expect(worker).toMatchObject({ prev_token_hash: before.token_hash });
    expect(Number(worker!.prev_key_until) - Date.now()).toBeGreaterThan(ROTATION_OVERLAP_MS - 1_000);
    expect((await host.invoke('demo', event(), { timeoutMs: 5_000 })).status).toBe('succeeded');

    // Overlap over: the next invoke clears the previous credentials.
    worker!.prev_key_until = Date.now() - 1;
    worker!.prev_token_until = Date.now() - 1;
    expect((await host.invoke('demo', event(), { timeoutMs: 5_000 })).status).toBe('succeeded');
    expect(worker!.prev_token_hash).toBeNull();
  });

  it('rotation is refused before the first deploy', async () => {
    await expect(rotateAppWorkerCredentials(env, 'demo')).rejects.toMatchObject({ status: 409 });
  });

  it('disable removes code and credentials and bumps config_version', async () => {
    await appWorkerHost(env).deploy('demo', bundle());
    const cv = Number(worker!.config_version);
    await disableAppWorker(env, 'demo');
    expect(worker).toMatchObject({ enabled: 0, token_hash: null, token_ct: null, event_key_ct: null, bundle_sha256: null, deployed_at: null, config_version: cv + 1 });
    expect(r2.size).toBe(0);
  });
});
