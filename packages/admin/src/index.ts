import { internalTokenOk } from "@proappstore/build-core";
import { handleAuthExchange, handleAuthMe, verifySession } from "./auth.js";
import type { Env } from "./env.js";
import {
  type AgentDeployRequest,
  handleAgentDeploy,
  handleDeployStatus,
  handlePublish,
  handlePublishKb,
  handleRepoPull,
  type PublishKbRequest,
  type PublishRequest,
} from "./publish.js";

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
      // Inject the verified creator login (can't be spoofed by the client) so
      // publish grants them push access to their app repo. Without this the
      // creator gets 403 on `git push` to proappstore-online/<id>.
      const result = await handlePublish(
        { ...body, creatorGithub: body.creatorGithub || login },
        env,
      );
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

    // Internal (spike): kick off the durable publish-provisioning Workflow.
    // Same payload + auth as /api/publish-app, but provisioning runs as a
    // Cloudflare Workflow (per-step retry + persistence). Returns the instance
    // id immediately; poll status at /api/provision-workflow/status?id=.
    if (url.pathname === "/api/provision-workflow" && request.method === "POST") {
      const authHeader = request.headers.get("Authorization");
      if (!authHeader?.startsWith("Bearer ")) {
        return Response.json({ error: "unauthorized" }, { status: 401 });
      }
      const login = await verifySession(authHeader.slice(7), env.SESSION_SIGNING_KEY);
      if (!login) {
        return Response.json({ error: "invalid or expired session" }, { status: 401 });
      }
      const body = await request.json<PublishRequest>();
      const instance = await env.PROVISION_WORKFLOW.create({
        params: { req: { ...body, creatorGithub: body.creatorGithub || login }, addRegistry: true },
      });
      return Response.json({ id: instance.id, status: await instance.status() }, { status: 202 });
    }

    // Internal: run the AGENT-deploy path as a durable Workflow. The instance id
    // is CF-AUTO-GENERATED (unique per deploy) — NOT the app slug — so an app can
    // deploy repeatedly without colliding (create({id: slug}) would 409 on the
    // 2nd deploy within the retention window). The CI gate self-polls GitHub, so
    // no slug-keyed event routing is needed. Caller stores the returned id and
    // polls /api/provision-workflow/status?id=. Mirrors /api/agent-deploy.
    if (url.pathname === "/api/provision-workflow/agent" && request.method === "POST") {
      if (!internalTokenOk(request.headers.get("X-Internal-Token"), env.INTERNAL_TOKEN)) {
        return Response.json({ error: "forbidden" }, { status: 403 });
      }
      const body = await request.json<AgentDeployRequest>();
      if (!body.id || !body.name) return Response.json({ error: "id and name required" }, { status: 400 });
      const instance = await env.PROVISION_WORKFLOW.create({
        params: {
          req: {
            id: body.id,
            name: body.name,
            description: body.description ?? "",
            category: body.category ?? "tools",
            icon: body.icon ?? "📦",
            iconBg: body.iconBg ?? "#000000",
          },
          files: body.files,
          addRegistry: false,
        },
      });
      return Response.json({ id: instance.id, status: await instance.status() }, { status: 202 });
    }

    // Internal (spike): poll a provisioning Workflow instance.
    if (url.pathname === "/api/provision-workflow/status" && request.method === "GET") {
      if (!internalTokenOk(request.headers.get("X-Internal-Token"), env.INTERNAL_TOKEN)) {
        return Response.json({ error: "forbidden" }, { status: 403 });
      }
      const id = url.searchParams.get("id");
      if (!id) return Response.json({ error: "id required" }, { status: 400 });
      const instance = await env.PROVISION_WORKFLOW.get(id);
      return Response.json({ id, status: await instance.status() });
    }

    // Public read: list apps from registry
    if (url.pathname === "/api/apps" && request.method === "GET") {
      return Response.json({ error: "not_implemented" }, { status: 501 });
    }

    return Response.json({ error: "not_found", route: url.pathname }, { status: 404 });
  },
};

// Cloudflare Workflows require the entrypoint class to be a named export of the
// Worker's main module (referenced by class_name in wrangler.toml).
export { ProvisionWorkflow } from "./provision-workflow.js";
