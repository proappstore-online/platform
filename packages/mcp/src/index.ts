import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Env } from "./env.js";
import { extractToken, verifyToken } from "./api-helpers.js";
import { registerPlatformTools } from "./platform-tools.js";
import { fetchTools, registerAppTools } from "./tool-loader.js";
import { registerProjectTools } from "./project-tools.js";

export class PasMcpAgent extends McpAgent<Env> {
  server = new McpServer({
    name: "ProAppStore",
    version: "0.2.0",
  });

  // User context — set during init if a token is provided
  private userId: string | null = null;
  private userToken: string | null = null;

  async init() {
    // KNOWN ISSUE: McpAgent.serve() (agents@0.0.74) does not populate ctx.props,
    // so this.props is {} and connection-level auth is always null — the project
    // tools (write_file etc.) will report "authentication required". This only
    // affects EXTERNAL MCP clients; the agent-teams autonomous loop builds via
    // pas/admin + build-core, not this server. Fix needs the SDK's auth wiring
    // (parse Authorization in fetch → props) before the MCP build path works.
    const token = extractToken(this.props as Record<string, unknown>);
    if (token) {
      const user = await verifyToken(this.env.API_BASE, token);
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
        "ProAppStore MCP Server\n\nConnect: npx mcp-remote https://mcp.proappstore.online/mcp\n\nPlatform tools: list_apps, deploy_status, app_info, platform_guide, sdk_reference, discover_tools\nProject tools: scaffold_app, write_file, read_file, list_files, delete_file, search_files, batch_write_files, get_deploy_status, provision_app\nApp tools: dynamically loaded from app manifests (use discover_tools to see available)\n",
        { headers: { "content-type": "text/plain" } }
      );
    }

    return PasMcpAgent.serve("/mcp").fetch(request, env, ctx);
  },
};
