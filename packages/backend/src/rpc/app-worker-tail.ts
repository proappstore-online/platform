/**
 * `AppWorkerTail` — the Tail Worker of every loaded app worker (#308). The
 * loader backend attaches `ctx.exports.AppWorkerTail({ props: { appId } })`
 * through `WorkerCode.tails`, so the runtime delivers the dynamic worker's
 * console output, exceptions, cpuTime, wallTime and outcome here once each
 * invocation ends. The logic is lib/app-worker-tail.ts.
 */
import { WorkerEntrypoint } from 'cloudflare:workers';
import type { Env } from '../types.js';
import { recordTail } from '../lib/app-worker-tail.js';

export class AppWorkerTail extends WorkerEntrypoint<Env, { appId: string }> {
  override async tail(events: TraceItem[]): Promise<void> {
    const appId = (this.ctx as { props?: { appId?: string } }).props?.appId;
    if (appId) await recordTail(this.env, appId, events);
  }
}
