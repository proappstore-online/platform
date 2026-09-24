/**
 * Where the backend reaches an app's data worker (#153).
 *
 * Two paths exist to a data worker, and they are NOT interchangeable:
 *
 *  - Browser traffic goes through cookie mediation: the app origin's
 *    `/.pas/data/*` → host worker → `data-<app>.proappstore.online` → (host
 *    worker again, wildcard route) → the worker on its workers.dev host.
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
export function dataWorkerHost(env: { DATA_WORKER_HOST?: string }): string {
  const host = (env.DATA_WORKER_HOST ?? '').trim().replace(/^https?:\/\//, '').replace(/\/+$/, '');
  if (!host) throw new HttpError('DATA_WORKER_HOST is not configured', 503);
  return host;
}

/** Direct (internal) URL of `appId`'s data worker, plus an optional path. */
export function dataWorkerUrl(env: { DATA_WORKER_HOST?: string }, appId: string, path = ''): string {
  const suffix = path ? (path.startsWith('/') ? path : `/${path}`) : '';
  return `https://${dataWorkerName(appId)}.${dataWorkerHost(env)}${suffix}`;
}

/** The public, host-mediated hostname — what browsers use, never the backend. */
export const PUBLIC_DATA_HOST_RE = /^https?:\/\/data-[a-z0-9-]+\.proappstore\.online(\/|$)/i;
