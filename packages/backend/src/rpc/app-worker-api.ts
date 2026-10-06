/**
 * `AppWorkerApi` — the RPC entrypoint behind an app worker's `PAS` binding
 * (#254, ADR-009 §2). The loader backend hands each worker a stub made from
 * `ctx.exports.AppWorkerApi({ props: { appId } })` (lib/app-worker-host.ts), so
 * `props` is set by platform code; the worker's token is still required on every
 * call, and is the authoritative factor.
 *
 *   env.PAS.actions.call(name, params, ctx)      env.PAS.actions.batch(calls, ctx)
 *   env.PAS.secrets.get(name, ctx)               env.PAS.log(level, message, fields, ctx)
 *   env.PAS.storage.put(key, body, opts, ctx)    env.PAS.storage.get(key, ctx)
 *
 * with ctx = { token: env.PAS_WORKER_TOKEN, invocation: '<envelope id>:<attempt>' }.
 * The SDK's `defineAppWorker` (@proappstore/sdk/worker) fills ctx in.
 *
 * Workers RPC exposes prototype methods and getters, not instance fields, so the
 * namespaces are getters returning `RpcTarget`s; the shared runner is a private
 * field, which RPC never exposes. The logic is lib/app-worker-calls.ts.
 */
import { RpcTarget, WorkerEntrypoint } from 'cloudflare:workers';
import type { Env } from '../types.js';
import {
  authorizeWorkerCall, recordWorkerCall, workerActionBatch, workerActionCall, workerLog,
  workerSecretGet, workerStorageGet, workerStoragePut, WorkerCallError,
} from '../lib/app-worker-calls.js';

type Run = <T>(method: string, action: string, ctx: unknown, fn: (appId: string) => Promise<T>) => Promise<T>;

function runner(env: Env, appId: string | undefined): Run {
  return async (method, action, ctx, fn) => {
    let outcome = 'ok';
    try {
      await authorizeWorkerCall(env, appId, ctx);
      return await fn(appId!);
    } catch (e) {
      outcome = e instanceof WorkerCallError ? e.code : 'Failed';
      if (e instanceof WorkerCallError) throw e;
      console.error(`[app-worker] ${appId ?? '?'} ${method} failed: ${(e as Error)?.message ?? e}`);
      throw new WorkerCallError('Failed', `${method} failed`);
    } finally {
      if (appId) recordWorkerCall(env, appId, method, action, outcome);
    }
  };
}

class ActionsApi extends RpcTarget {
  readonly #run: Run;
  readonly #env: Env;
  constructor(run: Run, env: Env) { super(); this.#run = run; this.#env = env; }
  call(name: string, params: Record<string, unknown> | undefined, ctx: unknown): Promise<unknown> {
    return this.#run('actions.call', String(name ?? ''), ctx, (appId) => workerActionCall(this.#env, appId, name, params));
  }
  /** Many invocations, one D1 transaction; counts as ONE PAS call. */
  batch(calls: { name: string; params?: Record<string, unknown> }[], ctx: unknown): Promise<{ name: string; results: unknown[] }[]> {
    return this.#run('actions.batch', '', ctx, (appId) => workerActionBatch(this.#env, appId, calls));
  }
}

class SecretsApi extends RpcTarget {
  readonly #run: Run;
  readonly #env: Env;
  constructor(run: Run, env: Env) { super(); this.#run = run; this.#env = env; }
  get(name: string, ctx: unknown): Promise<string | null> {
    return this.#run('secrets.get', '', ctx, (appId) => workerSecretGet(this.#env, appId, name));
  }
}

class StorageApi extends RpcTarget {
  readonly #run: Run;
  readonly #env: Env;
  constructor(run: Run, env: Env) { super(); this.#run = run; this.#env = env; }
  put(key: string, body: string | ArrayBuffer | Uint8Array, opts: { contentType?: string } | undefined, ctx: unknown): Promise<{ key: string; size: number }> {
    return this.#run('storage.put', '', ctx, (appId) => workerStoragePut(this.#env, appId, key, body, opts));
  }
  get(key: string, ctx: unknown): Promise<{ body: ArrayBuffer; contentType: string } | null> {
    return this.#run('storage.get', '', ctx, (appId) => workerStorageGet(this.#env, appId, key));
  }
}

export class AppWorkerApi extends WorkerEntrypoint<Env, { appId: string }> {
  #runner(): Run {
    return runner(this.env, (this.ctx as { props?: { appId?: string } }).props?.appId);
  }
  get actions(): ActionsApi { return new ActionsApi(this.#runner(), this.env); }
  get secrets(): SecretsApi { return new SecretsApi(this.#runner(), this.env); }
  get storage(): StorageApi { return new StorageApi(this.#runner(), this.env); }
  log(level: 'debug' | 'info' | 'warn' | 'error', message: string, fields: Record<string, unknown> | undefined, ctx: unknown): Promise<boolean> {
    return this.#runner()('log', '', ctx, (appId) => workerLog(this.env, appId, level, message, fields));
  }
}
