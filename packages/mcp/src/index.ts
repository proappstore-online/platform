import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Env } from "./env.js";
import { extractToken, verifyToken } from "./api-helpers.js";
import { verifySession } from "./session.js";
import { listAuditEvents } from "./safety.js";
import { registerPlatformTools } from "./platform-tools.js";
import { fetchTools, registerAppTools } from "./tool-loader.js";
import { registerProjectTools } from "./project-tools.js";
import { registerLoopTools } from "./loop-tools.js";
import { registerAgentsTools } from "./agents-tools.js";
import { createAuthChallenge, handleOAuthRoute, resolveOAuthToken } from "./oauth-provider.js";

export class PasMcpAgent extends McpAgent<Env> {
  server = new McpServer({
    name: "ProAppStore",
    version: "0.2.0",
  });

  // User context — set during init if a token is provided
  private userId: string | null = null;
  private userToken: string | null = null;

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
        this.userToken = token;
      }
    }

    // ── Platform-info tools (list_apps, deploy_status, app_info, ─
    //    platform_guide, sdk_reference, discover_tools) ──────────
    registerPlatformTools(this.server, this.env);

    // ── Project-building tools (for AI agent app creation) ─────
    registerProjectTools(this.server, this.env, () => ({
      userId: this.userId,
      token: this.userToken,
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
    );

    // ── Load and register app tools dynamically ────────────────
    const appTools = await fetchTools(this.env.API_BASE);
    const registered = registerAppTools(
      this.server,
      appTools,
      () => ({ userId: this.userId, token: this.userToken }),
      this.env.API_BASE,
      this.env,
    );

    if (registered.length > 0) {
      console.log(`Registered ${registered.length} app tool(s): ${registered.join(', ')}`);
    }

    // ── Identity: whoami ───────────────────────────────────────
    this.server.tool(
      "whoami",
      "Show the identity this MCP connection is authenticated as — PAS user id, login, platform roles, per-app roles, and token expiry. Use to confirm which account you're acting as before running owner-scoped tools.",
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
        const appRoles = payload.appRoles && Object.keys(payload.appRoles).length
          ? Object.entries(payload.appRoles).map(([app, roles]) => `${app}=${roles.join("/")}`).join(", ")
          : "(no per-app roles)";
        const lines = [
          "Authenticated as:",
          `  uid:     ${payload.uid}`,
          ...(login ? [`  login:   ${login}`] : []),
          `  roles:   ${(payload.roles ?? []).join(", ") || "(none)"}`,
          `  apps:    ${appRoles}`,
          `  expires: ${new Date(payload.exp * 1000).toISOString()}`,
        ];
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
        kv: env.OAUTH_KV,
        sessionSigningKey: env.SESSION_SIGNING_KEY,
      });
      if (oauthRes) return oauthRes;
    }

    if (url.pathname === "/" || url.pathname === "") {
      return new Response(
        "ProAppStore MCP Server\n\nConnect: npx mcp-remote https://mcp.proappstore.online/mcp\n\nPlatform tools: list_apps, deploy_status, app_info, platform_guide, sdk_reference, discover_tools, recipe\nProject tools: scaffold_app, write_file, read_file, list_files, delete_file, search_files, batch_write_files, get_deploy_status, provision_app\nAgent Teams loop: create_app, list_projects, get_project, build_knowledge_base, chat_agent, list_tickets, list_agents, get_project_files, set_project_running, set_project_budget, run_tests, set_model, add_ticket\nAgent introspection: agent_project_status, agent_board, agent_activity, agent_ticket_detail, agent_cost\nApp tools: dynamically loaded from app manifests (use discover_tools to see available)\nIdentity: whoami (show the authenticated PAS account + roles).\nSafety: mcp_audit_log (per-account audit trail). Mutating tools are audited; destructive tools (scaffold_app, delete_file, publish_app) require confirm: true; set MCP_READ_ONLY=1 to block all writes.\n",
        { headers: { "content-type": "text/plain" } }
      );
    }

    // Resolve OAuth token → PAS session, verify it, then lift into ctx.props.
    const auth = request.headers.get("Authorization");
    let bearer = auth?.replace(/^Bearer\s+/i, "");
    if (bearer && env.OAUTH_KV) {
      const session = await resolveOAuthToken(bearer, env.OAUTH_KV);
      if (session) bearer = session;
    }
    const user = bearer && env.SESSION_SIGNING_KEY
      ? await verifyToken(env.SESSION_SIGNING_KEY, bearer)
      : null;

    const isMcpTransport = url.pathname === "/mcp" || url.pathname.startsWith("/mcp/");
    if (isMcpTransport && request.method !== "OPTIONS" && env.OAUTH_KV && env.SESSION_SIGNING_KEY && !user) {
      return createAuthChallenge({ issuer }, bearer ? "invalid_token" : undefined);
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
