import { internalTokenOk } from "@proappstore/build-core";
import type { Env } from "./env.js";
import { handlePublish, handleAgentDeploy, handleRepoPull, handleDeployStatus, handlePublishKb, type PublishRequest, type AgentDeployRequest, type PublishKbRequest } from "./publish.js";
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
      if (!internalTokenOk(request.headers.get("X-Internal-Token"), env.INTERNAL_TOKEN)) {
        return Response.json({ error: "forbidden" }, { status: 403 });
      }
      const body = await request.json<AgentDeployRequest>();
      const result = await handleAgentDeploy(body, env);
      return Response.json(result, { status: result.success ? 200 : 422 });
    }

    // Internal: agent-teams publishes the KB as a Zensical site (no app build) —
    // ensure repo + push KB markdown + kb.yml, which builds + uploads to R2.
    if (url.pathname === "/api/publish-kb" && request.method === "POST") {
      if (!internalTokenOk(request.headers.get("X-Internal-Token"), env.INTERNAL_TOKEN)) {
        return Response.json({ error: "forbidden" }, { status: 403 });
      }
      const body = await request.json<PublishKbRequest>();
      if (!body.id) return Response.json({ error: "id required" }, { status: 400 });
      const result = await handlePublishKb(body, env);
      return Response.json(result, { status: result.success ? 200 : 422 });
    }

    // Internal: agent-teams pulls a repo's current files (GitHub = source of
    // truth) into its working tree. Cheap freshness check via ?head=1.
    if (url.pathname === "/api/repo-pull" && request.method === "POST") {
      if (!internalTokenOk(request.headers.get("X-Internal-Token"), env.INTERNAL_TOKEN)) {
        return Response.json({ error: "forbidden" }, { status: 403 });
      }
      const body = await request.json<{ id: string; headOnly?: boolean }>();
      if (!body.id) return Response.json({ error: "id required" }, { status: 400 });
      const result = await handleRepoPull(body, env);
      return Response.json(result, { status: result.ok ? 200 : 404 });
    }

    // Internal: real CI build/deploy result (the build gate for agent-teams).
    if (url.pathname === "/api/deploy-status" && request.method === "POST") {
      if (!internalTokenOk(request.headers.get("X-Internal-Token"), env.INTERNAL_TOKEN)) {
        return Response.json({ error: "forbidden" }, { status: 403 });
      }
      const body = await request.json<{ id: string; waitMs?: number; sha?: string }>();
      if (!body.id) return Response.json({ error: "id required" }, { status: 400 });
      return Response.json(await handleDeployStatus(body, env));
    }

    // Public read: list apps from registry
    if (url.pathname === "/api/apps" && request.method === "GET") {
      return Response.json({ error: "not_implemented" }, { status: 501 });
    }

    return Response.json({ error: "not_found", route: url.pathname }, { status: 404 });
  },
};
