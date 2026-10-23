import { DurableObject } from "cloudflare:workers";
import { serveMcp } from "./transport.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { CfWorkerJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/cfworker-provider.js";
import type { Env } from "./env.js";
import { mcpIssuer } from "./env.js";
import { extractToken, fetchAccount, verifyToken } from "./api-helpers.js";
import { verifySession } from "./session.js";
import { listAuditEvents } from "./safety.js";
import { registerPlatformTools } from "./platform-tools.js";
import { fetchVisibleTools, registerAppDiscoveryTools, registerAppToolsProgressive } from "./tool-loader.js";
import { registerProjectTools } from "./project-tools.js";
import { handleInternalProvisioning } from "./provisioning-workflow.js";
import { registerLoopTools } from "./loop-tools.js";
import { registerAgentsTools } from "./agents-tools.js";
import { registerQaTools } from "./qa-tools.js";
import { registerAdminConsoleTools } from "./admin-console-tools.js";
import { registerOwnershipTools } from "./ownership-tools.js";
import { registerDirectoryTools } from "./directory-tools.js";
import { registerOidcSessionTools } from "./oidc-session-tools.js";
import { installToolMetadata } from "./tool-metadata.js";
import { createAuthChallenge } from "./oauth-provider.js";
export { OAuthState } from "./oauth-state.js";

/** Build a fresh server for each authenticated HTTP request. No identity or app scope
 * is retained in a transport session after a token refresh or account change. */
export async function createPasMcpServer(env: Env, props: Record<string, unknown>) {
  const server = new McpServer({ name: "ProAppStore", version: "0.3.0" }, { jsonSchemaValidator: new CfWorkerJsonSchemaValidator() });
  installToolMetadata(server);
  let userId: string | null = null;
  let userLogin: string | null = null;
  let userToken: string | null = null;
  let userRoles: string[] = [];
  let appScope: string | null = null;

  // The transport verifies every request, then supplies only that request's
  // connection identity. A reused session id cannot select another account.
  const token = extractToken(props as Record<string, unknown>);
  appScope = extractAppScope(props as Record<string, unknown>);
  if (token && env.SESSION_SIGNING_KEY) {
    const user = await verifyToken(env.SESSION_SIGNING_KEY, token);
    if (user) {
      userId = user.id;
      userLogin = user.login;
      userToken = token;
      // Platform roles from this request's verified session claims power the
      // app-tool pre-flight role check in tool-loader.
      const claims = await verifySession(token, env.SESSION_SIGNING_KEY);
      userRoles = claims?.roles ?? [];
    }
  }

  if (!appScope) {
    // ── Platform-info tools (list_apps, deploy_status, app_info, ─
    //    platform_guide, sdk_reference, recipe) ─────────────────
    registerPlatformTools(server, env, () => userToken);

    // ── App-tool discovery for the shared endpoint (#157) ───────
    //    list_app_tools(app_id) → call_app_tool(app_id, tool, params).
    //    The shared session registers NO app tools (see below), so its
    //    size is fixed (src/tool-count.ts) however many apps exist.
    registerAppDiscoveryTools(
      server,
      () => ({ userId: userId, token: userToken, roles: userRoles }),
      env.API,
      env.API_BASE,
      env,
    );

    // ── Project-building tools (for AI agent app creation) ─────
    registerProjectTools(server, env, () => ({
      userId: userId,
      login: userLogin,
      token: userToken,
      roles: userRoles,
    }));

    // ── Agent Teams loop tools (create app, KB, chat PO/Architect, ─
    //    tickets, agents, play/pause) — drive the whole build over MCP ─
    //    Every tool uses this request's authenticated connection identity.
    registerLoopTools(server, env, () => userToken);

    // ── Agent-team introspection tools ──────────────────────────
    registerAgentsTools(
      server,
      () => ({ userId: userId, token: userToken }),
      env.INTERNAL_TOKEN ?? null,
      env.AGENTS_BASE,
      env.AGENTS,
    );

    // ── QA automation tools (connect + write/run browser e2e tests) ─
    registerQaTools(server, env, () => ({
      userId: userId,
      token: userToken,
    }));

    // ── Admin-console authoring, read-only (#295): inspect, capabilities, preview ─
    registerAdminConsoleTools(server, env, () => ({
      userId: userId,
      token: userToken,
    }));

    // ── App ownership transfer and recovery (#423) ──────────────
    registerOwnershipTools(server, env, () => ({
      userId: userId,
      token: userToken,
    }));

    // ── App directory discovery, read-only (#424) ───────────────
    registerDirectoryTools(server, env, () => ({
      userId: userId,
      token: userToken,
    }));

    // ── Platform-admin GitHub Actions OIDC e2e grants (#475) ───
    registerOidcSessionTools(server, env, () => ({
      userId: userId,
      token: userToken,
    }));
  }

  // ── App tools: ONLY on an app-scoped session (#157) ─────────
  //    /mcp/apps/<app_id> registers that app's tools under their manifest
  //    names. The shared /mcp never fetches or registers app tools — it
  //    used to load every app's tools for every connection (824 tools,
  //    485 KB of tools/list), and that is what list_app_tools replaces.
  //    Large manifests (#117): above PROGRESSIVE_DISCLOSURE_THRESHOLD_BYTES only
  //    a resident core is registered, plus list_app_tools / call_app_tool fixed to
  //    this app — the rest is one discovery call away and callable by name.
  if (appScope) {
    const appTools = await fetchVisibleTools(env.API, env.API_BASE, appScope, userToken);
    const result = registerAppToolsProgressive(
      server,
      appTools,
      appScope,
      () => ({ userId: userId, token: userToken, roles: userRoles }),
      env.API,
      env.API_BASE,
      env,
    );
    if (result.registered.length > 0) {
      console.log(`Registered ${result.registered.length} app tool(s) for ${appScope} (${result.mode}, ${result.total} in manifest): ${result.registered.join(', ')}`);
    } else {
      console.log(`No app tools registered for scoped MCP app: ${appScope}`);
    }
  }

  // ── Identity: whoami ───────────────────────────────────────
  server.tool(
    "whoami",
    "Show the account this MCP connection is authenticated as — PAS user id, login, email address, sign-in provider, platform roles, and token expiry. Use to confirm which account you're acting as before running owner-scoped tools, or to answer which email the account is tied to.",
    {},
    async () => {
      if (!userToken || !env.SESSION_SIGNING_KEY) {
        return { content: [{ type: "text" as const, text: "Not authenticated: this MCP connection has no valid PAS session. Owner-scoped tools will be denied." }] };
      }
      const payload = await verifySession(userToken, env.SESSION_SIGNING_KEY);
      if (!payload) {
        return { content: [{ type: "text" as const, text: "Session token present but invalid or expired. Re-authenticate the MCP connection." }] };
      }
      const login = (payload as { login?: string }).login;
      // #121: the per-app roles line is gone with the `appRoles` claim. It
      // always printed "(no per-app roles)" — nothing ever populated it — and
      // app roles now live only in the `app_roles` table, read at the point of
      // use so a revocation takes effect immediately. tool-loader.ts already
      // declined to enforce them here for the same staleness reason.
      //
      // #136: email and provider are NOT in the session token — SessionClaims
      // is uid/login/avatarUrl/roles by design — so they need the API. The
      // call is best-effort: a failure costs the two extra lines, not whoami.
      const account = await fetchAccount(
        env.API,
        env.API_BASE,
        userToken,
        env.INTERNAL_TOKEN,
      );

      const lines = [
        appScope ? `Authenticated for app-scoped MCP: ${appScope}` : "Authenticated as:",
        `  uid:       ${payload.uid}`,
        ...(login ? [`  login:     ${login}`] : []),
      ];
      if (account) {
        lines.push(`  provider:  ${account.providerLabel}`);
        if (account.email) {
          // A credential_email is a sign-in identifier we never send to, so it
          // must not be presented as a confirmed contact address (0042).
          lines.push(`  email:     ${account.email}${account.emailVerified ? "" : "  (unverified — a sign-in identifier, not a confirmed address)"}`);
        } else if (account.accountType === "child") {
          lines.push("  email:     (none — child accounts never store an address)");
        } else {
          lines.push("  email:     (none on file)");
        }
      }
      lines.push(
        `  roles:     ${(payload.roles ?? []).join(", ") || "(none)"}`,
        `  expires:   ${new Date(payload.exp * 1000).toISOString()}`,
      );
      if (!account) {
        lines.push(
          "",
          "Email and sign-in provider are unavailable — the connector could not reach the account endpoint. The identity above is read from the session token itself.",
        );
      }
      return { content: [{ type: "text" as const, text: lines.join("\n") }] };
    },
  );

  // ── Safety: audit-log reader ───────────────────────────────
  server.tool(
    "mcp_audit_log",
    "Read recent MCP audit events (mutating tool invocations + read-only denials) attributed to your authenticated account. Newest first.",
    { limit: z.number().optional().describe("Max events to return (1-200, default 50).") },
    async ({ limit }) => {
      const events = await listAuditEvents({ env: env, subject: userId }, limit ?? 50);
      if (events.length === 0) {
        return { content: [{ type: "text" as const, text: "No audit events recorded for your account." }] };
      }
      return { content: [{ type: "text" as const, text: `${events.length} event(s):\n\n${JSON.stringify(events, null, 2)}` }] };
    },
  );
  return server;
}

/** Retained for the existing Durable Object binding; new HTTP traffic is stateless. */
export class PasMcpAgent extends DurableObject<Env> {
  props: Record<string, unknown> = {};
  server = new McpServer({ name: "ProAppStore", version: "0.3.0" }, { jsonSchemaValidator: new CfWorkerJsonSchemaValidator() });
  async init() {
    this.server = await createPasMcpServer(this.env, this.props as Record<string, unknown>);
  }
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    const url = new URL(request.url);
    const issuer = mcpIssuer(env);
    const authority = env.OAUTH_STATE?.get(env.OAUTH_STATE.idFromName("authority"));
    const origin = request.headers.get("Origin");
    if (resolveMcpRoute(url.pathname).isTransport && origin &&
        origin !== issuer && !(env.MCP_ALLOWED_ORIGINS ?? "").split(",").map((v) => v.trim()).includes(origin)) {
      return new Response("Forbidden origin", { status: 403, headers: { "Cache-Control": "no-store" } });
    }

    // API-worker-only credential issuance for the remote approval broker.
    // This is before public OAuth routing and is unavailable without the
    // existing service-to-service secret. It returns an opaque MCP token only.
    if (url.pathname === "/internal/broker/issue" && request.method === "POST") {
      if (!env.INTERNAL_TOKEN || request.headers.get("X-Internal-Token") !== env.INTERNAL_TOKEN) {
        return new Response("not found", { status: 404 });
      }
      let input: { session?: unknown; owner_id?: unknown; resource?: unknown; request_id?: unknown };
      try { input = await request.json(); } catch { return new Response("invalid request", { status: 400 }); }
      if (typeof input.session !== "string" || typeof input.owner_id !== "string" || typeof input.resource !== "string" || typeof input.request_id !== "string") {
        return new Response("invalid request", { status: 400 });
      }
      if (!authority || !env.SESSION_SIGNING_KEY) return new Response("OAuth unavailable", { status: 503 });
      const token = await authority.issueBroker(issuer, {
        session: input.session, ownerId: input.owner_id, resource: input.resource, requestId: input.request_id,
      });
      if (!token) return new Response("forbidden", { status: 403 });
      return Response.json({ access_token: token }, { headers: { "Cache-Control": "no-store" } });
    }

    // The API broker asks this over the same authenticated service binding
    // before accepting a machine's `connected` acknowledgement.  The marker is
    // written only after this worker served a successful authenticated MCP
    // transport request with that broker credential.
    if (url.pathname.startsWith("/internal/broker/read-receipt/") && request.method === "GET") {
      if (!env.INTERNAL_TOKEN || request.headers.get("X-Internal-Token") !== env.INTERNAL_TOKEN) {
        return new Response("not found", { status: 404 });
      }
      const requestId = decodeURIComponent(url.pathname.slice("/internal/broker/read-receipt/".length));
      if (!/^req_[A-Za-z0-9_-]{43}$/.test(requestId)) return new Response("not found", { status: 404 });
      if (!authority) return new Response("OAuth unavailable", { status: 503 });
      return Response.json({ seen: await authority.readSeen(requestId) }, { headers: { "Cache-Control": "no-store" } });
    }

    // #457: an account's OAuth grants for one app endpoint, listed and revoked by
    // the API worker for the Creator Console. Same service-binding gate as the
    // broker routes; the API worker supplies the uid from the caller's session.
    const grantsList = url.pathname.match(/^\/internal\/users\/([^/]+)\/apps\/([a-z][a-z0-9-]{0,57})\/grants$/);
    const grantsOne = url.pathname.match(/^\/internal\/users\/([^/]+)\/grants\/([A-Za-z0-9-]{8,64})$/);
    if ((grantsList && request.method === "GET") || (grantsOne && request.method === "DELETE")) {
      if (!env.INTERNAL_TOKEN || request.headers.get("X-Internal-Token") !== env.INTERNAL_TOKEN || !authority) {
        return new Response("not found", { status: 404 });
      }
      const headers = { "Cache-Control": "no-store" };
      let uid: string;
      try { uid = decodeURIComponent((grantsList ?? grantsOne)![1]!); } catch { return new Response("not found", { status: 404 }); }
      if (grantsList) return Response.json({ grants: await authority.grants(uid, grantsList[2]!) }, { headers });
      const revoked = await authority.revoke(uid, grantsOne![2]!);
      return revoked ? Response.json({ revoked: true }, { headers }) : new Response("not found", { status: 404, headers });
    }

    // #367: the Creator Console's provisioning preview/confirm, reached only
    // through the API worker's service binding with INTERNAL_TOKEN; the user is
    // the PAS session it forwards, verified again inside.
    const provisioning = await handleInternalProvisioning(request, env);
    if (provisioning) return provisioning;

    // All OAuth state transitions run in a strongly consistent authority. Do
    // not silently fall back to eventually consistent KV when a binding is missing.
    if (/^\/(?:\.well-known\/oauth-|register$|authorize(?:\/continue)?$|oauth\/callback$|token$|revoke$)/.test(url.pathname)) {
      if (!authority || !env.SESSION_SIGNING_KEY) return new Response("OAuth unavailable", { status: 503 });
      return authority.fetch(request);
    }

    if (url.pathname === "/" || url.pathname === "") {
      if (isProtocolClient(request)) return wrongEndpoint();
      return new Response(
        "ProAppStore MCP Server\n\nShared platform endpoint: npx mcp-remote https://mcp.proappstore.online/mcp\nApp-scoped endpoint: npx mcp-remote https://mcp.proappstore.online/mcp/apps/<app-id>\n\nPlatform tools on /mcp: list_apps, deploy_status, schema_status, app_info, platform_guide, sdk_reference, recipe, list_app_tools, call_app_tool\nProject tools on /mcp: provision_pas_app, scaffold_app, write_file, read_file, list_files, delete_file, search_files, batch_write_files, add_marketing_site, get_deploy_status, provision_app\nAgent Teams loop on /mcp: create_app, list_projects, get_project, build_knowledge_base, chat_agent, list_tickets, list_agents, get_project_files, set_project_running, set_project_budget, run_tests, set_model, add_ticket\nAgent introspection on /mcp: agent_project_status, agent_board, agent_activity, agent_ticket_detail, agent_cost\nApp tools: only on /mcp/apps/<app-id>, under their manifest names. A large manifest (over 40 KB of tools/list) pre-loads a core of up to 10 tools plus list_app_tools / call_app_tool scoped to that app; the rest is one discovery call away. From /mcp, list one app's tools with list_app_tools(app_id) and call one with call_app_tool(app_id, tool, params).\nIdentity: whoami (show the authenticated PAS account — uid, login, email, sign-in provider, roles).\nSafety: mcp_audit_log (per-account audit trail). Mutating tools are audited; destructive tools (provision_pas_app, scaffold_app, delete_file, publish_app) require confirm: true; expensive/irreversible tools accept dry_run: true to preview; set MCP_READ_ONLY=1 to block all writes.\n",
        { headers: { "content-type": "text/plain" } }
      );
    }

    // Resolve OAuth token → PAS session, verify it, then lift into ctx.props.
    const auth = request.headers.get("Authorization");
    let bearer = auth?.replace(/^Bearer\s+/i, "");
    let oauthToken:
      | { appId: string | null; bound: boolean; brokerRequestId: string | null }
      | null = null;
    if (bearer && authority) {
      try {
        const resolved = await authority.resolveToken(bearer);
        if (resolved) {
          bearer = resolved.session;
          oauthToken = { appId: resolved.appId, bound: resolved.bound, brokerRequestId: resolved.brokerRequestId ?? null };
        }
      } catch (e) {
        console.warn("MCP OAuth authority unavailable");
        return new Response("OAuth unavailable", { status: 503, headers: { "Retry-After": "5", "Cache-Control": "no-store" } });
      }
    }
    let user: { id: string; login: string } | null = null;
    if (bearer && oauthToken && env.SESSION_SIGNING_KEY) {
      try {
        user = await verifyToken(env.SESSION_SIGNING_KEY, bearer);
      } catch (e) {
        console.warn(`MCP bearer verification failed: ${e instanceof Error ? e.message : String(e)}`);
        user = null;
      }
    }

    const mcpRoute = resolveMcpRoute(url.pathname);
    if (mcpRoute.error) {
      return new Response(mcpRoute.error, { status: mcpRoute.status });
    }
    if (
      mcpRoute.isTransport &&
      request.method !== "OPTIONS" &&
      oauthToken &&
      (!oauthToken.bound || oauthToken.appId !== mcpRoute.appScope)
    ) {
      return createAuthChallenge({ issuer, appId: mcpRoute.appScope }, "invalid_token");
    }
    if (mcpRoute.isTransport && request.method !== "OPTIONS" && (!env.SESSION_SIGNING_KEY || !authority)) {
      return new Response("MCP authentication unavailable", { status: 503 });
    }
    if (mcpRoute.isTransport && request.method !== "OPTIONS" && !user) {
      return createAuthChallenge({ issuer, appId: mcpRoute.appScope }, bearer ? "invalid_token" : undefined);
    }

    // Anything that isn't /mcp 404s here rather than being handed to serve().
    // Today serve()'s default streamable-http handler gates on its own
    // basePattern and 404s a non-matching path, so the fallthrough was
    // harmless — but that is library internals, not a contract: `transport:
    // "auto"` in agents>=0.14 dispatches a bare GET to the legacy SSE handler
    // without re-checking the base path. Own the routing here instead.
    if (!mcpRoute.isTransport) {
      return new Response("Not found — the MCP endpoint is /mcp or /mcp/apps/:appId", { status: 404 });
    }

    // Private apps (#259): an app-scoped session on a private app is for its owner
    // and its declared roles only — refused before any session exists.
    if (mcpRoute.appScope && request.method !== "OPTIONS") {
      const refusal = await refuseUnlessAppVisible(env, mcpRoute.appScope, bearer && user ? bearer : null);
      if (refusal) return refusal;
    }

    const props: Record<string, unknown> = {
      ...(bearer && user ? { authToken: bearer } : {}),
      ...(mcpRoute.appScope ? { appScope: mcpRoute.appScope } : {}),
    };
    (ctx as unknown as { props: Record<string, unknown> }).props = props;
    const server = await createPasMcpServer(env, props);
    const response = await serveMcp(server, rewriteToSharedMcpPath(request));
    if (response.ok && oauthToken?.brokerRequestId && authority) {
      // Best effort only: a marker failure must never turn a working MCP call
      // into an error. The broker will remain unconnected until a later read is
      // successfully observed.
      await authority.recordRead(oauthToken.brokerRequestId).catch(() => undefined);
    }
    return response;
  },
};

// Apps last seen public, by id → when that answer expires. Only a PUBLIC answer
// is remembered (it is the same for every caller), so a public app's MCP traffic
// does not ask the backend on every message. The tool list and every action call
// re-check visibility in the backend, so this window never exposes app data.
//
// Flip bound (#259): after an app goes public → private, an isolate may still
// open an app-scoped session on it for up to PUBLIC_APP_TTL_MS (10 s), and the
// shared tool cache (tool-loader.ts TOOL_CACHE_TTL_MS, also 10 s) may still list
// its tool NAMES and params. Neither ever returns app data: every action call is
// re-checked by the backend's visibility gate on the request itself.
const publicApps = new Map<string, number>();
export const PUBLIC_APP_TTL_MS = 10_000;

/**
 * Null when the caller may open a session on the app; otherwise the refusal.
 * Asks GET /v1/apps/:id/visibility/me; a failed lookup is a 503, never an allow.
 */
export async function refuseUnlessAppVisible(env: Pick<Env, "API" | "API_BASE">, appId: string, token: string | null): Promise<Response | null> {
  const known = publicApps.get(appId);
  if (known !== undefined && known > Date.now()) return null;
  let res: Response;
  try {
    res = await env.API.fetch(`${env.API_BASE}/v1/apps/${encodeURIComponent(appId)}/visibility/me`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
  } catch {
    return visibilityRefusal(503, "Authorization unavailable");
  }
  if (res.status === 401) return visibilityRefusal(401, "Unauthorized");
  if (!res.ok) return visibilityRefusal(503, "Authorization unavailable");
  const body = (await res.json().catch(() => null)) as { mode?: unknown; allowed?: unknown } | null;
  if (body?.mode === "public" && body.allowed === true) {
    publicApps.set(appId, Date.now() + PUBLIC_APP_TTL_MS);
    return null;
  }
  publicApps.delete(appId);
  return body?.allowed === true ? null : visibilityRefusal(403, "Forbidden — this app is private");
}

/** Test seam: forget remembered public answers. */
export function clearVisibilityCache(): void {
  publicApps.clear();
}

function visibilityRefusal(status: number, message: string): Response {
  return new Response(JSON.stringify({ error: message }), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
}

/** The app scope a scoped session was routed with (#149); null on the shared endpoint or for a malformed id. */
export function extractAppScope(props: Record<string, unknown>): string | null {
  return typeof props.appScope === "string" && isValidAppId(props.appScope)
    ? props.appScope
    : null;
}

function isValidAppId(value: string): boolean {
  return /^[a-z][a-z0-9-]{0,57}$/.test(value);
}

/**
 * Route table for the MCP worker (#149): `/mcp` is the shared platform
 * endpoint, `/mcp/apps/:appId` an app-scoped one. Anything else is not a
 * transport path; a malformed app id is a 400, never a fallthrough to the
 * shared endpoint.
 */
export function resolveMcpRoute(pathname: string): {
  isTransport: boolean;
  appScope: string | null;
  error?: string;
  status?: number;
} {
  if (pathname === "/mcp" || pathname === "/mcp/") {
    return { isTransport: true, appScope: null };
  }
  const prefix = "/mcp/apps/";
  if (!pathname.startsWith(prefix)) {
    return { isTransport: false, appScope: null };
  }
  const rest = pathname.slice(prefix.length);
  const appId = rest.endsWith("/") ? rest.slice(0, -1) : rest;
  if (!isValidAppId(appId)) {
    return { isTransport: false, appScope: null, error: "Invalid MCP app endpoint — expected /mcp/apps/:appId", status: 400 };
  }
  return { isTransport: true, appScope: appId };
}

function rewriteToSharedMcpPath(request: Request): Request {
  const url = new URL(request.url);
  if (url.pathname === "/mcp") return request;
  url.pathname = "/mcp";
  return new Request(url.toString(), request);
}

/**
 * Is this an MCP protocol client rather than a person in a browser?
 *
 * A client pointed at the origin instead of `/mcp` asks for the event stream
 * with `GET / Accept: text/event-stream` (the legacy SSE transport), or POSTs
 * JSON-RPC. Answering either with 200 and a short non-stream body tells the
 * client "stream opened" and then drops it — and the spec-correct response to a
 * dropped stream is to reconnect, so it redials ~1/sec, forever. The flood is
 * invisible to everything we watch: every response is a 200, nothing throws, no
 * AI tokens are spent, nothing reaches the audit log, and the safety layer only
 * sees `tools/call` traffic carrying a verified uid, which a bare GET has
 * neither of.
 *
 * OPTIONS and HEAD deliberately return false so CORS preflight is unaffected.
 */
function isProtocolClient(request: Request): boolean {
  if (request.method === "POST") return true;
  return (request.headers.get("accept") ?? "").includes("text/event-stream");
}

/** The JSON-RPC 405 the MCP spec requires from an endpoint with no stream to offer. */
function wrongEndpoint(): Response {
  return new Response(
    JSON.stringify({
      jsonrpc: "2.0",
      id: null,
      error: {
        code: -32000,
        message: "Method Not Allowed — the MCP endpoint is https://mcp.proappstore.online/mcp",
      },
    }),
    { status: 405, headers: { "content-type": "application/json", allow: "GET, HEAD" } }
  );
}
