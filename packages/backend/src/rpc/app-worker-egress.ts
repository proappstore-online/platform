/**
 * `AppWorkerEgress` — the `globalOutbound` of every loaded app worker (#311,
 * ADR-009 §5). The loader backend hands each worker
 * `ctx.exports.AppWorkerEgress({ props: { appId } })`, so every `fetch()` the
 * worker makes arrives here first, tagged with an app id the worker cannot forge.
 *
 * Prototype scope (first-party apps only): it forwards and logs the app, method
 * and host — never the path, query or headers, which may carry the app's
 * credentials. #267 adds allow-listing and credential injection here before app
 * workers open to all apps.
 */
import { WorkerEntrypoint } from 'cloudflare:workers';
import type { Env } from '../types.js';

export class AppWorkerEgress extends WorkerEntrypoint<Env, { appId: string }> {
  override async fetch(request: Request): Promise<Response> {
    const appId = (this.ctx as { props?: { appId?: string } }).props?.appId ?? '?';
    console.log(`[app-worker-egress] ${appId} ${request.method} ${new URL(request.url).host}`);
    return fetch(request);
  }
}
