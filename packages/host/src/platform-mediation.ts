import { clearSessionCookie, isSameOriginMutation, noStore, readCookie, SESSION_COOKIE_NAME } from "./auth-handler.js";
import type { Env } from "./env.js";
import type { Route } from "./host.js";

const API_PREFIX = "/.pas/api";
const DATA_PREFIX = "/.pas/data";
const WORKER_PREFIX = "/.pas/worker";
const API_BASE = "https://api.proappstore.online";
export const SESSION_INVALIDATION_ID_HEADER = "X-PAS-Session-Invalidation-Id";
export const SESSION_INVALIDATION_REASON_HEADER = "X-PAS-Session-Invalidation-Reason";
const SESSION_INVALIDATION_EVENT_HEADER = "X-PAS-Session-Invalidation";

export async function handlePlatformMediation(request: Request, env: Env, route: Route): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.pathname === API_PREFIX || url.pathname.startsWith(`${API_PREFIX}/`)) {
    // API/auth plane: the backend mints + verifies sessions with the same key,
    // so a 401 here is authoritative — the session really is invalid → clear it.
    // The dedicated passkey handler is the only route that may select a
    // relying party for a ceremony. Do not turn /.pas/api into a second way
    // to obtain an app-host assertion and expose its token to page JS.
    const isPasskeyRoute = url.pathname.startsWith(`${API_PREFIX}/v1/auth/passkey/`);
    return forwardWithSession(request, env.API, upstreamApiUrl(url), true, route, undefined, !isPasskeyRoute);
  }
  if (url.pathname === DATA_PREFIX || url.pathname.startsWith(`${DATA_PREFIX}/`)) {
    // Data plane: each data-worker holds its own SESSION_SIGNING_KEY, which can
    // drift from the backend's (e.g. before a reconcile) and 401 a perfectly
    // valid session. Never let that sign the user out — surface it as a data
    // error and keep the cookie. See #65/#66.
    return forwardWithSession(request, null, upstreamDataUrl(url, route), false, route);
  }
  if (url.pathname === WORKER_PREFIX || url.pathname.startsWith(`${WORKER_PREFIX}/`)) {
    // App worker plane (#260): the backend resolves the user, mints a caller
    // grant and invokes the app's worker. Always a POST upstream; the browser's
    // method and path travel as headers. A 401 here may be the worker's own
    // answer, so it never clears the session cookie.
    const path = `${url.pathname.slice(WORKER_PREFIX.length) || "/"}${url.search}`;
    return forwardWithSession(request, env.API, `${API_BASE}/v1/apps/${route.slug}/worker/http`, false, route, {
      method: "POST",
      headers: { "X-PAS-Worker-Method": request.method, "X-PAS-Worker-Path": path },
    });
  }
  return null;
}

function upstreamApiUrl(url: URL): string {
  const suffix = url.pathname.slice(API_PREFIX.length) || "/";
  const upstream = new URL(`${API_BASE}${suffix}`);
  upstream.search = url.search;
  return upstream.toString();
}

function upstreamDataUrl(url: URL, route: Route): string {
  const suffix = url.pathname.slice(DATA_PREFIX.length) || "/";
  const upstream = new URL(`https://data-${route.slug}.proappstore.online${suffix}`);
  upstream.search = url.search;
  return upstream.toString();
}

/** Rewrite of the upstream request — the worker plane sends every method as a POST with the original in headers. */
interface Upstream { method: string; headers: Record<string, string> }

async function forwardWithSession(request: Request, binding: Fetcher | null, upstreamUrl: string, clearCookieOn401: boolean, route: Route, as?: Upstream, includeHostContext = true): Promise<Response> {
  const token = readCookie(request.headers.get("Cookie"), SESSION_COOKIE_NAME);
  if (!token) return noStore(Response.json({ error: "not signed in" }, { status: 401 }));

  if (isMutation(request.method) && !isSameOriginMutation(request)) {
    return noStore(new Response("Forbidden", { status: 403 }));
  }

  const headers = forwardedHeaders(request.headers, token, route, new URL(request.url).hostname, includeHostContext);
  for (const [name, value] of Object.entries(as?.headers ?? {})) headers.set(name, value);
  const init: RequestInit = {
    method: as?.method ?? request.method,
    headers,
    redirect: "manual",
  };
  if (request.method !== "GET" && request.method !== "HEAD" && request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
    init.body = request.body;
    (init as RequestInit & { duplex: "half" }).duplex = "half";
  }

  const upstreamRequest = new Request(upstreamUrl, init);
  const upstream = binding ? await binding.fetch(upstreamRequest) : await fetch(upstreamRequest);
  if (request.headers.get("Upgrade")?.toLowerCase() === "websocket") return upstream;

  const response = noStore(upstream);
  if (clearCookieOn401 && upstream.status === 401) {
    const correlationId = invalidationId();
    // This private HostApi call is the durable record. Browser telemetry is
    // best-effort only: the Set-Cookie below removes the credential it needs.
    await persistSessionInvalidation(binding, route, correlationId);
    response.headers.append("Set-Cookie", clearSessionCookie());
    // Same-origin response metadata only. It contains neither a credential nor
    // identity, and lines up SDK telemetry with this host operational log.
    response.headers.set(SESSION_INVALIDATION_ID_HEADER, correlationId);
    response.headers.set(SESSION_INVALIDATION_REASON_HEADER, "api_401");
    console.warn("[pas-session-invalidated]", { reason: "api_401", correlationId, plane: "api" });
  }
  return response;
}

async function persistSessionInvalidation(api: Fetcher | null, route: Route, correlationId: string): Promise<void> {
  if (!api) return;
  try {
    const response = await api.fetch(new Request(`${API_BASE}/v1/internal/session-invalidations`, {
      method: "POST",
      headers: {
        "X-PAS-App": route.slug,
        [SESSION_INVALIDATION_EVENT_HEADER]: "api_401",
        [SESSION_INVALIDATION_ID_HEADER]: correlationId,
      },
    }));
    if (!response.ok) console.error("[pas-session-invalidation-log-failed]", { status: response.status, correlationId });
  } catch {
    // The authoritative 401 still clears the stale cookie even if diagnostics
    // storage is temporarily unavailable.
    console.error("[pas-session-invalidation-log-failed]", { correlationId });
  }
}

function invalidationId(): string {
  return crypto.randomUUID().replace(/-/g, "").toLowerCase();
}

function forwardedHeaders(source: Headers, token: string, route: Route, hostname: string, includeHostContext: boolean): Headers {
  const headers = new Headers(source);
  headers.delete("Authorization");
  headers.delete("Cookie");
  headers.delete("Host");
  headers.delete("Origin");
  headers.delete("Referer");
  headers.delete(SESSION_INVALIDATION_EVENT_HEADER);
  headers.delete(SESSION_INVALIDATION_ID_HEADER);
  // App context, asserted by the host from the resolved route rather than taken
  // from the URL the page chose. Delete-then-set, in that order: page JS can send
  // this header itself, and without the delete a page on app A could claim app B
  // through the *trusted* path. This is the whole value of the binding — upstream
  // treats its presence as our word (see backend routes/logs.ts).
  //
  // Deliberately narrow: it names the app, it does not authorize anything. Auth
  // stays the session below.
  headers.delete("X-PAS-App");
  headers.set("X-PAS-App", route.slug);
  // The resolved hostname is host-authenticated context too. App operations
  // that declare step_up use it to require a passkey token from this exact
  // relying party (#331); it does not expose the session token to page JS.
  headers.delete("X-PAS-Host");
  if (includeHostContext) headers.set("X-PAS-Host", hostname);
  // Never let a browser-supplied internal token reach the data-worker's trusted
  // path — this cookie-mediation route is the browser data plane, so the
  // internal path must only ever be reachable from the backend actions-executor.
  headers.delete("X-Internal-Token");
  headers.set("Authorization", `Bearer ${token}`);
  return headers;
}

function isMutation(method: string): boolean {
  return method !== "GET" && method !== "HEAD" && method !== "OPTIONS";
}
