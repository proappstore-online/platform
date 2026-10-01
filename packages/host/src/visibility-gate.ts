/**
 * Private apps (#259, part of #251) — an app declares
 * `visibility: { mode: "private", roles: [...] }` in its mcp.json, and the host
 * serves its WHOLE origin — `/`, every asset, /.pas/api/* and /.pas/data/* —
 * only to the app's team (creator, team members, platform admins) and to
 * holders of one of those app roles. /.pas/auth/* (sign-in, the platform
 * sign-in and invite pages, passkeys) stays reachable: the gate runs after it,
 * or nobody could ever sign in to pass it.
 *
 * The data-<app> hostname is NOT gated here: every SQL route on the data worker
 * already requires a team role of developer or above, which is a subset of who
 * a private app admits, and the worker is reachable at its own custom domain
 * anyway — a host check would cost every app a D1 read for no protection.
 *
 * Same shape as the operator gate (operator-gate.ts, #229): checked before the
 * edge cache and R2, and nothing on a private app is ever edge-cached, so a
 * response can never be replayed to someone the gate would refuse. Unlike the
 * operator gate it asks `visibility/me`, not `roles/me`: the owner always
 * passes, and `roles/me` does not report ownership.
 *
 * Signed out, a navigation goes to the PLATFORM sign-in page
 * (/.pas/auth/signin, auth-pages.ts), which offers every sign-in method the
 * platform has — never straight to GitHub, which would shut out everyone
 * without a GitHub account. A signed-in caller who is refused on an invite link
 * (`/join/<code>`, the link routes/invites.ts mints) goes to the platform
 * invite page (/.pas/auth/join), which redeems the code and sends them back.
 *
 * Cost. On an app origin the visibility mode rides on the route lookup
 * (host.ts LEFT JOINs app_visibility), so a public app pays nothing extra — no
 * D1 read, no backend call. A private app asks the backend (visibility/me),
 * and the answer is remembered per isolate, keyed by SHA-256(token) + app: an
 * ALLOW for ALLOW_CACHE_TTL_MS, so a page's assets do not each cost a backend
 * round trip, and a REFUSAL (refused, or a session the backend rejects) for
 * REFUSAL_CACHE_TTL_MS, so a refused or bogus session hammering a private app
 * costs one backend call per window rather than one per request. "Lookup
 * failed" is never cached.
 *
 * Propagation bound: a public→private flip takes effect on the next request
 * (the route lookup is live D1, and nothing on a private app is edge-cached).
 * Revoking a role, removing a team member or signing out of a private app can
 * leave an isolate serving that session for up to ALLOW_CACHE_TTL_MS (30 s); a
 * newly granted role can take up to REFUSAL_CACHE_TTL_MS (5 s) to be seen —
 * except an invite redeemed through /.pas/auth/join, which clears this
 * isolate's entry at once.
 */
import { clearSessionCookie, readCookie, SESSION_COOKIE_NAME } from "./auth-handler.js";
import type { Env } from "./env.js";

const API_BASE = "https://api.proappstore.online";

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
  if (answer === "allowed") return null;
  // Signed in but not admitted. On an invite link, the platform invite page can
  // redeem the code — the app's own /join page is behind this very gate.
  const invite = isNavigation(request) ? inviteCodeFromPath(new URL(request.url).pathname) : null;
  if (invite) return redirectTo(request, "/.pas/auth/join", { code: invite });
  return refusal(403, "Forbidden");
}

/** The invite code in an app-origin invite link (`/join/<code>`, routes/invites.ts), or null. */
export function inviteCodeFromPath(pathname: string): string | null {
  const m = /^\/join\/([A-Za-z0-9]{4,32})\/?$/.exec(pathname);
  return m ? m[1]!.toUpperCase() : null;
}

/** How long an isolate remembers that a session may use a private app. See the module comment. */
export const ALLOW_CACHE_TTL_MS = 30_000;
/**
 * How long an isolate remembers that a session may NOT (refused, or rejected
 * as invalid). Short — it only has to blunt a flood — and never longer than
 * the propagation bound docs/authorization-model.md documents for a grant.
 */
export const REFUSAL_CACHE_TTL_MS = 5_000;
const VISIBILITY_CACHE_MAX = 1000;
type Answer = "allowed" | "refused" | "invalid-session" | "unavailable";
const visibilityCache = new Map<string, { answer: Exclude<Answer, "unavailable">; until: number }>();

async function visibilityCacheKey(appId: string, token: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `${appId}\u0000${hex}`;
}

/** Test seam: forget every remembered answer. */
export function clearVisibilityAllowCache(): void {
  visibilityCache.clear();
}

/** Forget this isolate's answer for one session on one app — after an invite is redeemed, so the grant is seen at once. */
export async function forgetVisibility(appId: string, token: string): Promise<void> {
  visibilityCache.delete(await visibilityCacheKey(appId, token));
}

async function askVisibility(env: Env, appId: string, token: string): Promise<Answer> {
  const key = await visibilityCacheKey(appId, token);
  const cached = visibilityCache.get(key);
  if (cached !== undefined) {
    if (cached.until > Date.now()) return cached.answer;
    visibilityCache.delete(key);
  }
  const answer = await askBackend(env, appId, token);
  if (answer !== "unavailable") {
    // Bounded: drop the oldest entry (Map keeps insertion order) rather than grow without limit.
    if (visibilityCache.size >= VISIBILITY_CACHE_MAX) visibilityCache.delete(visibilityCache.keys().next().value as string);
    visibilityCache.set(key, { answer, until: Date.now() + (answer === "allowed" ? ALLOW_CACHE_TTL_MS : REFUSAL_CACHE_TTL_MS) });
  }
  return answer;
}

/** The backend's answer, uncached — for the invite page, right after a redemption. */
export async function askVisibilityFresh(env: Env, appId: string, token: string): Promise<Answer> {
  await forgetVisibility(appId, token);
  return askVisibility(env, appId, token);
}

async function askBackend(env: Env, appId: string, token: string): Promise<Answer> {
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

function isNavigation(request: Request): boolean {
  return (
    request.method === "GET" &&
    (request.headers.get("Sec-Fetch-Mode") === "navigate" || (request.headers.get("Accept") ?? "").includes("text/html"))
  );
}

/**
 * Signed out: a navigation goes to the platform sign-in page, which offers
 * every method the platform supports (not just GitHub); anything else is 403.
 */
function signInOrForbidden(request: Request): Response {
  if (!isNavigation(request)) return refusal(403, "Forbidden");
  const url = new URL(request.url);
  return redirectTo(request, "/.pas/auth/signin", { return_to: `${url.pathname}${url.search}` });
}

function redirectTo(request: Request, path: string, params: Record<string, string>): Response {
  const target = new URL(path, new URL(request.url).origin);
  for (const [k, v] of Object.entries(params)) target.searchParams.set(k, v);
  return new Response(null, { status: 302, headers: { Location: target.toString(), "Cache-Control": "no-store", "X-PAS-Visibility": "private" } });
}

/**
 * Every visibility refusal carries `X-PAS-Visibility: private`, so a health
 * probe (MCP app_info) can tell "private, sign in" from "down". The app's
 * privacy is already evident from the refusal itself; the header adds nothing.
 */
function refusal(status: number, text: string): Response {
  return new Response(text, { status, headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store", "X-PAS-Visibility": "private" } });
}
