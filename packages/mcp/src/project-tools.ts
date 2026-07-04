/**
 * Project-building MCP tools — scaffold, edit, and deploy PAS apps.
 *
 * Thin MCP frontend over @proappstore/build-core: the GitHub repo/file/push
 * logic and the app-ownership check live in build-core (shared with
 * packages/admin's agent-deploy), so this file is just zod schemas + result
 * formatting.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { makeGitHub, verifyAppOwnership } from "@proappstore/build-core";
import { gateMutation } from "./safety.js";

interface ProjectToolsEnv {
  GITHUB_ORG: string;
  GITHUB_TOKEN: string;
  API_BASE: string;
  R2_ACCESS_KEY_ID?: string;
  R2_SECRET_ACCESS_KEY?: string;
  R2_ACCOUNT_ID?: string;
  OAUTH_KV?: KVNamespace;
  MCP_READ_ONLY?: string;
}

const CONFIRM = z
  .boolean()
  .optional()
  .describe("Must be true to run this destructive action. Without it the call is rejected.");

type Text = { content: { type: "text"; text: string }[] };
const text = (s: string): Text => ({ content: [{ type: "text" as const, text: s }] });

const APP_ID = z.string().regex(/^[a-z][a-z0-9-]*$/).describe("App ID (lowercase, e.g. 'chess-academy')");

export function registerProjectTools(
  server: McpServer,
  env: ProjectToolsEnv,
  getUserContext: () => { userId: string | null; token: string | null },
): void {
  const { GITHUB_ORG: org, GITHUB_TOKEN: ghToken, API_BASE: apiBase } = env;
  const gh = makeGitHub(ghToken, org);

  /** Gate a mutating tool: read-only block (throws) + audit, attributed to the connection user. */
  const gate = (tool: string, input?: Record<string, unknown>) =>
    gateMutation({ env, subject: getUserContext().userId }, tool, input);

  /** Require a valid session token; return it or the error response. */
  function requireAuth(): { token: string } | Text {
    const { token } = getUserContext();
    if (!token) return text("Error: authentication required. Authenticate the MCP connection or send a PAS session token.");
    return { token };
  }

  /** Require auth + app ownership. Returns the token or an error response. */
  async function requireOwner(appId: string): Promise<{ token: string } | Text> {
    const auth = requireAuth();
    if ('content' in auth) return auth;
    if (!await verifyAppOwnership(apiBase, auth.token, appId)) {
      return text(`Error: you don't own app "${appId}". Only the app owner can use project tools on it.`);
    }
    return auth;
  }

  /** Set R2 deploy credentials as GitHub Actions variables on a repo. */
  async function setR2Variables(appId: string): Promise<string[]> {
    const vars: [string, string][] = [
      ['R2_ACCESS_KEY_ID', env.R2_ACCESS_KEY_ID ?? ''],
      ['R2_SECRET_ACCESS_KEY', env.R2_SECRET_ACCESS_KEY ?? ''],
      ['R2_ACCOUNT_ID', env.R2_ACCOUNT_ID ?? ''],
    ];
    if (vars.every(([, v]) => !v)) return ['R2 credentials not configured on MCP server'];
    if (vars.some(([, v]) => !v)) return ['R2 credentials partially configured (some missing)'];

    const errors: string[] = [];
    for (const [name, value] of vars) {
      const res = await gh.setRepoVariable(appId, name, value).catch(() => ({ ok: false }));
      if (!res.ok) errors.push(`Failed to set ${name}`);
    }
    return errors;
  }

  /** Call /v1/provision and format the step results. */
  async function provision(appId: string, token: string): Promise<string> {
    try {
      const res = await fetch(`${apiBase}/v1/provision`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ appId, skipCompliance: true, repoOwner: org, repoName: appId }),
      });
      const data = (await res.json()) as { steps?: { name: string; status: string; detail: string }[] };
      return (data.steps ?? [])
        .map((s) => `${s.status === "ok" ? "+" : s.status === "skip" ? "~" : "!"} ${s.name}: ${s.detail}`)
        .join("\n");
    } catch (e) {
      return `! provision error: ${e instanceof Error ? e.message : 'unknown'}`;
    }
  }

  // ── scaffold_app ──────────────────────────────────────────
  server.tool(
    "scaffold_app",
    "Create a new PAS app. Creates a GitHub repo from the template, sets R2 deploy credentials, provisions the route + D1 database + data worker. The app is live after the first push.",
    {
      app_id: APP_ID,
      name: z.string().describe("Display name (e.g. 'Chess Academy')"),
      description: z.string().describe("Short description of the app"),
      confirm: CONFIRM,
    },
    async ({ app_id, name, description, confirm }) => {
      const auth = requireAuth();
      if ('content' in auth) return auth;
      if (confirm !== true)
        return text(`Refused: scaffold_app creates a GitHub repo + deploy secrets + infra for "${app_id}". Re-call with confirm: true to proceed.`);
      await gate("scaffold_app", { app_id, name });

      // 1. Create repo from template
      const createRes = await gh.createRepoFromTemplate(app_id, { description });
      let repoCreated = false;
      if (createRes.ok) {
        repoCreated = true;
      } else if (createRes.status === 422) {
        if (!(await gh.repoExists(app_id))) {
          return text(`Error creating repo: ${JSON.stringify(createRes.data)}`);
        }
      } else if (createRes.status === 404) {
        // GitHub's template-generate API 404s when the SOURCE repo isn't flagged
        // as a template — a config drift that otherwise reads as a generic error.
        return text(
          `Error creating repo: GitHub returned 404 from the template-generate API. The source ` +
          `template repo "${org}/template-app" must be marked as a GitHub template ` +
          `(repo Settings → "Template repository", or PATCH /repos/${org}/template-app with is_template=true).`,
        );
      } else {
        return text(`Error creating repo: ${JSON.stringify(createRes.data)}`);
      }

      const steps: string[] = [];

      if (repoCreated) {
        steps.push("+ Repo created from template");

        // 2. Replace APPNAME placeholders (wait for GitHub to finish template copy)
        await new Promise((r) => setTimeout(r, 4000));
        for (const filePath of ["web/index.html", "web/package.json", "CLAUDE.md"]) {
          const file = await gh.getFile(app_id, filePath);
          if (!file.ok || file.content === undefined || !file.sha) continue;
          const patched = file.content.replaceAll("APPNAME", app_id);
          if (patched !== file.content) {
            await gh.putFile(app_id, filePath, patched, `chore: replace APPNAME with ${app_id}`, file.sha);
          }
        }

        // 3. Set R2 deploy credentials
        const r2Errors = await setR2Variables(app_id);
        if (r2Errors.length === 0) {
          steps.push("+ R2 deploy credentials set");
        } else {
          steps.push(`! R2 credentials: ${r2Errors.join(', ')}`);
        }
      } else {
        steps.push("~ Repo already existed");
      }

      // 4. Provision (route + D1 + data worker)
      const provResult = await provision(app_id, auth.token);
      if (provResult) steps.push(provResult);

      return text([
        `App scaffolded: **${name}** (${app_id})`,
        `Repo: https://github.com/${org}/${app_id}`,
        `Live URL: https://${app_id}.proappstore.online`,
        `Data worker: https://data-${app_id}.proappstore.online`,
        "",
        ...steps,
      ].join("\n"));
    },
  );

  // ── write_file ────────────────────────────────────────────
  server.tool(
    "write_file",
    "Create or overwrite a file in a PAS app's GitHub repo. Commits directly to the main branch.",
    {
      app_id: APP_ID,
      path: z.string().describe("File path relative to repo root (e.g. 'web/src/App.tsx')"),
      content: z.string().describe("Full file content"),
      message: z.string().optional().describe("Commit message (auto-generated if omitted)"),
    },
    async ({ app_id, path, content, message }) => {
      const auth = await requireOwner(app_id);
      if ('content' in auth) return auth;
      await gate("write_file", { app_id, path });
      const existing = await gh.getFile(app_id, path);
      const sha = existing.ok ? existing.sha : undefined;
      const put = await gh.putFile(app_id, path, content, message ?? `${sha ? "update" : "create"}: ${path}`, sha);
      if (!put.ok) return text(`Error writing ${path}: ${JSON.stringify(put.data)}`);
      return text(`${sha ? "Updated" : "Created"} ${path}`);
    },
  );

  // ── read_file ─────────────────────────────────────────────
  server.tool(
    "read_file",
    "Read a file from a PAS app's GitHub repo.",
    { app_id: APP_ID, path: z.string().describe("File path relative to repo root") },
    async ({ app_id, path }) => {
      const auth = await requireOwner(app_id);
      if ('content' in auth) return auth;
      const file = await gh.getFile(app_id, path);
      if (!file.ok || file.content === undefined) return text(`File not found: ${path} (${file.status})`);
      return text(file.content);
    },
  );

  // ── list_files ────────────────────────────────────────────
  server.tool(
    "list_files",
    "List all files in a PAS app's GitHub repo.",
    { app_id: APP_ID, path: z.string().optional().describe("Subdirectory path (default: repo root)") },
    async ({ app_id, path }) => {
      const auth = await requireOwner(app_id);
      if ('content' in auth) return auth;
      const res = await gh.listFiles(app_id, path);
      if (!res.ok) return text(`Error listing files: ${res.status}`);
      const raw = res.data as { path: string; type: string; size?: number } | { path: string; type: string; size?: number }[];
      const files = Array.isArray(raw) ? raw : [raw];
      return text(files.map((f) => `${f.type === "dir" ? "d" : "f"} ${f.path}${f.size ? ` (${f.size}B)` : ""}`).join("\n") || "Empty directory");
    },
  );

  // ── delete_file ───────────────────────────────────────────
  server.tool(
    "delete_file",
    "Delete a file from a PAS app's GitHub repo. Requires confirm: true.",
    { app_id: APP_ID, path: z.string().describe("File path to delete"), message: z.string().optional().describe("Commit message"), confirm: CONFIRM },
    async ({ app_id, path, message, confirm }) => {
      const auth = await requireOwner(app_id);
      if ('content' in auth) return auth;
      if (confirm !== true)
        return text(`Refused: delete_file permanently removes "${path}" from ${app_id}. Re-call with confirm: true to proceed.`);
      await gate("delete_file", { app_id, path });
      const existing = await gh.getFile(app_id, path);
      if (!existing.ok || !existing.sha) return text(`File not found: ${path}`);
      const del = await gh.deleteFile(app_id, path, message ?? `delete: ${path}`, existing.sha);
      if (!del.ok) return text(`Error deleting ${path}: ${JSON.stringify(del.data)}`);
      return text(`Deleted ${path}`);
    },
  );

  // ── search_files ──────────────────────────────────────────
  server.tool(
    "search_files",
    "Search for text across all files in a PAS app's GitHub repo. Returns matching files with line previews.",
    { app_id: APP_ID, query: z.string().describe("Search text (case-insensitive)") },
    async ({ app_id, query }) => {
      const auth = await requireOwner(app_id);
      if ('content' in auth) return auth;
      const res = await gh.searchCode(app_id, query);
      if (!res.ok) return text(`Search error: ${res.status}`);
      const items = (res.data as { items?: { path: string; text_matches?: { fragment: string }[] }[] }).items ?? [];
      if (items.length === 0) return text(`No results for "${query}"`);
      return text(`${items.length} result(s):\n\n${items.slice(0, 20).map((item) => {
        const preview = item.text_matches?.[0]?.fragment?.slice(0, 100) ?? "";
        return `${item.path}${preview ? `\n  ...${preview}...` : ""}`;
      }).join("\n")}`);
    },
  );

  // ── get_deploy_status ─────────────────────────────────────
  server.tool(
    "get_deploy_status",
    "Check the latest deploy status for a PAS app (GitHub Actions workflow runs).",
    { app_id: APP_ID },
    async ({ app_id }) => {
      const auth = await requireOwner(app_id);
      if ('content' in auth) return auth;
      const res = await gh.getDeployStatus(app_id);
      if (!res.ok) return text(`Error: ${res.status}`);
      const runs = (res.data as { workflow_runs?: { name: string; conclusion: string | null; status: string; updated_at: string }[] }).workflow_runs ?? [];
      if (runs.length === 0) return text("No workflow runs found. Push to main to trigger deploy.");
      return text(runs.map((r) => `${r.conclusion === "success" ? "+" : r.conclusion === "failure" ? "!" : "~"} ${r.name}: ${r.conclusion ?? r.status} (${r.updated_at})`).join("\n"));
    },
  );

  // ── provision_app ─────────────────────────────────────────
  server.tool(
    "provision_app",
    "Provision platform resources for a PAS app (R2 route, D1 database, data worker). Idempotent — safe to call on already-provisioned apps.",
    { app_id: APP_ID },
    async ({ app_id }) => {
      const auth = requireAuth();
      if ('content' in auth) return auth;
      await gate("provision_app", { app_id });
      const result = await provision(app_id, auth.token);
      return text(result || "Provisioning complete (no steps reported).");
    },
  );

  // ── publish_app ─────────────────────────────────────────
  server.tool(
    "publish_app",
    "Publish a PAS app to the storefront. Provisions infrastructure (R2 route, D1, data worker) and adds it to the registry so it appears on proappstore.online with a detail page. Idempotent — skips already-provisioned resources and already-listed apps.",
    {
      app_id: APP_ID,
      name: z.string().max(80).describe("Display name (e.g. 'Chess Academy')"),
      category: z.string().max(80).describe("Category (e.g. 'education', 'productivity', 'social')"),
      description: z.string().max(500).describe("Short description for the storefront card"),
      icon: z.string().optional().describe("HTML entity for the icon (e.g. '&#9822;'). Defaults to '📦'."),
      icon_bg: z.string().regex(/^#([0-9a-fA-F]{3,8})$/).optional().describe("Hex background color for the icon (e.g. '#fef3c7')"),
      pro_features: z.array(z.string().max(60)).max(8).optional().describe("List of pro features (max 8, each max 60 chars)"),
      confirm: CONFIRM,
    },
    async ({ app_id, name, category, description, icon, icon_bg, pro_features, confirm }) => {
      const auth = requireAuth();
      if ('content' in auth) return auth;
      if (confirm !== true)
        return text(`Refused: publish_app lists "${app_id}" publicly on proappstore.online. Re-call with confirm: true to proceed.`);
      await gate("publish_app", { app_id, name, category });

      // Call the admin Worker's publish endpoint — same path as `pas publish` CLI.
      // This provisions infra + adds to registry in one atomic flow.
      const adminBase = new URL(apiBase);
      adminBase.hostname = adminBase.hostname.replace(/^api\./, "admin.");
      let data: {
        steps?: { name: string; status: string; detail: string }[];
        success?: boolean;
        error?: string;
      };
      try {
        const res = await fetch(`${adminBase.origin}/api/publish-app`, {
          method: "POST",
          headers: { Authorization: `Bearer ${auth.token}`, "Content-Type": "application/json" },
          body: JSON.stringify({
            id: app_id,
            name,
            category,
            description,
            icon: icon || "📦",
            iconBg: icon_bg || "#7c3aed",
            ...(pro_features?.length ? { proFeatures: pro_features } : {}),
          }),
        });
        if (!res.ok) {
          const body = await res.text().catch(() => "");
          return text(`Error: admin API returned ${res.status}${body ? `: ${body.slice(0, 200)}` : ""}`);
        }
        data = await res.json();
      } catch (e) {
        return text(`Error: publish failed — ${e instanceof Error ? e.message : "unknown"}`);
      }

      if (data.error) return text(`Error: ${data.error}`);

      const steps = (data.steps ?? [])
        .map((s) => `${s.status === "ok" ? "+" : s.status === "skip" ? "~" : "!"} ${s.name}: ${s.detail}`)
        .join("\n");

      return text([
        data.success ? `Published: **${name}** (${app_id})` : `Publish failed for ${app_id}`,
        `Live: https://${app_id}.proappstore.online`,
        `Listing: https://proappstore.online/apps/${app_id}/`,
        "",
        steps,
      ].join("\n"));
    },
  );

  // ── batch_write_files ─────────────────────────────────────
  server.tool(
    "batch_write_files",
    "Write multiple files in a single commit to a PAS app's GitHub repo. More efficient than individual write_file calls.",
    {
      app_id: APP_ID,
      files: z.array(z.object({
        path: z.string().describe("File path relative to repo root"),
        content: z.string().describe("Full file content"),
      })).describe("Array of files to write"),
      message: z.string().describe("Commit message"),
    },
    async ({ app_id, files, message }) => {
      const auth = await requireOwner(app_id);
      if ('content' in auth) return auth;
      await gate("batch_write_files", { app_id, count: files.length });
      const res = await gh.pushFiles(app_id, files, message, { initIfEmpty: true });
      if (!res.ok) return text(`Error committing files: ${res.error ?? "unknown"}`);
      return text(`Committed ${files.length} file(s): ${message}\n${files.map((f) => `  + ${f.path}`).join("\n")}`);
    },
  );
}
