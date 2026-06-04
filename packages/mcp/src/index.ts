import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Env } from "./env.js";
import { extractToken, verifyToken } from "./api-helpers.js";
import { registerPlatformTools } from "./platform-tools.js";
import { fetchTools, registerAppTools } from "./tool-loader.js";
import { registerProjectTools } from "./project-tools.js";
import { registerLoopTools } from "./loop-tools.js";

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
    if (token) {
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
    registerLoopTools(this.server, this.env);

    // ── Load and register app tools dynamically ────────────────
    const appTools = await fetchTools(this.env.API_BASE);
    const registered = registerAppTools(
      this.server,
      appTools,
      () => ({ userId: this.userId, token: this.userToken }),
    );

    if (registered.length > 0) {
      console.log(`Registered ${registered.length} app tool(s): ${registered.join(', ')}`);
    }
  }
}

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext) {
    const url = new URL(request.url);

    if (url.pathname === "/" || url.pathname === "") {
      return new Response(
        "ProAppStore MCP Server\n\nConnect: npx mcp-remote https://mcp.proappstore.online/mcp\n\nPlatform tools: list_apps, deploy_status, app_info, platform_guide, sdk_reference, discover_tools\nProject tools: scaffold_app, write_file, read_file, list_files, delete_file, search_files, batch_write_files, get_deploy_status, provision_app\nAgent Teams loop: create_app, list_projects, get_project, build_knowledge_base, chat_agent, list_tickets, list_agents, get_project_files, set_project_running\nApp tools: dynamically loaded from app manifests (use discover_tools to see available)\n",
        { headers: { "content-type": "text/plain" } }
      );
    }

    // Lift the request's bearer token into ctx.props so connection-authed tools
    // (write_file etc.) can see the user. serve() persists props into the DO and
    // replays them into the agent's `this.props` (read by extractToken in init()).
    const auth = request.headers.get("Authorization");
    const bearer = auth?.replace(/^Bearer\s+/i, "");
    if (bearer) {
      (ctx as unknown as { props?: Record<string, unknown> }).props = {
        ...((ctx as unknown as { props?: Record<string, unknown> }).props ?? {}),
        authToken: bearer,
      };
    }

    return PasMcpAgent.serve("/mcp").fetch(request, env, ctx);
  },
};
