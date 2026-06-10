import type { Env } from "./env.js";
import type { Route } from "./host.js";

const AUTH_PREFIX = "/.pas/auth";
const COOKIE_NAME = "__Host-pas_session";
const NONCE_COOKIE_NAME = "__Host-pas_auth_nonce";
const API_BASE = "https://api.proappstore.online";
const SESSION_TTL_SECONDS = 30 * 24 * 60 * 60;
const NONCE_TTL_SECONDS = 10 * 60;
const PROVIDERS = new Set(["github", "google"]);

export async function handleAuthRoute(request: Request, env: Env, route: Route): Promise<Response | null> {
  const url = new URL(request.url);
  if (!url.pathname.startsWith(`${AUTH_PREFIX}/`) && url.pathname !== AUTH_PREFIX) return null;

  if (url.pathname === `${AUTH_PREFIX}/start`) return authStart(request, route);
  if (url.pathname === `${AUTH_PREFIX}/callback`) return authCallback(request, env);
  if (url.pathname === `${AUTH_PREFIX}/me`) return authMe(request, env);
  if (url.pathname === `${AUTH_PREFIX}/logout`) return authLogout(request);

  return noStore(new Response("Not found", { status: 404 }));
}

function authStart(request: Request, route: Route): Response {
  if (request.method !== "GET") return methodNotAllowed();
  const url = new URL(request.url);
  const provider = url.searchParams.get("provider") ?? "github";
  if (!PROVIDERS.has(provider)) return noStore(new Response("unknown provider", { status: 404 }));

  const returnPath = sameOriginPath(url, url.searchParams.get("return_to"));
  const nonce = crypto.randomUUID();
  const callback = new URL(`${AUTH_PREFIX}/callback`, url.origin);
  callback.searchParams.set("return_to", returnPath);
  callback.searchParams.set("nonce", nonce);

  const start = new URL(`/v1/auth/${provider}/start`, API_BASE);
  start.searchParams.set("app_id", route.slug);
  start.searchParams.set("return_to", callback.toString());
  start.searchParams.set("response_mode", "query");

  return redirect(start.toString(), 302, [nonceCookie(nonce)]);
}

async function authCallback(request: Request, env: Env): Promise<Response> {
  if (request.method !== "GET") return methodNotAllowed();
  const url = new URL(request.url);
  const returnPath = sameOriginPath(url, url.searchParams.get("return_to"));
  if (!nonceMatches(request, url)) {
    return redirectWithAuthError(url, returnPath, "invalid_state", [clearNonceCookie()]);
  }
  const session = url.searchParams.get("session");
  if (!session) return redirectWithAuthError(url, returnPath, "missing_session", [clearNonceCookie()]);

  const user = await fetchMe(env, session);
  if (!user.ok) return redirectWithAuthError(url, returnPath, "invalid_session", [clearNonceCookie()]);

  const dest = new URL(returnPath, url.origin);
  const headers = new Headers({
    Location: dest.toString(),
    "Cache-Control": "no-store",
  });
  headers.append("Set-Cookie", sessionCookie(session));
  headers.append("Set-Cookie", clearNonceCookie());
  return new Response(null, { status: 303, headers });
}

async function authMe(request: Request, env: Env): Promise<Response> {
  if (request.method !== "GET") return methodNotAllowed();
  const token = readCookie(request.headers.get("Cookie"), COOKIE_NAME);
  if (!token) return json({ error: "not signed in" }, 401);

  const upstream = await fetchMe(env, token);
  const headers = new Headers({
    "Cache-Control": "no-store",
    "Content-Type": upstream.contentType ?? "application/json; charset=utf-8",
  });
  if (!upstream.ok) headers.set("Set-Cookie", clearSessionCookie());
  return new Response(upstream.body, { status: upstream.status, headers });
}

function authLogout(request: Request): Response {
  if (request.method !== "POST" && request.method !== "GET") return methodNotAllowed();
  return new Response(null, {
    status: 204,
    headers: {
      "Cache-Control": "no-store",
      "Set-Cookie": clearSessionCookie(),
    },
  });
}

async function fetchMe(env: Env, token: string): Promise<{ ok: boolean; status: number; body: string; contentType: string | null }> {
  const response = await env.API.fetch(
    new Request(`${API_BASE}/v1/auth/me`, {
      headers: { Authorization: `Bearer ${token}` },
    }),
  );
  return {
    ok: response.ok,
    status: response.status,
    body: await response.text(),
    contentType: response.headers.get("Content-Type"),
  };
}

function redirectWithAuthError(url: URL, returnPath: string, reason: string, cookies: string[] = []): Response {
  const dest = new URL(returnPath, url.origin);
  dest.hash = `auth_error=${encodeURIComponent(reason)}`;
  return redirect(dest.toString(), 303, cookies);
}

function sameOriginPath(baseUrl: URL, raw: string | null): string {
  if (!raw) return "/";
  try {
    const parsed = new URL(raw, baseUrl.origin);
    if (parsed.origin !== baseUrl.origin) return "/";
    if (parsed.pathname === AUTH_PREFIX || parsed.pathname.startsWith(`${AUTH_PREFIX}/`)) return "/";
    return `${parsed.pathname}${parsed.search}${parsed.hash}`;
  } catch {
    return "/";
  }
}

function nonceMatches(request: Request, url: URL): boolean {
  const nonce = url.searchParams.get("nonce");
  if (!nonce) return false;
  return readCookie(request.headers.get("Cookie"), NONCE_COOKIE_NAME) === nonce;
}

function readCookie(header: string | null, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const [rawName, ...rawValue] = part.trim().split("=");
    if (rawName !== name) continue;
    try {
      return decodeURIComponent(rawValue.join("="));
    } catch {
      return null;
    }
  }
  return null;
}

function sessionCookie(token: string): string {
  return [
    `${COOKIE_NAME}=${encodeURIComponent(token)}`,
    `Max-Age=${SESSION_TTL_SECONDS}`,
    "Path=/",
    "Secure",
    "HttpOnly",
    "SameSite=Lax",
  ].join("; ");
}

function nonceCookie(nonce: string): string {
  return [
    `${NONCE_COOKIE_NAME}=${encodeURIComponent(nonce)}`,
    `Max-Age=${NONCE_TTL_SECONDS}`,
    "Path=/",
    "Secure",
    "HttpOnly",
    "SameSite=Lax",
  ].join("; ");
}

function clearNonceCookie(): string {
  return `${NONCE_COOKIE_NAME}=; Max-Age=0; Path=/; Secure; HttpOnly; SameSite=Lax`;
}

function clearSessionCookie(): string {
  return `${COOKIE_NAME}=; Max-Age=0; Path=/; Secure; HttpOnly; SameSite=Lax`;
}

function methodNotAllowed(): Response {
  return noStore(new Response("Method not allowed", { status: 405, headers: { Allow: "GET, POST" } }));
}

function json(body: unknown, status: number): Response {
  return noStore(Response.json(body, { status }));
}

function redirect(location: string, status: 302 | 303, cookies: string[] = []): Response {
  const headers = new Headers({ Location: location, "Cache-Control": "no-store" });
  for (const cookie of cookies) headers.append("Set-Cookie", cookie);
  return new Response(null, { status, headers });
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
