/**
 * Where the backend reaches an app's data worker (#153).
 *
 * Two paths exist to a data worker, and they are NOT interchangeable:
 *
 *  - Browser traffic goes through cookie mediation: the app origin's
 *    `/.pas/data/*` → host worker → the worker on its workers.dev host (since
 *    #403; before, it detoured through `data-<app>.proappstore.online` and
 *    back into the host worker).
 *  - Backend-internal traffic (the action executor, registration-time schema
 *    validation, provisioning diagnostics) goes STRAIGHT to the worker's
 *    workers.dev host, authenticated with `X-Internal-Token`. Routing it via
 *    the public `data-*` hostname adds the host worker as a needless proxy
 *    hop, and that hop surfaced HTTP 522 on a healthy worker (chess-academy
 *    incident, #153).
 *
 * The host is configuration (`DATA_WORKER_HOST`, e.g. `<account>.workers.dev`),
 * not a literal in shared source, so the platform is not tied to one
 * Cloudflare account's subdomain. Every internal caller builds its URL here.
 */

import { HttpError } from './auth.js';

const DATA_WORKER_PREFIX = 'pas-data-';

/** Name of the Worker script that serves `appId`'s data plane. */
export function dataWorkerName(appId: string): string {
  return `${DATA_WORKER_PREFIX}${appId}`;
}

/**
 * The workers.dev host data workers are reachable on. Throws a 503 when the
 * binding is missing: a misconfigured platform must fail loud at the call
 * site, not fall back to some hard-coded account.
 */
function dataWorkerHost(env: { DATA_WORKER_HOST?: string }): string {
  const host = (env.DATA_WORKER_HOST ?? '').trim().replace(/^https?:\/\//, '').replace(/\/+$/, '');
  if (!host) throw new HttpError('DATA_WORKER_HOST is not configured', 503);
  return host;
}

/** Direct (internal) URL of `appId`'s data worker, plus an optional path. */
export function dataWorkerUrl(env: { DATA_WORKER_HOST?: string }, appId: string, path = ''): string {
  const suffix = path ? (path.startsWith('/') ? path : `/${path}`) : '';
  return `https://${dataWorkerName(appId)}.${dataWorkerHost(env)}${suffix}`;
}


/**
 * #394: the data worker's own verdict on a 5xx it answered, so a failure is not
 * blamed on the platform when the app's SQL or the caller's request caused it.
 *
 *  - `platform` — D1 or the worker itself failed; counts as a platform 5xx.
 *  - `tenant`   — the app's SQL or schema (no such column, constraint failed, …).
 *  - `client`   — a malformed request body.
 *  - `unknown`  — no verdict: a data worker deployed before #394 sends none.
 */
export const DATA_FAULT_HEADER = 'X-PAS-Fault';
export type DataFault = 'platform' | 'tenant' | 'client' | 'unknown';

export function dataFaultOf(value: string | null | undefined): DataFault {
  return value === 'platform' || value === 'tenant' || value === 'client' ? value : 'unknown';
}

/** A tenant or client fault is the app's or caller's doing, not a platform failure. */
export function isPlatformFault(fault: DataFault): boolean {
  return fault === 'platform' || fault === 'unknown';
}

/**
 * A data-worker 5xx surfaced by the API (#394). Thrown instead of passing the
 * body through, so the error handler records it — with the trace the data
 * worker received — and answers with the usual safe code and trace id. The
 * data worker's body is never copied: it can quote the app's SQL.
 */
export class DataWorkerFailure extends HttpError {
  constructor(status: number, readonly fault: DataFault) {
    super(`data worker returned ${status} (${fault} fault)`, status);
  }
}
