import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import {
  APP_MODULE, BODY_EXCERPT_BYTES, MAX_BUNDLE_BYTES, SHIM_MODULE,
  appWorkerHost, appWorkerShimSha, bundleSha256, excerpt, loaderId, parseBundle,
} from './app-worker-host.js';
import { HttpError } from './auth.js';
import type { Env } from '../types.js';

// #253 (ADR-009 §1, §5): the bundle rules, the loader ID and the backend switch.
// The deploy/invoke/remove paths run against real D1, R2 and the Worker Loader
// in packages/runtime-tests/test/backend/app-workers.test.ts.

const file = (text: string) => new File([text], 'm.js', { type: 'application/javascript' });
function form(parts: Record<string, string | File>): FormData {
  const f = new FormData();
  for (const [k, v] of Object.entries(parts)) f.append(k, v);
  return f;
}
async function refusal(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(HttpError);
    expect((e as HttpError).status).toBe(400);
    return (e as HttpError).message;
  }
  throw new Error('expected a 400');
}

describe('parseBundle (#253)', () => {
  it('accepts app.js plus chunks', async () => {
    const b = await parseBundle(form({ 'app.js': file('export default {}'), 'chunks/a-1.js': file('export const a = 1') }));
    expect(Object.keys(b.modules).sort()).toEqual(['app.js', 'chunks/a-1.js']);
  });

  it('refuses the platform entry module, wrangler config, metadata and non-file parts', async () => {
    expect(await refusal(parseBundle(form({ [APP_MODULE]: file('x'), [SHIM_MODULE]: file('evil') })))).toContain("platform's entry module");
    expect(await refusal(parseBundle(form({ [APP_MODULE]: file('x'), 'wrangler.toml': file('name="x"') })))).toContain('not allowed');
    expect(await refusal(parseBundle(form({ [APP_MODULE]: file('x'), 'wrangler.jsonc': file('{}') })))).toContain('not allowed');
    expect(await refusal(parseBundle(form({ [APP_MODULE]: file('x'), metadata: file('{"bindings":[]}') })))).toContain('not allowed');
    expect(await refusal(parseBundle(form({ [APP_MODULE]: 'export default {}' })))).toContain('must be a file');
  });

  it('refuses a bundle without app.js, path tricks and non-module names', async () => {
    expect(await refusal(parseBundle(form({ 'main.js': file('x') })))).toContain('must contain app.js');
    for (const name of ['../app.js', 'a/../app.js', '/abs.js', 'a//b.js', 'readme.md', 'app.ts']) {
      expect(await refusal(parseBundle(form({ [APP_MODULE]: file('x'), [name]: file('x') }))), name).toContain('not a valid module name');
    }
  });

  it('refuses a bundle over the size limit', async () => {
    const big = file('x'.repeat(MAX_BUNDLE_BYTES));
    expect(await refusal(parseBundle(form({ [APP_MODULE]: file('x'), 'big.js': big })))).toContain('exceeds');
  });
});

describe('bundle identity and loader ID', () => {
  it('bundleSha256 is independent of part order and changes with any source', async () => {
    const a = await bundleSha256({ modules: { 'app.js': 'A', 'b.js': 'B' } });
    expect(await bundleSha256({ modules: { 'b.js': 'B', 'app.js': 'A' } })).toBe(a);
    expect(await bundleSha256({ modules: { 'app.js': 'A', 'b.js': 'C' } })).not.toBe(a);
    expect(await bundleSha256({ modules: { 'app.jsb': '', '.js': 'B' } })).not.toBe(await bundleSha256({ modules: { 'app.js': 'b', '.js': 'B' } }));
  });

  it('the loader ID carries app, bundle, config version and the shim hash', async () => {
    const shim = await appWorkerShimSha();
    expect(shim).toMatch(/^[0-9a-f]{64}$/);
    expect(loaderId('demo', 'abc', 3, shim)).toBe(`demo:abc:3:${shim}`);
    expect(loaderId('demo', 'abc', 4, shim)).not.toBe(loaderId('demo', 'abc', 3, shim));
  });

  it('excerpt keeps the first 1 KB of a body', () => {
    expect(excerpt('short')).toBe('short');
    expect(new TextEncoder().encode(excerpt('y'.repeat(3 * 1024))).byteLength).toBe(BODY_EXCERPT_BYTES);
  });
});

describe('appWorkerHost backend switch', () => {
  const base = { DB: {}, STORAGE: {} } as unknown as Env;
  async function status(p: Promise<unknown>): Promise<number> {
    try { await p; } catch (e) { return (e as HttpError).status; }
    return 0;
  }

  it('unset is off: deploy and invoke answer 503', async () => {
    const host = appWorkerHost(base);
    expect(host.backend).toBeNull();
    expect(await status(host.deploy('a', { modules: {} }))).toBe(503);
    expect(await status(host.invoke('a', { id: 'e', type: 'schedule', attempt: 1, payload: {} }, { timeoutMs: 1 }))).toBe(503);
  });

  it('loader without its binding is 503; account and dispatch are 501', async () => {
    expect(await status(appWorkerHost({ ...base, APP_WORKER_BACKEND: 'loader' }).deploy('a', { modules: {} }))).toBe(503);
    expect(await status(appWorkerHost({ ...base, APP_WORKER_BACKEND: 'account' }).deploy('a', { modules: {} }))).toBe(501);
    expect(await status(appWorkerHost({ ...base, APP_WORKER_BACKEND: 'dispatch' }).deploy('a', { modules: {} }))).toBe(501);
    expect(appWorkerHost({ ...base, APP_WORKER_BACKEND: 'loader', LOADER: {} as WorkerLoader }).backend).toBe('loader');
  });

  it('remove works on an unconfigured backend: credentials revoked, code deleted', async () => {
    const run = vi.fn(async () => ({ meta: { changes: 1 } }));
    const del = vi.fn(async () => undefined);
    const env = {
      DB: { prepare: (sql: string) => ({ bind: () => ({ run: () => run(sql) }) }) },
      STORAGE: { list: async () => ({ objects: [{ key: '_app-workers/a/s/app.js' }], truncated: false }), delete: del },
    } as unknown as Env;
    await appWorkerHost(env).remove('a');
    expect(String(run.mock.calls[0])).toMatch(/token_hash = NULL[\s\S]*event_key_ct = NULL[\s\S]*config_version = config_version \+ 1/);
    expect(del).toHaveBeenCalledWith(['_app-workers/a/s/app.js']);
  });
});

// #253 §6: `pas publish` / provisioning never touches app-worker code. The data
// worker path addresses only `pas-data-<id>` and has no route to the host.
describe('data-worker provisioning never reaches app workers (#253 §6)', () => {
  const src = (p: string) => readFileSync(new URL(p, import.meta.url), 'utf8');

  it('provision-data, deploy-worker and the provision routes do not import the app-worker host', () => {
    for (const p of ['./provision-data.ts', './deploy-worker.ts', '../routes/provision.ts']) {
      expect(src(p), p).not.toMatch(/app-worker-host|appWorkerHost/);
    }
  });

  it('deployDataWorker uploads only to dataWorkerName(appId)', () => {
    expect(src('./deploy-worker.ts')).toMatch(/const workerName = dataWorkerName\(appId\);/);
    expect(src('./deploy-worker.ts')).toMatch(/workers\/scripts\/\$\{workerName\}`/);
  });
});
