/**
 * `AppWorkerEgress` — the `globalOutbound` of every loaded app worker (#311,
 * ADR-009 §5). The loader backend hands each worker
 * `ctx.exports.AppWorkerEgress({ props: { appId } })`, so every `fetch()` the
 * worker makes arrives here first, tagged with an app id the worker cannot forge.
 *
 * The policy (lib/app-worker-egress.ts, #267): only public internet hosts. The
 * platform's own origins, other apps' workers and private ranges answer 403.
 * Every request is recorded per app (method and host, never the path, query or
 * headers, which may carry the app's credentials) to Analytics Engine.
 */
import { WorkerEntrypoint } from 'cloudflare:workers';
import type { Env } from '../types.js';
import { egressFetch } from '../lib/app-worker-egress.js';

export class AppWorkerEgress extends WorkerEntrypoint<Env, { appId: string }> {
  override async fetch(request: Request): Promise<Response> {
    const appId = (this.ctx as { props?: { appId?: string } }).props?.appId ?? '?';
    return egressFetch(this.env, appId, request);
  }
}
