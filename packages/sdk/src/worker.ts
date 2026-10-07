/**
 * `@proappstore/sdk/worker` — write an app worker (ADR-009, #254).
 *
 *   // worker/src/app.ts → built to worker/dist/app.js
 *   import { defineAppWorker } from '@proappstore/sdk/worker';
 *   export default defineAppWorker({
 *     async scheduled(event, pas) {
 *       const key = await pas.secrets.get('GITHUB_TOKEN');
 *       await pas.actions.batch(repos.map((r) => ({ name: 'upsert_repo', params: r })));
 *       await pas.log('info', 'synced', { count: repos.length });
 *     },
 *   });
 *
 * The platform's entry shim has verified the event's signature before this
 * module is even imported, so there is no verification here. Delivery is
 * at-least-once: a handler must be idempotent on `event.id`.
 *
 * Zero dependencies; runs inside the worker sandbox.
 */

/** What the platform delivered (ADR-009 §3). */
export interface AppWorkerEvent {
  /** Idempotency key, stable across retries. */
  id: string;
  type: 'schedule' | 'hook' | 'http';
  name?: string;
  attempt: number;
  issuedAt: number;
  payload: unknown;
  /** Hook events (#256): the sender's allowlisted headers and the exact body bytes. */
  hook?: { headers: Record<string, string>; body: Uint8Array };
}

/** A hook envelope's body back to its exact bytes (`utf8` or `base64`, ADR-009 §3). */
export function hookBody(payload: { body?: unknown; body_encoding?: unknown }): Uint8Array {
  const body = typeof payload.body === 'string' ? payload.body : '';
  if (payload.body_encoding !== 'base64') return new TextEncoder().encode(body);
  const bin = atob(body);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

export interface PasClient {
  actions: {
    /** Run a registered action whose `callers` include "worker", as `system:worker`. */
    call(name: string, params?: Record<string, unknown>): Promise<unknown>;
    /** Many invocations in one transaction (≤ 500 statements); counts as one PAS call. */
    batch(calls: { name: string; params?: Record<string, unknown> }[]): Promise<{ name: string; results: unknown[] }[]>;
  };
  secrets: {
    /** An app secret listed in mcp.json `worker.secrets`; null otherwise. */
    get(name: string): Promise<string | null>;
  };
  connectors: {
    /**
     * A GitHub credential for a connector declared in mcp.json `connectors` (#258): an installation
     * token (repo-scoped when `repo` is given), else the connector's PAT, else null. `mode: 'pat'`
     * forces the PAT — installation tokens cannot answer `viewer` / `@me`; `mode: 'app'` never falls back to it.
     */
    token(name: string, opts?: { repo?: string; mode?: 'app' | 'pat' }): Promise<string | null>;
  };
  storage: {
    /** Stored under the app's worker namespace, never a user's files. ≤ 10 MB. */
    put(key: string, body: string | ArrayBuffer | Uint8Array, opts?: { contentType?: string }): Promise<{ key: string; size: number }>;
    get(key: string): Promise<{ body: ArrayBuffer; contentType: string } | null>;
  };
  /** Append to the app's logs (category `worker`). Resolves false when the app's log quota is spent. */
  log(level: 'debug' | 'info' | 'warn' | 'error', message: string, fields?: Record<string, unknown>): Promise<boolean>;
}

export interface AppWorkerHandlers {
  scheduled?(event: AppWorkerEvent, pas: PasClient): Promise<void> | void;
  webhook?(event: AppWorkerEvent, pas: PasClient): Promise<void> | void;
  /**
   * A signed-in user's request to `/.pas/worker/<path>` (#260), as a standard
   * Request. `pas.actions` run AS that user — their rows, their role gates —
   * for the life of the request. Not retried.
   */
  fetch?(request: Request, pas: PasClient): Promise<Response> | Response;
}

/** The module shape the platform shim imports as `app.js`. */
export interface AppWorkerModule {
  fetch(request: Request, env: AppWorkerEnv, ctx: unknown): Promise<Response>;
}

/** The worker's bindings (ADR-009 §2). */
export interface AppWorkerEnv {
  PAS?: PasBinding;
  PAS_WORKER_TOKEN?: string;
  APP_ID?: string;
}

interface CallCtx { token: string; invocation: string; as?: unknown }
interface PasBinding {
  actions: { call(name: string, params: unknown, ctx: CallCtx): Promise<unknown>; batch(calls: unknown, ctx: CallCtx): Promise<unknown> };
  secrets: { get(name: string, ctx: CallCtx): Promise<string | null> };
  connectors: { token(name: string, opts: unknown, ctx: CallCtx): Promise<string | null> };
  storage: { put(key: string, body: unknown, opts: unknown, ctx: CallCtx): Promise<unknown>; get(key: string, ctx: CallCtx): Promise<unknown> };
  log(level: string, message: string, fields: unknown, ctx: CallCtx): Promise<boolean>;
}

/**
 * A `PasClient` bound to one invocation: every call carries the worker token and
 * the invocation id. With a caller grant (http events, #260), actions run as that user.
 */
export function pasClient(env: AppWorkerEnv, event: Pick<AppWorkerEvent, 'id' | 'attempt'>, caller?: unknown): PasClient {
  const pas = env.PAS;
  if (!pas) throw new Error('this worker has no PAS binding');
  const ctx: CallCtx = { token: env.PAS_WORKER_TOKEN ?? '', invocation: `${event.id}:${event.attempt}` };
  const actionCtx: CallCtx = caller === undefined ? ctx : { ...ctx, as: caller };
  return {
    actions: {
      call: (name, params) => pas.actions.call(name, params ?? {}, actionCtx),
      batch: (calls) => pas.actions.batch(calls, actionCtx) as Promise<{ name: string; results: unknown[] }[]>,
    },
    secrets: { get: (name) => pas.secrets.get(name, ctx) },
    connectors: { token: (name, opts) => pas.connectors.token(name, opts ?? {}, ctx) },
    storage: {
      put: (key, body, opts) => pas.storage.put(key, body, opts ?? {}, ctx) as Promise<{ key: string; size: number }>,
      get: (key) => pas.storage.get(key, ctx) as Promise<{ body: ArrayBuffer; contentType: string } | null>,
    },
    log: (level, message, fields) => pas.log(level, message, fields, ctx),
  };
}

/**
 * Dispatch the platform's event envelope to `scheduled` (type `schedule`) or
 * `webhook` (type `hook`). A handler that returns is a success (200); one that
 * throws is a failure (500, recorded on the invocation). Browser routes
 * (type `http`) arrive with #260.
 */
export function defineAppWorker(handlers: AppWorkerHandlers): AppWorkerModule {
  return {
    async fetch(request, env) {
      let envelope: { id?: unknown; type?: unknown; name?: unknown; attempt?: unknown; issued_at?: unknown; payload?: unknown };
      try {
        envelope = await request.json();
      } catch {
        return new Response('invalid envelope', { status: 400 });
      }
      const event: AppWorkerEvent = {
        id: String(envelope.id ?? ''),
        type: envelope.type as AppWorkerEvent['type'],
        ...(typeof envelope.name === 'string' ? { name: envelope.name } : {}),
        attempt: Number(envelope.attempt ?? 1),
        issuedAt: Number(envelope.issued_at ?? 0),
        payload: envelope.payload,
      };
      if (event.type === 'hook' && envelope.payload && typeof envelope.payload === 'object') {
        const p = envelope.payload as { headers?: Record<string, string>; body?: unknown; body_encoding?: unknown };
        event.hook = { headers: p.headers ?? {}, body: hookBody(p) };
      }
      if (event.type === 'http') {
        if (!handlers.fetch) return new Response('no handler for http events', { status: 404 });
        const p = (envelope.payload ?? {}) as { method?: string; path?: string; query?: string; headers?: Record<string, string>; body?: unknown; body_encoding?: unknown };
        const method = (p.method ?? 'GET').toUpperCase();
        const url = `https://${env.APP_ID ?? 'app'}.proappstore.online${p.path ?? '/'}${p.query ? `?${p.query}` : ''}`;
        const init: RequestInit = { method, headers: p.headers ?? {} };
        if (method !== 'GET' && method !== 'HEAD') init.body = hookBody(p) as BodyInit;
        return handlers.fetch(new Request(url, init), pasClient(env, event, (envelope as { caller?: unknown }).caller));
      }
      const handler = event.type === 'schedule' ? handlers.scheduled : event.type === 'hook' ? handlers.webhook : undefined;
      if (!handler) return new Response(`no handler for ${String(event.type)} events`, { status: 501 });
      try {
        await handler(event, pasClient(env, event));
        return Response.json({ ok: true });
      } catch (e) {
        return new Response(e instanceof Error ? e.message : String(e), { status: 500 });
      }
    },
  };
}
