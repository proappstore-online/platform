import type { Env } from "./env.js";
import type { Route } from "./host.js";

export const AUTH_PREFIX = "/.pas/auth";
export const SESSION_COOKIE_NAME = "__Host-pas_session";
const NONCE_COOKIE_NAME = "__Host-pas_auth_nonce";
const API_BASE = "https://api.proappstore.online";
const SESSION_TTL_SECONDS = 30 * 24 * 60 * 60;
const NONCE_TTL_SECONDS = 10 * 60;
const PROVIDERS = new Set(["github", "google"]);

export async function handleAuthRoute(
  request: Request,
  env: Env,
  route: Route,
): Promise<Response | null> {
  const url = new URL(request.url);
  if (!url.pathname.startsWith(`${AUTH_PREFIX}/`) && url.pathname !== AUTH_PREFIX) return null;

  if (url.pathname === `${AUTH_PREFIX}/start`) return authStart(request, route);
  if (url.pathname === `${AUTH_PREFIX}/callback`) return authCallback(request, env);
  if (url.pathname === `${AUTH_PREFIX}/me`) return authMe(request, env);
  if (url.pathname === `${AUTH_PREFIX}/logout`) return authLogout(request);
  if (url.pathname === `${AUTH_PREFIX}/recover`) return authRecover(request);
  if (url.pathname === `${AUTH_PREFIX}/credentials/login`) return authCredentialsLogin(request, env);
  if (url.pathname === `${AUTH_PREFIX}/credentials/register`) return authCredentialsRegister(request, env);
  if (url.pathname === `${AUTH_PREFIX}/email/start`) return authEmailStart(request, env, route);

  return noStore(new Response("Not found", { status: 404 }));
}

function authStart(request: Request, route: Route): Response {
  if (request.method !== "GET") return methodNotAllowed("GET");
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
  if (request.method !== "GET") return methodNotAllowed("GET");
  const url = new URL(request.url);
  const returnPath = sameOriginPath(url, url.searchParams.get("return_to"));
  if (!nonceMatches(request, url)) {
    return redirectWithAuthError(url, returnPath, "invalid_state", [clearNonceCookie()]);
  }
  // SECURITY (#87): the backend hands back a one-time code, redeemed
  // server-to-server. It never puts a session token in the query string, where
  // it would reach CDN and edge access logs and browser history as a directly
  // reusable Bearer.
  //
  // Moving it to the fragment was never an option here: this callback IS the
  // server, and fragments are never sent to it. Reading one would need page JS,
  // which puts the token back in JS and defeats the HttpOnly cookie this
  // endpoint exists to set.
  //
  // The `?session=` fallback is gone as of phase 3. A stale link carrying one
  // now fails as a missing credential rather than being honoured.
  const code = url.searchParams.get("code");
  if (!code) return redirectWithAuthError(url, returnPath, "missing_session", [clearNonceCookie()]);
  const session = await exchangeCode(env.API, code);
  if (!session)
    return redirectWithAuthError(url, returnPath, "missing_session", [clearNonceCookie()]);

  const user = await fetchMe(env, session);
  if (!user.ok)
    return redirectWithAuthError(url, returnPath, "invalid_session", [clearNonceCookie()]);

  const dest = new URL(returnPath, url.origin);
  const headers = new Headers({
    Location: dest.toString(),
    "Cache-Control": "no-store",
  });
  headers.append("Set-Cookie", sessionCookie(session));
  headers.append("Set-Cookie", clearNonceCookie());
  return new Response(null, { status: 303, headers });
}

/**
 * Redeem a one-time login code for a session token, server-to-server (#87).
 *
 * Returns null on any failure — the caller turns that into the same
 * `missing_session` redirect a bad `?session=` produced, so a failed exchange
 * is indistinguishable from an absent credential.
 */
async function exchangeCode(api: Fetcher, code: string): Promise<string | null> {
  try {
    const response = await api.fetch(
      new Request(`${API_BASE}/v1/auth/code/exchange`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code }),
      }),
    );
    if (!response.ok) return null;
    const body = (await response.json()) as { token?: unknown };
    return typeof body.token === "string" && body.token ? body.token : null;
  } catch {
    return null;
  }
}

async function authMe(request: Request, env: Env): Promise<Response> {
  if (request.method !== "GET") return methodNotAllowed("GET");
  const token = readCookie(request.headers.get("Cookie"), SESSION_COOKIE_NAME);
  if (!token) return json({ error: "not signed in" }, 401);

  const upstream = await fetchMe(env, token);
  const headers = new Headers({
    "Cache-Control": "no-store",
    "Content-Type": upstream.contentType ?? "application/json; charset=utf-8",
  });
  if (!upstream.ok) headers.set("Set-Cookie", clearSessionCookie());
  return new Response(upstream.body, { status: upstream.status, headers });
}

async function authCredentialsLogin(request: Request, env: Env): Promise<Response> {
  if (request.method !== "POST") return methodNotAllowed("POST");
  if (!isSameOriginMutation(request)) return noStore(new Response("Forbidden", { status: 403 }));

  const body = (await request.json().catch(() => ({}))) as { login?: unknown; password?: unknown };
  const upstream = await env.API.fetch(
    new Request(`${API_BASE}/v1/auth/credentials/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        login: typeof body.login === "string" ? body.login : "",
        password: typeof body.password === "string" ? body.password : "",
      }),
    }),
  );
  if (!upstream.ok) return noStore(upstream);

  const sessionBody = (await upstream.json().catch(() => null)) as { token?: unknown } | null;
  const token = typeof sessionBody?.token === "string" && sessionBody.token ? sessionBody.token : "";
  if (!token) return noStore(Response.json({ error: "invalid session response" }, { status: 502 }));

  const user = await fetchMe(env, token);
  if (!user.ok) return noStore(new Response(user.body, {
    status: user.status,
    headers: user.contentType ? { "Content-Type": user.contentType } : undefined,
  }));

  const headers = new Headers({
    "Cache-Control": "no-store",
    "Content-Type": user.contentType ?? "application/json; charset=utf-8",
    "Set-Cookie": sessionCookie(token),
  });
  return new Response(user.body, { status: 200, headers });
}

// #118: self-registration, mediated so the app never talks to the API from JS.
// The API answers 202 for a new account AND for an already-registered address
// (no enumeration); no session is minted — the SDK signs in through
// /credentials/login next, which sets the cookie. Status and body pass through.
async function authCredentialsRegister(request: Request, env: Env): Promise<Response> {
  if (request.method !== "POST") return methodNotAllowed("POST");
  if (!isSameOriginMutation(request)) return noStore(new Response("Forbidden", { status: 403 }));

  const body = (await request.json().catch(() => ({}))) as { email?: unknown; password?: unknown; displayName?: unknown };
  const upstream = await env.API.fetch(
    new Request(`${API_BASE}/v1/auth/credentials/register`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        // The API rate-limits registration per client address; forward the visitor's.
        ...(request.headers.get("cf-connecting-ip") ? { "cf-connecting-ip": request.headers.get("cf-connecting-ip")! } : {}),
      },
      body: JSON.stringify({
        email: typeof body.email === "string" ? body.email : "",
        password: typeof body.password === "string" ? body.password : "",
        ...(typeof body.displayName === "string" ? { displayName: body.displayName } : {}),
      }),
    }),
  );
  return noStore(upstream);
}

async function authEmailStart(request: Request, env: Env, route: Route): Promise<Response> {
  if (request.method !== "POST") return methodNotAllowed("POST");
  if (!isSameOriginMutation(request)) return noStore(new Response("Forbidden", { status: 403 }));

  const url = new URL(request.url);
  const body = (await request.json().catch(() => ({}))) as { email?: unknown; returnTo?: unknown };
  const returnPath = sameOriginPath(url, typeof body.returnTo === "string" ? body.returnTo : null);
  const nonce = crypto.randomUUID();
  const callback = new URL(`${AUTH_PREFIX}/callback`, url.origin);
  callback.searchParams.set("return_to", returnPath);
  callback.searchParams.set("nonce", nonce);

  const upstream = await env.API.fetch(
    new Request(`${API_BASE}/v1/auth/email/start`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: typeof body.email === "string" ? body.email : "",
        appId: route.slug,
        returnTo: callback.toString(),
        responseMode: "query",
      }),
    }),
  );
  const response = noStore(upstream);
  if (upstream.ok) response.headers.append("Set-Cookie", nonceCookie(nonce));
  return response;
}

function authLogout(request: Request): Response {
  if (request.method !== "POST") return methodNotAllowed("POST");
  if (!isSameOriginMutation(request)) return noStore(new Response("Forbidden", { status: 403 }));
  return new Response(null, {
    status: 204,
    headers: {
      "Cache-Control": "no-store",
      // A custom host can retain a pre-cookie-auth PWA shell across deploys.
      // Logout is the explicit recovery boundary: clearing only Cache Storage
      // lets the next load fetch the current app without discarding preferences
      // or data from the host.
      "Clear-Site-Data": '"cache"',
      "Set-Cookie": clearSessionCookie(),
    },
  });
}

/**
 * A navigation-safe recovery route for stale app service workers. `/.pas/` is
 * excluded from the SPA navigation fallback, so even an obsolete PWA shell can
 * reach this endpoint and receive the cache/session reset response.
 */
function authRecover(request: Request): Response {
  if (request.method !== "GET") return methodNotAllowed("GET");
  const fetchSite = request.headers.get("Sec-Fetch-Site");
  if (fetchSite && fetchSite !== "same-origin" && fetchSite !== "none") {
    return noStore(new Response("Forbidden", { status: 403 }));
  }
  return new Response(null, {
    status: 303,
    headers: {
      Location: "/?recovered=1",
      "Cache-Control": "no-store",
      "Clear-Site-Data": '"cache"',
      "Set-Cookie": clearSessionCookie(),
    },
  });
}

export function isSameOriginMutation(request: Request): boolean {
  const url = new URL(request.url);
  const origin = request.headers.get("Origin");
  const fetchSite = request.headers.get("Sec-Fetch-Site");
  // Fail CLOSED: require a POSITIVE same-origin signal for state-changing
  // mediated requests. Browsers always send Origin on a mutating fetch and/or
  // Sec-Fetch-Site; accepting a request with neither (or Sec-Fetch-Site: none,
  // which is a user-initiated top-level nav, not an app fetch) would rest CSRF
  // defence entirely on the cookie's SameSite/__Host- scoping.
  if (origin) return origin === url.origin;
  if (fetchSite) return fetchSite === "same-origin";
  return false;
}

async function fetchMe(
  env: Env,
  token: string,
): Promise<{ ok: boolean; status: number; body: string; contentType: string | null }> {
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

function redirectWithAuthError(
  url: URL,
  returnPath: string,
  reason: string,
  cookies: string[] = [],
): Response {
  const dest = new URL(returnPath, url.origin);
  dest.hash = `auth_error=${encodeURIComponent(reason)}`;
  return redirect(dest.toString(), 303, cookies);
}

function sameOriginPath(baseUrl: URL, raw: string | null): string {
  if (!raw) return "/";
  try {
    const parsed = new URL(raw, baseUrl.origin);
    if (parsed.origin !== baseUrl.origin) return "/";
    if (parsed.pathname === AUTH_PREFIX || parsed.pathname.startsWith(`${AUTH_PREFIX}/`))
      return "/";
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

export function readCookie(header: string | null, name: string): string | null {
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

export function sessionCookie(token: string): string {
  return [
    `${SESSION_COOKIE_NAME}=${encodeURIComponent(token)}`,
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

export function clearSessionCookie(): string {
  return `${SESSION_COOKIE_NAME}=; Max-Age=0; Path=/; Secure; HttpOnly; SameSite=Lax`;
}

function methodNotAllowed(allow: string): Response {
  return noStore(new Response("Method not allowed", { status: 405, headers: { Allow: allow } }));
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
