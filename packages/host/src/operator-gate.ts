/**
 * Operator gate (#229, part of #228) — an app declares `operator: { prefix, role }`
 * in its mcp.json, and the host serves paths under that prefix only to a
 * signed-in user who holds that app role.
 *
 * The check runs before the edge cache and the R2 lookup, and gated responses
 * are never edge-cached, so an operator bundle can never be replayed to someone
 * the gate would refuse. Roles are asked of the backend on every request (the
 * same session-forwarding the /.pas/api mediation does), so revoking the role
 * denies the next request.
 *
 * This protects the operator *bundle*. It is not the data boundary: operator
 * data still has to come from registered actions gated by `auth.app_roles`.
 */
import { clearSessionCookie, readCookie, SESSION_COOKIE_NAME } from "./auth-handler.js";
import type { Env } from "./env.js";
import type { Route } from "./host.js";

const API_BASE = "https://api.proappstore.online";

export interface OperatorGate {
  prefix: string;
  role: string;
}

/**
 * The app's declared gate, or null when it declares none. A missing table means
 * the migration has not reached this database yet, so nothing can have been
 * declared; any other error throws — failing the request closed rather than
 * serving a possibly-gated path ungated.
 */
export async function getOperatorGate(db: D1Database, appId: string): Promise<OperatorGate | null> {
  try {
    const row = await db
      .prepare("SELECT path_prefix, role_name FROM app_operator_gate WHERE app_id = ?1")
      .bind(appId)
      .first<{ path_prefix: string; role_name: string }>();
    return row ? { prefix: row.path_prefix, role: row.role_name } : null;
  } catch (e) {
    if (/no such table/i.test(String((e as Error)?.message ?? e))) return null;
    throw e;
  }
}

/**
 * Whether `pathname` is under `prefix`. Leading slashes are collapsed first:
 * the R2 key strips them (`r2KeyFor`), so `//admin/x.js` addresses the same
 * object as `/admin/x.js` and must be gated the same.
 */
export function isUnderPrefix(pathname: string, prefix: string): boolean {
  const path = `/${pathname.replace(/^\/+/, "")}`;
  return path === prefix || path.startsWith(`${prefix}/`);
}

/**
 * Null when the caller holds the gate's role; otherwise the refusal. No session
 * (or one the backend rejects) sends a navigation to sign-in and anything else a
 * 403; a signed-in caller without the role gets 403; a failed role lookup is a
 * 503, never an allow.
 */
export async function refuseUnlessOperator(request: Request, env: Env, route: Route, gate: OperatorGate): Promise<Response | null> {
  const token = readCookie(request.headers.get("Cookie"), SESSION_COOKIE_NAME);
  if (!token) return signInOrForbidden(request);

  const res = await env.API.fetch(
    new Request(`${API_BASE}/v1/apps/${route.slug}/roles/me`, {
      headers: { Authorization: `Bearer ${token}`, "X-PAS-App": route.slug },
    }),
  );
  if (res.status === 401) {
    // The backend is the session authority (as in platform-mediation.ts): clear it.
    const refusal = signInOrForbidden(request);
    refusal.headers.append("Set-Cookie", clearSessionCookie());
    return refusal;
  }
  if (!res.ok) return refusal(503, "Authorization unavailable");

  const body = (await res.json().catch(() => null)) as { roles?: unknown } | null;
  const roles = Array.isArray(body?.roles) ? body.roles : [];
  if (!roles.includes(gate.role)) return refusal(403, "Forbidden");
  return null;
}

function signInOrForbidden(request: Request): Response {
  const url = new URL(request.url);
  const navigation =
    request.method === "GET" &&
    (request.headers.get("Sec-Fetch-Mode") === "navigate" || (request.headers.get("Accept") ?? "").includes("text/html"));
  if (!navigation) return refusal(403, "Forbidden");
  const start = new URL("/.pas/auth/start", url.origin);
  start.searchParams.set("return_to", `${url.pathname}${url.search}`);
  return new Response(null, { status: 302, headers: { Location: start.toString(), "Cache-Control": "no-store" } });
}

function refusal(status: number, text: string): Response {
  return new Response(text, { status, headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" } });
}
