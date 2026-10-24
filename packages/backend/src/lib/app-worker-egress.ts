/**
 * Egress policy for app workers (#267, ADR-009 §5, §6 B.5): what the
 * `AppWorkerEgress` gateway lets a loaded worker `fetch`. Nothing but public
 * internet hosts: the platform's own origins, the `pas-data-*` / `pas-app-*`
 * workers.dev scripts (other apps' workers) and every private, loopback or
 * link-local address are refused, so a worker reaches platform data only through
 * its `PAS` binding.
 *
 * The host rules mirror the SSRF guard of routes/webhooks-config.ts (which is
 * inline in a handler, so not importable) and add the platform-specific names.
 * Pure functions, so they are unit-tested without a Workers runtime.
 */
import type { Env } from '../types.js';

export type EgressVerdict = { allowed: true } | { allowed: false; reason: string };

/** Redirects the gateway follows itself, re-checking every hop. */
export const MAX_EGRESS_REDIRECTS = 5;

const PLATFORM_DOMAIN = 'proappstore.online';
const PRIVATE_V4 = /^(?:10\.|127\.|0\.|192\.168\.|169\.254\.|172\.(?:1[6-9]|2\d|3[01])\.)/;

/** Verdict for a host name or IP literal (already parsed out of a URL). */
export function egressHostVerdict(rawHost: string): EgressVerdict {
  const host = rawHost.toLowerCase().replace(/\.+$/, '');
  if (!host) return { allowed: false, reason: 'empty host' };
  if (host === PLATFORM_DOMAIN || host.endsWith(`.${PLATFORM_DOMAIN}`)) {
    return { allowed: false, reason: 'platform origin: use the PAS binding' };
  }
  if (host.endsWith('.workers.dev')) {
    const script = host.split('.')[0]!;
    if (script.startsWith('pas-data-') || script.startsWith('pas-app-')) {
      return { allowed: false, reason: "another app's worker" };
    }
  }
  // All IPv6 literals: loopback ::1, unique-local fc00::/7 (fc.., fd..), link-local fe80::/10, mapped IPv4.
  if (host.startsWith('[')) return { allowed: false, reason: 'IPv6 literal' };
  // Bare-decimal and hex IPs (https://2130706433/ is 127.0.0.1) dodge dotted-quad checks.
  if (/^\d+$/.test(host) || /^0x[0-9a-f]+$/i.test(host)) return { allowed: false, reason: 'encoded IP literal' };
  if (PRIVATE_V4.test(host)) return { allowed: false, reason: 'private or loopback address' };
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) {
    return { allowed: false, reason: 'internal host name' };
  }
  return { allowed: true };
}

/** Verdict for a request URL: http(s) only, then the host rules. */
export function egressVerdict(url: string): EgressVerdict {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { allowed: false, reason: 'invalid URL' };
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return { allowed: false, reason: 'scheme not allowed' };
  return egressHostVerdict(parsed.hostname);
}

/** One AE point per outbound request: index = app; blobs method, host, verdict, reason. Never the path, query or headers. */
export function recordEgress(env: Pick<Env, 'APP_WORKER_EGRESS'>, appId: string, method: string, host: string, verdict: EgressVerdict): void {
  try {
    env.APP_WORKER_EGRESS?.writeDataPoint({
      indexes: [appId.slice(0, 96)],
      blobs: [method, host.slice(0, 200), verdict.allowed ? 'allow' : 'block', verdict.allowed ? '' : verdict.reason],
      doubles: [1],
    });
  } catch (e) {
    console.error(`[app-worker-egress] could not record ${appId}: ${(e as Error)?.message ?? e}`);
  }
}

const blocked = (reason: string, host: string) => new Response(
  JSON.stringify({ error: 'egress_blocked', reason, host }),
  { status: 403, headers: { 'content-type': 'application/json' } },
);

/**
 * Forward `request` for `appId` if the policy allows it; otherwise a 403 the
 * worker can read. Redirects are followed here (GET/HEAD only, credentials
 * dropped across origins) so a redirect from an allowed host cannot reach a
 * blocked one; anything else returns the 3xx for the worker to re-request.
 */
export async function egressFetch(
  env: Pick<Env, 'APP_WORKER_EGRESS'>,
  appId: string,
  request: Request,
  doFetch: typeof fetch = fetch,
): Promise<Response> {
  let url = request.url;
  let init: RequestInit | Request = request;
  const origin = new URL(url).origin;
  for (let hop = 0; ; hop++) {
    const verdict = egressVerdict(url);
    const host = (() => { try { return new URL(url).host; } catch { return '?'; } })();
    recordEgress(env, appId, request.method, host, verdict);
    console.log(`[app-worker-egress] ${appId} ${request.method} ${host} ${verdict.allowed ? 'allow' : `block (${verdict.reason})`}`);
    if (!verdict.allowed) return blocked(verdict.reason, host);

    const wantsFollow = request.redirect === 'follow';
    const res = hop === 0
      ? await doFetch(new Request(request, { redirect: 'manual' }))
      : await doFetch(url, init as RequestInit);
    const location = res.headers.get('location');
    const isRedirect = res.status >= 300 && res.status < 400 && location;
    if (!isRedirect || !wantsFollow || !['GET', 'HEAD'].includes(request.method)) return res;
    if (hop >= MAX_EGRESS_REDIRECTS) return blocked('too many redirects', host);

    url = new URL(location, url).toString();
    const headers = new Headers(request.headers);
    if (new URL(url).origin !== origin) { headers.delete('authorization'); headers.delete('cookie'); }
    init = { method: request.method, headers, redirect: 'manual' };
  }
}
