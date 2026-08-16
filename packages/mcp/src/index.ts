import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Env } from "./env.js";
import { extractToken, fetchAccount, verifyToken } from "./api-helpers.js";
import { verifySession } from "./session.js";
import { listAuditEvents } from "./safety.js";
import { registerPlatformTools } from "./platform-tools.js";
import { fetchTools, registerAppTools } from "./tool-loader.js";
import { registerProjectTools } from "./project-tools.js";
import { registerLoopTools } from "./loop-tools.js";
import { registerAgentsTools } from "./agents-tools.js";
import { registerQaTools } from "./qa-tools.js";
import { createAuthChallenge, handleOAuthRoute, resolveOAuthToken } from "./oauth-provider.js";

const AUTH_PROVIDERS = ["github", "google"] as const;

function configuredAuthProviders(raw: string | undefined): Array<typeof AUTH_PROVIDERS[number]> | undefined {
  const providers = (raw ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter((value): value is typeof AUTH_PROVIDERS[number] => AUTH_PROVIDERS.includes(value as typeof AUTH_PROVIDERS[number]));
  return providers.length ? providers : undefined;
}

export class PasMcpAgent extends McpAgent<Env> {
  server = new McpServer({
    name: "ProAppStore",
    version: "0.2.0",
  });

  // User context — set during init if a token is provided
  private userId: string | null = null;
  private userLogin: string | null = null;
  private userToken: string | null = null;
  private userRoles: string[] = [];

  async init() {
    // Connection-level auth: the `fetch` handler below copies the request's
    // `Authorization` token into `ctx.props.authToken`, which agents@0.0.74's
    // serve() persists and replays into `this.props` here. So write_file etc.
    // now see the user. (The agent-teams loop tools also accept an explicit
    // `token` arg, so they work even without this.)
    const token = extractToken(this.props as Record<string, unknown>);
    if (token && this.env.SESSION_SIGNING_KEY) {
      const user = await verifyToken(this.env.SESSION_SIGNING_KEY, token);
      if (user) {
        this.userId = user.id;
        this.userLogin = user.login;
        this.userToken = token;
        // Platform roles (global, always current in the session) power the
        // app-tool pre-flight role check in tool-loader.
        const claims = await verifySession(token, this.env.SESSION_SIGNING_KEY);
        this.userRoles = claims?.roles ?? [];
      }
    }

    // ── Platform-info tools (list_apps, deploy_status, app_info, ─
    //    platform_guide, sdk_reference, discover_tools) ──────────
    registerPlatformTools(this.server, this.env);

    // ── Project-building tools (for AI agent app creation) ─────
    registerProjectTools(this.server, this.env, () => ({
      userId: this.userId,
      login: this.userLogin,
      token: this.userToken,
      roles: this.userRoles,
    }));

    // ── Agent Teams loop tools (create app, KB, chat PO/Architect, ─
    //    tickets, agents, play/pause) — drive the whole build over MCP ─
    //    The explicit `token` arg is optional; falls back to the authenticated
    //    connection identity so an owner-authed MCP session can drive everything.
    registerLoopTools(this.server, this.env, () => this.userToken);

    // ── Agent-team introspection tools ──────────────────────────
    registerAgentsTools(
      this.server,
      () => ({ userId: this.userId, token: this.userToken }),
      this.env.INTERNAL_TOKEN ?? null,
      this.env.AGENTS_BASE,
      this.env.AGENTS,
    );

    // ── QA automation tools (connect + write/run browser e2e tests) ─
    registerQaTools(this.server, this.env, () => ({
      userId: this.userId,
      token: this.userToken,
    }));

    // ── Load and register app tools dynamically ────────────────
    const appTools = await fetchTools(this.env.API, this.env.API_BASE);
    const registered = registerAppTools(
      this.server,
      appTools,
      () => ({ userId: this.userId, token: this.userToken, roles: this.userRoles }),
      this.env.API,
      this.env.API_BASE,
      this.env,
    );

    if (registered.length > 0) {
      console.log(`Registered ${registered.length} app tool(s): ${registered.join(', ')}`);
    }

    // ── Identity: whoami ───────────────────────────────────────
    this.server.tool(
      "whoami",
      "Show the account this MCP connection is authenticated as — PAS user id, login, email address, sign-in provider, platform roles, and token expiry. Use to confirm which account you're acting as before running owner-scoped tools, or to answer which email the account is tied to.",
      {},
      async () => {
        if (!this.userToken || !this.env.SESSION_SIGNING_KEY) {
          return { content: [{ type: "text" as const, text: "Not authenticated: this MCP connection has no valid PAS session. Owner-scoped tools will be denied." }] };
        }
        const payload = await verifySession(this.userToken, this.env.SESSION_SIGNING_KEY);
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
          this.env.API,
          this.env.API_BASE,
          this.userToken,
          this.env.INTERNAL_TOKEN,
        );

        const lines = [
          "Authenticated as:",
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
    this.server.tool(
      "mcp_audit_log",
      "Read recent MCP audit events (mutating tool invocations + read-only denials) attributed to your authenticated account. Newest first.",
      { limit: z.number().optional().describe("Max events to return (1-200, default 50).") },
      async ({ limit }) => {
        const events = await listAuditEvents({ env: this.env, subject: this.userId }, limit ?? 50);
        if (events.length === 0) {
          return { content: [{ type: "text" as const, text: "No audit events recorded for your account." }] };
        }
        return { content: [{ type: "text" as const, text: `${events.length} event(s):\n\n${JSON.stringify(events, null, 2)}` }] };
      },
    );
  }
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    const url = new URL(request.url);
    const issuer = `${url.protocol}//${url.host}`;

    // OAuth 2.1 routes (discovery, registration, authorize, token)
    if (env.OAUTH_KV && env.SESSION_SIGNING_KEY) {
      const oauthRes = await handleOAuthRoute(request, {
        issuer,
        authStart: env.AUTH_START ?? `${env.API_BASE}/v1/auth/github/start`,
        api: env.API,
        authProviders: configuredAuthProviders(env.AUTH_PROVIDERS),
        kv: env.OAUTH_KV,
        sessionSigningKey: env.SESSION_SIGNING_KEY,
      });
      if (oauthRes) return oauthRes;
    }

    if (url.pathname === "/" || url.pathname === "") {
      if (isProtocolClient(request)) return wrongEndpoint();
      return new Response(
        "ProAppStore MCP Server\n\nConnect: npx mcp-remote https://mcp.proappstore.online/mcp\n\nPlatform tools: list_apps, deploy_status, app_info, platform_guide, sdk_reference, discover_tools, recipe\nProject tools: provision_pas_app, scaffold_app, write_file, read_file, list_files, delete_file, search_files, batch_write_files, get_deploy_status, provision_app\nAgent Teams loop: create_app, list_projects, get_project, build_knowledge_base, chat_agent, list_tickets, list_agents, get_project_files, set_project_running, set_project_budget, run_tests, set_model, add_ticket\nAgent introspection: agent_project_status, agent_board, agent_activity, agent_ticket_detail, agent_cost\nApp tools: dynamically loaded from app manifests (use discover_tools to see available)\nIdentity: whoami (show the authenticated PAS account — uid, login, email, sign-in provider, roles).\nSafety: mcp_audit_log (per-account audit trail). Mutating tools are audited; destructive tools (provision_pas_app, scaffold_app, delete_file, publish_app) require confirm: true; expensive/irreversible tools accept dry_run: true to preview; set MCP_READ_ONLY=1 to block all writes.\n",
        { headers: { "content-type": "text/plain" } }
      );
    }

    // Resolve OAuth token → PAS session, verify it, then lift into ctx.props.
    const auth = request.headers.get("Authorization");
    let bearer = auth?.replace(/^Bearer\s+/i, "");
    if (bearer && env.OAUTH_KV) {
      try {
        const session = await resolveOAuthToken(bearer, env.OAUTH_KV);
        if (session) bearer = session;
      } catch (e) {
        console.warn(`MCP OAuth token resolution failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    let user: { id: string; login: string } | null = null;
    if (bearer && env.SESSION_SIGNING_KEY) {
      try {
        user = await verifyToken(env.SESSION_SIGNING_KEY, bearer);
      } catch (e) {
        console.warn(`MCP bearer verification failed: ${e instanceof Error ? e.message : String(e)}`);
        user = null;
      }
    }

    const isMcpTransport = url.pathname === "/mcp" || url.pathname.startsWith("/mcp/");
    if (isMcpTransport && request.method !== "OPTIONS" && env.OAUTH_KV && env.SESSION_SIGNING_KEY && !user) {
      return createAuthChallenge({ issuer }, bearer ? "invalid_token" : undefined);
    }

    // Anything that isn't /mcp 404s here rather than being handed to serve().
    // Today serve()'s default streamable-http handler gates on its own
    // basePattern and 404s a non-matching path, so the fallthrough was
    // harmless — but that is library internals, not a contract: `transport:
    // "auto"` in agents>=0.14 dispatches a bare GET to the legacy SSE handler
    // without re-checking the base path. Own the routing here instead.
    if (!isMcpTransport) {
      return new Response("Not found — the MCP endpoint is /mcp", { status: 404 });
    }

    if (bearer && user) {
      (ctx as unknown as { props?: Record<string, unknown> }).props = {
        ...((ctx as unknown as { props?: Record<string, unknown> }).props ?? {}),
        authToken: bearer,
      };
    }

    return PasMcpAgent.serve("/mcp").fetch(request, env, ctx);
  },
};

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
