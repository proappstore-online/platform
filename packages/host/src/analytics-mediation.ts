import { isSameOriginMutation, noStore } from "./auth-handler.js";
import type { Env } from "./env.js";
import type { Route } from "./host.js";

/**
 * Same-origin first-party visitor analytics (#402).
 *
 * Hosted apps may pin `connect-src 'self'` in their own meta CSP (Chess #142),
 * which blocks the loader's beacon to api.proappstore.online whatever the
 * host's header allows. So on an app origin the loader and its event endpoint
 * are served same-origin, signed in or not:
 *
 *   GET  /.pas/analytics.js       the loader, built for this app, posting to ↓
 *   POST /.pas/analytics/event    ingest, forwarded to the API over HostApi
 *
 * Both name the app from the RESOLVED ROUTE, never the URL or body: the backend
 * honours X-PAS-App only on the HostApi entrypoint (#315). Fixed upstream paths
 * (no caller-chosen destination), no cookie or credential forwarded, POST only
 * from this origin, bounded body. Runs after the private-app gate, so a private
 * app takes events only from people it admits. External sites keep using the
 * API's own loader and endpoint unchanged.
 */
export const ANALYTICS_LOADER_PATH = "/.pas/analytics.js";
export const ANALYTICS_EVENT_PATH = "/.pas/analytics/event";
const API_BASE = "https://api.proappstore.online";
/** The visitor's country, which a service-binding request does not carry in `cf` (backend lib/app-context.ts). */
const COUNTRY_HEADER = "X-PAS-Country";
export const MAX_EVENT_BODY_BYTES = 64 * 1024;

export async function handleAnalyticsMediation(request: Request, env: Env, route: Route): Promise<Response | null> {
  const path = new URL(request.url).pathname;
  if (path === ANALYTICS_LOADER_PATH) {
    if (request.method !== "GET" && request.method !== "HEAD") return new Response("Method not allowed", { status: 405 });
    const upstream = await env.API.fetch(new Request(`${API_BASE}/v1/analytics.js`, { headers: { "X-PAS-App": route.slug } }));
    return new Response(request.method === "HEAD" ? null : upstream.body, upstream);
  }
  if (path !== ANALYTICS_EVENT_PATH) return null;

  if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });
  if (!isSameOriginMutation(request)) return noStore(new Response("Forbidden", { status: 403 }));
  if (Number(request.headers.get("Content-Length") ?? 0) > MAX_EVENT_BODY_BYTES) {
    return noStore(new Response("Payload too large", { status: 413 }));
  }
  const body = await request.text();
  if (body.length > MAX_EVENT_BODY_BYTES) return noStore(new Response("Payload too large", { status: 413 }));

  const country = (request as Request & { cf?: { country?: string } }).cf?.country;
  const headers: Record<string, string> = { "Content-Type": "application/json", "X-PAS-App": route.slug };
  for (const name of ["cf-connecting-ip", "user-agent"]) {
    const value = request.headers.get(name);
    if (value) headers[name] = value;
  }
  if (country) headers[COUNTRY_HEADER] = country;
  const upstream = await env.API.fetch(new Request(`${API_BASE}/v1/analytics/event`, { method: "POST", headers, body }));
  return noStore(new Response(null, { status: upstream.status, headers: { "x-events-accepted": upstream.headers.get("x-events-accepted") ?? "0" } }));
}
