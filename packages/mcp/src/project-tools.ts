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

interface ProjectToolsEnv {
  GITHUB_ORG: string;
  GITHUB_TOKEN: string;
  API_BASE: string;
}

type Text = { content: { type: "text"; text: string }[] };
const text = (s: string): Text => ({ content: [{ type: "text" as const, text: s }] });
const authError = (): Text => text("Error: authentication required. Connect with a session token.");
const ownershipError = (appId: string): Text =>
  text(`Error: you don't own app "${appId}". Only the app owner can use project tools on it.`);

export function registerProjectTools(
  server: McpServer,
  env: ProjectToolsEnv,
  getUserContext: () => { userId: string | null; token: string | null },
): void {
  const { GITHUB_ORG: org, GITHUB_TOKEN: ghToken, API_BASE: apiBase } = env;
  const gh = makeGitHub(ghToken, org);
  const owns = (token: string, appId: string) => verifyAppOwnership(apiBase, token, appId);

  // ── scaffold_app ──────────────────────────────────────────
  server.tool(
    "scaffold_app",
    "Create a new PAS app from the template. Creates a GitHub repo, copies template files, and provisions platform resources (CF Pages, D1, DNS). Returns the app URL and repo URL.",
    {
      app_id: z.string().regex(/^[a-z][a-z0-9-]*$/).describe("App ID (lowercase, e.g. 'chess-academy')"),
      name: z.string().describe("Display name (e.g. 'Chess Academy')"),
      description: z.string().describe("Short description of the app"),
    },
    async ({ app_id, name, description }) => {
      const { token: userToken } = getUserContext();
      if (!userToken) return authError();

      const createRes = await gh.createRepoFromTemplate(app_id, { description });
      let repoCreated = false;
      if (createRes.ok) {
        repoCreated = true;
      } else if (createRes.status === 422) {
        // 422 can mean "exists" OR a real validation failure — confirm.
        if (!(await gh.repoExists(app_id))) {
          return text(`Error creating repo: ${JSON.stringify(createRes.data)}`);
        }
        repoCreated = false; // already exists
      } else {
        return text(`Error creating repo: ${JSON.stringify(createRes.data)}`);
      }

      if (repoCreated) {
        await new Promise((r) => setTimeout(r, 3000)); // let GitHub finish the template copy
        for (const filePath of ["web/index.html", "web/package.json", "CLAUDE.md"]) {
          const file = await gh.getFile(app_id, filePath);
          if (!file.ok || file.content === undefined || !file.sha) continue;
          const patched = file.content.replaceAll("APPNAME", app_id);
          if (patched !== file.content) {
            await gh.putFile(app_id, filePath, patched, `chore: replace APPNAME with ${app_id}`, file.sha);
          }
        }
      }

      let provisionResult = "";
      if (userToken) {
        const provRes = await fetch(`${apiBase}/v1/provision`, {
          method: "POST",
          headers: { Authorization: `Bearer ${userToken}`, "Content-Type": "application/json" },
          body: JSON.stringify({ appId: app_id, skipCompliance: true, repoOwner: org, repoName: app_id }),
        });
        const provData = (await provRes.json()) as { steps?: { name: string; status: string; detail: string }[] };
        provisionResult = (provData.steps ?? [])
          .map((s) => `${s.status === "ok" ? "+" : s.status === "skip" ? "~" : "!"} ${s.name}: ${s.detail}`)
          .join("\n");
      }

      return text([
        `App scaffolded: **${name}** (${app_id})`,
        `Repo: https://github.com/${org}/${app_id}`,
        `Live URL: https://${app_id}.proappstore.online`,
        `Data worker: https://data-${app_id}.proappstore.online`,
        repoCreated ? "Repo created from template." : "Repo already existed.",
        provisionResult ? `\nProvisioning:\n${provisionResult}` : "Provisioning skipped (no auth token).",
      ].join("\n"));
    },
  );

  // ── write_file ────────────────────────────────────────────
  server.tool(
    "write_file",
    "Create or overwrite a file in a PAS app's GitHub repo. Commits directly to the main branch.",
    {
      app_id: z.string().describe("App ID"),
      path: z.string().describe("File path relative to repo root (e.g. 'web/src/App.tsx')"),
      content: z.string().describe("Full file content"),
      message: z.string().optional().describe("Commit message (auto-generated if omitted)"),
    },
    async ({ app_id, path, content, message }) => {
      const { token: userToken } = getUserContext();
      if (!userToken) return authError();
      if (!await owns(userToken, app_id)) return ownershipError(app_id);

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
    { app_id: z.string().describe("App ID"), path: z.string().describe("File path relative to repo root") },
    async ({ app_id, path }) => {
      const { token: userToken } = getUserContext();
      if (!userToken) return authError();
      if (!await owns(userToken, app_id)) return ownershipError(app_id);
      const file = await gh.getFile(app_id, path);
      if (!file.ok || file.content === undefined) return text(`File not found: ${path} (${file.status})`);
      return text(file.content);
    },
  );

  // ── list_files ────────────────────────────────────────────
  server.tool(
    "list_files",
    "List all files in a PAS app's GitHub repo.",
    { app_id: z.string().describe("App ID"), path: z.string().optional().describe("Subdirectory path (default: repo root)") },
    async ({ app_id, path }) => {
      const { token: userToken } = getUserContext();
      if (!userToken) return authError();
      if (!await owns(userToken, app_id)) return ownershipError(app_id);
      const res = await gh.listFiles(app_id, path);
      if (!res.ok) return text(`Error listing files: ${res.status}`);
      // Contents API returns a single object when `path` is a file, an array for dirs.
      const raw = res.data as { path: string; type: string; size?: number } | { path: string; type: string; size?: number }[];
      const files = Array.isArray(raw) ? raw : [raw];
      const tree = files.map((f) => `${f.type === "dir" ? "d" : "f"} ${f.path}${f.size ? ` (${f.size}B)` : ""}`).join("\n");
      return text(tree || "Empty directory");
    },
  );

  // ── delete_file ───────────────────────────────────────────
  server.tool(
    "delete_file",
    "Delete a file from a PAS app's GitHub repo.",
    { app_id: z.string().describe("App ID"), path: z.string().describe("File path to delete"), message: z.string().optional().describe("Commit message") },
    async ({ app_id, path, message }) => {
      const { token: userToken } = getUserContext();
      if (!userToken) return authError();
      if (!await owns(userToken, app_id)) return ownershipError(app_id);
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
    { app_id: z.string().describe("App ID"), query: z.string().describe("Search text (case-insensitive)") },
    async ({ app_id, query }) => {
      const { token: userToken } = getUserContext();
      if (!userToken) return authError();
      if (!await owns(userToken, app_id)) return ownershipError(app_id);
      const res = await gh.searchCode(app_id, query);
      if (!res.ok) return text(`Search error: ${res.status}`);
      const items = (res.data as { items?: { path: string; text_matches?: { fragment: string }[] }[] }).items ?? [];
      if (items.length === 0) return text(`No results for "${query}"`);
      const results = items.slice(0, 20).map((item) => {
        const preview = item.text_matches?.[0]?.fragment?.slice(0, 100) ?? "";
        return `${item.path}${preview ? `\n  ...${preview}...` : ""}`;
      }).join("\n");
      return text(`${items.length} result(s):\n\n${results}`);
    },
  );

  // ── get_deploy_status ─────────────────────────────────────
  server.tool(
    "get_deploy_status",
    "Check the latest deploy status for a PAS app (GitHub Actions workflow runs).",
    { app_id: z.string().describe("App ID") },
    async ({ app_id }) => {
      const { token: userToken } = getUserContext();
      if (!userToken) return authError();
      if (!await owns(userToken, app_id)) return ownershipError(app_id);
      const res = await gh.getDeployStatus(app_id);
      if (!res.ok) return text(`Error: ${res.status}`);
      const runs = (res.data as { workflow_runs?: { name: string; conclusion: string | null; status: string; updated_at: string }[] }).workflow_runs ?? [];
      if (runs.length === 0) return text("No workflow runs found. Push to main to trigger deploy.");
      return text(runs.map((r) => {
        const icon = r.conclusion === "success" ? "+" : r.conclusion === "failure" ? "!" : "~";
        return `${icon} ${r.name}: ${r.conclusion ?? r.status} (${r.updated_at})`;
      }).join("\n"));
    },
  );

  // ── provision_app ─────────────────────────────────────────
  server.tool(
    "provision_app",
    "Provision platform resources for an existing PAS app (CF Pages project, DNS, D1 database, data worker). Idempotent.",
    { app_id: z.string().describe("App ID") },
    async ({ app_id }) => {
      const { token: userToken } = getUserContext();
      if (!userToken) return text("Error: authentication required. Connect with a session token.");
      const res = await fetch(`${apiBase}/v1/provision`, {
        method: "POST",
        headers: { Authorization: `Bearer ${userToken}`, "Content-Type": "application/json" },
        body: JSON.stringify({ appId: app_id, skipCompliance: true, repoOwner: org, repoName: app_id }),
      });
      const data = (await res.json()) as { steps?: { name: string; status: string; detail: string }[] };
      const steps = (data.steps ?? [])
        .map((s) => `${s.status === "ok" ? "+" : s.status === "skip" ? "~" : "!"} ${s.name}: ${s.detail}`)
        .join("\n");
      return text(steps || "Provisioning complete (no steps reported).");
    },
  );

  // ── batch_write_files ─────────────────────────────────────
  server.tool(
    "batch_write_files",
    "Write multiple files in a single commit to a PAS app's GitHub repo. More efficient than individual write_file calls.",
    {
      app_id: z.string().describe("App ID"),
      files: z.array(z.object({
        path: z.string().describe("File path relative to repo root"),
        content: z.string().describe("Full file content"),
      })).describe("Array of files to write"),
      message: z.string().describe("Commit message"),
    },
    async ({ app_id, files, message }) => {
      const { token: userToken } = getUserContext();
      if (!userToken) return authError();
      if (!await owns(userToken, app_id)) return ownershipError(app_id);
      const res = await gh.pushFiles(app_id, files, message, { initIfEmpty: true });
      if (!res.ok) return text(`Error committing files: ${res.error ?? "unknown"}`);
      return text(`Committed ${files.length} file(s): ${message}\n${files.map((f) => `  + ${f.path}`).join("\n")}`);
    },
  );
}
