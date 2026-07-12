import { clearSessionCookie, isSameOriginMutation, readCookie, SESSION_COOKIE_NAME } from "./auth-handler.js";
import type { Env } from "./env.js";
import type { Route } from "./host.js";

const API_PREFIX = "/.pas/api";
const DATA_PREFIX = "/.pas/data";
const API_BASE = "https://api.proappstore.online";

export async function handlePlatformMediation(request: Request, env: Env, route: Route): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.pathname === API_PREFIX || url.pathname.startsWith(`${API_PREFIX}/`)) {
    return forwardWithSession(request, env.API, upstreamApiUrl(url));
  }
  if (url.pathname === DATA_PREFIX || url.pathname.startsWith(`${DATA_PREFIX}/`)) {
    return forwardWithSession(request, null, upstreamDataUrl(url, route));
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

async function forwardWithSession(request: Request, binding: Fetcher | null, upstreamUrl: string): Promise<Response> {
  const token = readCookie(request.headers.get("Cookie"), SESSION_COOKIE_NAME);
  if (!token) return noStore(Response.json({ error: "not signed in" }, { status: 401 }));

  if (isMutation(request.method) && !isSameOriginMutation(request)) {
    return noStore(new Response("Forbidden", { status: 403 }));
  }

  const headers = forwardedHeaders(request.headers, token);
  const init: RequestInit = {
    method: request.method,
    headers,
    redirect: "manual",
  };
  if (request.method !== "GET" && request.method !== "HEAD" && request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
    init.body = request.body;
    (init as RequestInit & { duplex: "half" }).duplex = "half";
  }

  const upstreamRequest = new Request(upstreamUrl, init);
  const upstream = binding ? await binding.fetch(upstreamRequest) : await fetch(upstreamRequest);
  const response = noStore(upstream);
  if (upstream.status === 401) response.headers.append("Set-Cookie", clearSessionCookie());
  return response;
}

function forwardedHeaders(source: Headers, token: string): Headers {
  const headers = new Headers(source);
  headers.delete("Authorization");
  headers.delete("Cookie");
  headers.delete("Host");
  headers.delete("Origin");
  headers.delete("Referer");
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

function noStore(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set("Cache-Control", "no-store");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
