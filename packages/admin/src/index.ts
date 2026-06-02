import type { Env } from "./env.js";
import { handlePublish, handleAgentDeploy, type PublishRequest, type AgentDeployRequest } from "./publish.js";
import { verifySession, handleAuthExchange, handleAuthMe } from "./auth.js";

export default {
  async fetch(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/health") {
      return Response.json({ ok: true, worker: "proappstore-admin", version: "0.3.0" });
    }

    // Self-contained auth: exchange a GitHub token for a PAS admin session.
    if (url.pathname === "/v1/auth/exchange" && request.method === "POST") {
      return handleAuthExchange(request, env);
    }
    if (url.pathname === "/v1/auth/me" && request.method === "GET") {
      return handleAuthMe(request, env);
    }

    if (url.pathname === "/api/publish-app" && request.method === "POST") {
      // HS256 Bearer session check. Without this, anyone reachable to
      // admin.proappstore.online can provision repos in proappstore-online
      // and mint CF resources. Add CF Access in front for defense-in-depth.
      const authHeader = request.headers.get("Authorization");
      if (!authHeader?.startsWith("Bearer ")) {
        return Response.json({ error: "unauthorized" }, { status: 401 });
      }
      const login = await verifySession(authHeader.slice(7), env.SESSION_SIGNING_KEY);
      if (!login) {
        return Response.json({ error: "invalid or expired session" }, { status: 401 });
      }
      const body = await request.json<PublishRequest>();
      const result = await handlePublish(body, env);
      return Response.json(result, { status: result.success ? 200 : 422 });
    }

    // Internal: agent-teams ships an authored app (create repo + push files +
    // register). Service-to-service auth via INTERNAL_TOKEN, not a user session.
    if (url.pathname === "/api/agent-deploy" && request.method === "POST") {
      const provided = request.headers.get("X-Internal-Token");
      if (!env.INTERNAL_TOKEN || provided !== env.INTERNAL_TOKEN) {
        return Response.json({ error: "forbidden" }, { status: 403 });
      }
      const body = await request.json<AgentDeployRequest>();
      const result = await handleAgentDeploy(body, env);
      return Response.json(result, { status: result.success ? 200 : 422 });
    }

    // Public read: list apps from registry
    if (url.pathname === "/api/apps" && request.method === "GET") {
      return Response.json({ error: "not_implemented" }, { status: 501 });
    }

    return Response.json({ error: "not_found", route: url.pathname }, { status: 404 });
  },
};
