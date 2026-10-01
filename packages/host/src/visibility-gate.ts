/**
 * Private apps (#259, part of #251) — an app declares
 * `visibility: { mode: "private", roles: [...] }` in its mcp.json, and the host
 * serves its WHOLE origin — `/`, every asset, /.pas/api/*, /.pas/data/* and the
 * data-<app> hostname — only to the app's team (creator, team members,
 * platform admins) and to holders of one of those app roles. /.pas/auth/* (sign-in, passkeys) stays reachable: the gate runs
 * after it, or nobody could ever sign in to pass it.
 *
 * Same shape as the operator gate (operator-gate.ts, #229): checked before the
 * edge cache and R2, and nothing on a private app is ever edge-cached, so a
 * response can never be replayed to someone the gate would refuse. Unlike the
 * operator gate it asks `visibility/me`, not `roles/me`: the owner always
 * passes, and `roles/me` does not report ownership.
 *
 * Cost. On an app origin the visibility mode rides on the route lookup
 * (host.ts LEFT JOINs app_visibility), so a public app pays nothing extra — no
 * D1 read, no backend call. The data-<app> hostname has no route lookup, so it
 * pays one indexed D1 read (isPrivateApp). A private app asks the backend
 * (visibility/me), and an ALLOW is remembered per isolate for
 * ALLOW_CACHE_TTL_MS keyed by SHA-256(token) + app, so a page's assets do not
 * each cost a backend round trip. Refusals are never cached.
 *
 * Propagation bound: a public→private flip takes effect on the next request
 * (the route lookup is live D1, and nothing on a private app is edge-cached).
 * Revoking a role, removing a team member or signing out of a private app can
 * leave an isolate serving that session for up to ALLOW_CACHE_TTL_MS (30 s).
 */
import { clearSessionCookie, readCookie, SESSION_COOKIE_NAME } from "./auth-handler.js";
import type { Env } from "./env.js";

const API_BASE = "https://api.proappstore.online";

/**
 * Whether the app is declared private. A missing table means the migration has
 * not reached this database, so nothing can have been declared; any other error
 * throws — failing the request closed rather than serving a private app.
 */
export async function isPrivateApp(db: D1Database, appId: string): Promise<boolean> {
  try {
    const row = await db
      .prepare("SELECT mode FROM app_visibility WHERE app_id = ?1")
      .bind(appId)
      .first<{ mode: string }>();
    return row?.mode === "private";
  } catch (e) {
    if (/no such table/i.test(String((e as Error)?.message ?? e))) return false;
    throw e;
  }
}

/**
 * Null when the caller may use the private app; otherwise the refusal. No
 * session (or one the backend rejects) sends a navigation to sign-in and
 * anything else a 403; a signed-in caller who is not allowed gets 403; a failed
 * lookup is a 503, never an allow.
 */
export async function refuseUnlessVisible(request: Request, env: Env, appId: string): Promise<Response | null> {
  const token = readCookie(request.headers.get("Cookie"), SESSION_COOKIE_NAME);
  if (!token) return signInOrForbidden(request);

  const answer = await askVisibility(env, appId, token);
  if (answer === "invalid-session") {
    // The backend is the session authority (as in platform-mediation.ts): clear it.
    const refusal = signInOrForbidden(request);
    refusal.headers.append("Set-Cookie", clearSessionCookie());
    return refusal;
  }
  if (answer === "unavailable") return refusal(503, "Authorization unavailable");
  return answer === "allowed" ? null : refusal(403, "Forbidden");
}

/**
 * The same check for the data-<app> hostname, which browsers call with a Bearer
 * rather than the app-origin cookie. It is an API, so a refusal is never a
 * sign-in redirect. CORS preflights carry no credential and run nothing; they
 * pass through to the data worker unchanged.
 */
export async function refuseDataUnlessVisible(request: Request, env: Env, appId: string): Promise<Response | null> {
  if (request.method === "OPTIONS") return null;
  const header = request.headers.get("Authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  if (!token) return refusal(401, "Unauthorized");
  const answer = await askVisibility(env, appId, token);
  if (answer === "invalid-session") return refusal(401, "Unauthorized");
  if (answer === "unavailable") return refusal(503, "Authorization unavailable");
  return answer === "allowed" ? null : refusal(403, "Forbidden");
}

/** How long an isolate remembers that a session may use a private app. See the module comment. */
export const ALLOW_CACHE_TTL_MS = 30_000;
const ALLOW_CACHE_MAX = 1000;
const allowCache = new Map<string, number>();

async function allowCacheKey(appId: string, token: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `${appId}\u0000${hex}`;
}

/** Test seam: forget every remembered allow. */
export function clearVisibilityAllowCache(): void {
  allowCache.clear();
}

async function askVisibility(env: Env, appId: string, token: string): Promise<"allowed" | "refused" | "invalid-session" | "unavailable"> {
  const key = await allowCacheKey(appId, token);
  const until = allowCache.get(key);
  if (until !== undefined) {
    if (until > Date.now()) return "allowed";
    allowCache.delete(key);
  }
  const answer = await askBackend(env, appId, token);
  if (answer === "allowed") {
    // Bounded: drop the oldest entry (Map keeps insertion order) rather than grow without limit.
    if (allowCache.size >= ALLOW_CACHE_MAX) allowCache.delete(allowCache.keys().next().value as string);
    allowCache.set(key, Date.now() + ALLOW_CACHE_TTL_MS);
  }
  return answer;
}

async function askBackend(env: Env, appId: string, token: string): Promise<"allowed" | "refused" | "invalid-session" | "unavailable"> {
  let res: Response;
  try {
    res = await env.API.fetch(
      new Request(`${API_BASE}/v1/apps/${appId}/visibility/me`, {
        headers: { Authorization: `Bearer ${token}`, "X-PAS-App": appId },
      }),
    );
  } catch {
    return "unavailable";
  }
  if (res.status === 401) return "invalid-session";
  if (!res.ok) return "unavailable";
  const body = (await res.json().catch(() => null)) as { allowed?: unknown } | null;
  return body?.allowed === true ? "allowed" : "refused";
}

function signInOrForbidden(request: Request): Response {
  const url = new URL(request.url);
  const navigation =
    request.method === "GET" &&
    (request.headers.get("Sec-Fetch-Mode") === "navigate" || (request.headers.get("Accept") ?? "").includes("text/html"));
  if (!navigation) return refusal(403, "Forbidden");
  const start = new URL("/.pas/auth/start", url.origin);
  start.searchParams.set("return_to", `${url.pathname}${url.search}`);
  return new Response(null, { status: 302, headers: { Location: start.toString(), "Cache-Control": "no-store", "X-PAS-Visibility": "private" } });
}

/**
 * Every visibility refusal carries `X-PAS-Visibility: private`, so a health
 * probe (MCP app_info) can tell "private, sign in" from "down". The app's
 * privacy is already evident from the refusal itself; the header adds nothing.
 */
function refusal(status: number, text: string): Response {
  return new Response(text, { status, headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store", "X-PAS-Visibility": "private" } });
}
