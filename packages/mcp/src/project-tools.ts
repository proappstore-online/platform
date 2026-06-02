/**
 * Project-building tools for the AI agent.
 * These let a Managed Agent scaffold, edit, and deploy PAS apps
 * via the MCP server.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

interface ProjectToolsEnv {
  GITHUB_ORG: string;
  GITHUB_TOKEN: string;
  API_BASE: string;
}

interface GitHubFile {
  name: string;
  path: string;
  type: "file" | "dir";
  sha: string;
  size?: number;
}

interface GitHubContent {
  content?: string;
  encoding?: string;
  sha: string;
}

const gh = (token: string) => ({
  headers: {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "User-Agent": "proappstore-mcp",
  },
});

async function ghApi(
  token: string,
  path: string,
  opts?: { method?: string; body?: unknown },
): Promise<{ ok: boolean; status: number; data: unknown }> {
  const res = await fetch(`https://api.github.com${path}`, {
    method: opts?.method ?? "GET",
    headers: {
      ...gh(token).headers,
      ...(opts?.body ? { "Content-Type": "application/json" } : {}),
    },
    ...(opts?.body ? { body: JSON.stringify(opts.body) } : {}),
  });
  const data = await res.json();
  return { ok: res.ok, status: res.status, data };
}

/** Verify the calling user owns the app via the PAS API. */
async function verifyAppOwnership(
  apiBase: string,
  userToken: string,
  appId: string,
): Promise<boolean> {
  try {
    const res = await fetch(`${apiBase}/v1/apps`, {
      headers: { Authorization: `Bearer ${userToken}` },
    });
    if (!res.ok) return false;
    const data = (await res.json()) as { apps?: { id: string }[] };
    return (data.apps ?? []).some((a) => a.id === appId);
  } catch {
    return false;
  }
}

function authError(): { content: { type: "text"; text: string }[] } {
  return { content: [{ type: "text" as const, text: "Error: authentication required. Connect with a session token." }] };
}

function ownershipError(appId: string): { content: { type: "text"; text: string }[] } {
  return { content: [{ type: "text" as const, text: `Error: you don't own app "${appId}". Only the app owner can use project tools on it.` }] };
}

/**
 * Register project-building tools on the MCP server.
 */
export function registerProjectTools(
  server: McpServer,
  env: ProjectToolsEnv,
  getUserContext: () => { userId: string | null; token: string | null },
): void {
  const { GITHUB_ORG: org, GITHUB_TOKEN: ghToken, API_BASE: apiBase } = env;

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

      // 1. Create repo from template
      const createRes = await ghApi(ghToken, `/repos/${org}/template-app/generate`, {
        method: "POST",
        body: {
          owner: org,
          name: app_id,
          description,
          private: false,
        },
      });

      let repoCreated = false;
      if (createRes.ok) {
        repoCreated = true;
      } else if (createRes.status === 422) {
        // Repo already exists
        repoCreated = false;
      } else {
        return { content: [{ type: "text" as const, text: `Error creating repo: ${JSON.stringify(createRes.data)}` }] };
      }

      // 2. Replace APPNAME placeholders in key files
      const filesToPatch = [
        "web/index.html",
        "web/package.json",
        "CLAUDE.md",
      ];

      if (repoCreated) {
        // Give GitHub a moment to finish template copy
        await new Promise((r) => setTimeout(r, 3000));

        for (const filePath of filesToPatch) {
          const fileRes = await ghApi(ghToken, `/repos/${org}/${app_id}/contents/${filePath}`);
          if (!fileRes.ok) continue;

          const fileData = fileRes.data as GitHubContent;
          const content = atob(fileData.content ?? "");
          const patched = content.replaceAll("APPNAME", app_id);

          if (patched !== content) {
            await ghApi(ghToken, `/repos/${org}/${app_id}/contents/${filePath}`, {
              method: "PUT",
              body: {
                message: `chore: replace APPNAME with ${app_id}`,
                content: btoa(patched),
                sha: fileData.sha,
              },
            });
          }
        }
      }

      // 3. Provision platform resources
      let provisionResult = "";
      if (userToken) {
        const provRes = await fetch(`${apiBase}/v1/provision`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${userToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            appId: app_id,
            skipCompliance: true,
            repoOwner: org,
            repoName: app_id,
          }),
        });
        const provData = (await provRes.json()) as { success?: boolean; steps?: { name: string; status: string; detail: string }[] };
        provisionResult = (provData.steps ?? [])
          .map((s) => `${s.status === "ok" ? "+" : s.status === "skip" ? "~" : "!"} ${s.name}: ${s.detail}`)
          .join("\n");
      }

      return {
        content: [{
          type: "text" as const,
          text: [
            `App scaffolded: **${name}** (${app_id})`,
            `Repo: https://github.com/${org}/${app_id}`,
            `Live URL: https://${app_id}.proappstore.online`,
            `Data worker: https://data-${app_id}.proappstore.online`,
            repoCreated ? "Repo created from template." : "Repo already existed.",
            provisionResult ? `\nProvisioning:\n${provisionResult}` : "Provisioning skipped (no auth token).",
          ].join("\n"),
        }],
      };
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
      const { userId, token: userToken } = getUserContext();
      if (!userToken) return authError();
      if (!await verifyAppOwnership(apiBase, userToken, app_id)) return ownershipError(app_id);

      // Check if file exists (need SHA for update)
      const existRes = await ghApi(ghToken, `/repos/${org}/${app_id}/contents/${path}`);
      const sha = existRes.ok ? (existRes.data as GitHubContent).sha : undefined;

      const putRes = await ghApi(ghToken, `/repos/${org}/${app_id}/contents/${path}`, {
        method: "PUT",
        body: {
          message: message ?? `${sha ? "update" : "create"}: ${path}`,
          content: btoa(unescape(encodeURIComponent(content))),
          ...(sha ? { sha } : {}),
        },
      });

      if (!putRes.ok) {
        return { content: [{ type: "text" as const, text: `Error writing ${path}: ${JSON.stringify(putRes.data)}` }] };
      }

      return { content: [{ type: "text" as const, text: `${sha ? "Updated" : "Created"} ${path}` }] };
    },
  );

  // ── read_file ─────────────────────────────────────────────
  server.tool(
    "read_file",
    "Read a file from a PAS app's GitHub repo.",
    {
      app_id: z.string().describe("App ID"),
      path: z.string().describe("File path relative to repo root"),
    },
    async ({ app_id, path }) => {
      const { token: userToken } = getUserContext();
      if (!userToken) return authError();
      if (!await verifyAppOwnership(apiBase, userToken, app_id)) return ownershipError(app_id);

      const res = await ghApi(ghToken, `/repos/${org}/${app_id}/contents/${path}`);
      if (!res.ok) {
        return { content: [{ type: "text" as const, text: `File not found: ${path} (${res.status})` }] };
      }
      const data = res.data as GitHubContent;
      const decoded = decodeURIComponent(escape(atob(data.content ?? "")));
      return { content: [{ type: "text" as const, text: decoded }] };
    },
  );

  // ── list_files ────────────────────────────────────────────
  server.tool(
    "list_files",
    "List all files in a PAS app's GitHub repo (recursive tree).",
    {
      app_id: z.string().describe("App ID"),
      path: z.string().optional().describe("Subdirectory path (default: repo root)"),
    },
    async ({ app_id, path }) => {
      const { token: userToken } = getUserContext();
      if (!userToken) return authError();
      if (!await verifyAppOwnership(apiBase, userToken, app_id)) return ownershipError(app_id);

      const dirPath = path ?? "";
      const res = await ghApi(ghToken, `/repos/${org}/${app_id}/contents/${dirPath}`);
      if (!res.ok) {
        return { content: [{ type: "text" as const, text: `Error listing files: ${res.status}` }] };
      }
      const files = res.data as GitHubFile[];
      const tree = files
        .map((f) => `${f.type === "dir" ? "d" : "f"} ${f.path}${f.size ? ` (${f.size}B)` : ""}`)
        .join("\n");
      return { content: [{ type: "text" as const, text: tree || "Empty directory" }] };
    },
  );

  // ── delete_file ───────────────────────────────────────────
  server.tool(
    "delete_file",
    "Delete a file from a PAS app's GitHub repo.",
    {
      app_id: z.string().describe("App ID"),
      path: z.string().describe("File path to delete"),
      message: z.string().optional().describe("Commit message"),
    },
    async ({ app_id, path, message }) => {
      const { token: userToken } = getUserContext();
      if (!userToken) return authError();
      if (!await verifyAppOwnership(apiBase, userToken, app_id)) return ownershipError(app_id);

      const existRes = await ghApi(ghToken, `/repos/${org}/${app_id}/contents/${path}`);
      if (!existRes.ok) {
        return { content: [{ type: "text" as const, text: `File not found: ${path}` }] };
      }
      const sha = (existRes.data as GitHubContent).sha;

      const delRes = await ghApi(ghToken, `/repos/${org}/${app_id}/contents/${path}`, {
        method: "DELETE",
        body: { message: message ?? `delete: ${path}`, sha },
      });

      if (!delRes.ok) {
        return { content: [{ type: "text" as const, text: `Error deleting ${path}: ${JSON.stringify(delRes.data)}` }] };
      }
      return { content: [{ type: "text" as const, text: `Deleted ${path}` }] };
    },
  );

  // ── search_files ──────────────────────────────────────────
  server.tool(
    "search_files",
    "Search for text across all files in a PAS app's GitHub repo. Returns matching files with line previews.",
    {
      app_id: z.string().describe("App ID"),
      query: z.string().describe("Search text (case-insensitive)"),
    },
    async ({ app_id, query }) => {
      const { token: userToken } = getUserContext();
      if (!userToken) return authError();
      if (!await verifyAppOwnership(apiBase, userToken, app_id)) return ownershipError(app_id);

      const res = await ghApi(
        ghToken,
        `/search/code?q=${encodeURIComponent(query)}+repo:${org}/${app_id}`,
      );
      if (!res.ok) {
        return { content: [{ type: "text" as const, text: `Search error: ${res.status}` }] };
      }
      const data = res.data as { items?: { path: string; text_matches?: { fragment: string }[] }[] };
      const items = data.items ?? [];
      if (items.length === 0) {
        return { content: [{ type: "text" as const, text: `No results for "${query}"` }] };
      }
      const results = items
        .slice(0, 20)
        .map((item) => {
          const preview = item.text_matches?.[0]?.fragment?.slice(0, 100) ?? "";
          return `${item.path}${preview ? `\n  ...${preview}...` : ""}`;
        })
        .join("\n");
      return { content: [{ type: "text" as const, text: `${items.length} result(s):\n\n${results}` }] };
    },
  );

  // ── get_deploy_status ─────────────────────────────────────
  server.tool(
    "get_deploy_status",
    "Check the latest deploy status for a PAS app (GitHub Actions workflow runs).",
    {
      app_id: z.string().describe("App ID"),
    },
    async ({ app_id }) => {
      const { token: userToken } = getUserContext();
      if (!userToken) return authError();
      if (!await verifyAppOwnership(apiBase, userToken, app_id)) return ownershipError(app_id);

      const res = await ghApi(ghToken, `/repos/${org}/${app_id}/actions/runs?per_page=3`);
      if (!res.ok) {
        return { content: [{ type: "text" as const, text: `Error: ${res.status}` }] };
      }
      const data = res.data as { workflow_runs?: { name: string; conclusion: string | null; status: string; updated_at: string; html_url: string }[] };
      const runs = data.workflow_runs ?? [];
      if (runs.length === 0) {
        return { content: [{ type: "text" as const, text: "No workflow runs found. Push to main to trigger deploy." }] };
      }
      const lines = runs.map((r) => {
        const icon = r.conclusion === "success" ? "+" : r.conclusion === "failure" ? "!" : "~";
        return `${icon} ${r.name}: ${r.conclusion ?? r.status} (${r.updated_at})`;
      });
      return { content: [{ type: "text" as const, text: lines.join("\n") }] };
    },
  );

  // ── provision_app ─────────────────────────────────────────
  server.tool(
    "provision_app",
    "Provision platform resources for an existing PAS app (CF Pages project, DNS, D1 database, data worker). Idempotent.",
    {
      app_id: z.string().describe("App ID"),
    },
    async ({ app_id }) => {
      const { token: userToken } = getUserContext();
      if (!userToken) {
        return { content: [{ type: "text" as const, text: "Error: authentication required. Connect with a session token." }] };
      }

      const res = await fetch(`${apiBase}/v1/provision`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${userToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          appId: app_id,
          skipCompliance: true,
          repoOwner: org,
          repoName: app_id,
        }),
      });

      const data = (await res.json()) as { success?: boolean; steps?: { name: string; status: string; detail: string }[] };
      const steps = (data.steps ?? [])
        .map((s) => `${s.status === "ok" ? "+" : s.status === "skip" ? "~" : "!"} ${s.name}: ${s.detail}`)
        .join("\n");

      return {
        content: [{
          type: "text" as const,
          text: steps || "Provisioning complete (no steps reported).",
        }],
      };
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
      if (!await verifyAppOwnership(apiBase, userToken, app_id)) return ownershipError(app_id);

      // Get current commit SHA
      const refRes = await ghApi(ghToken, `/repos/${org}/${app_id}/git/ref/heads/main`);
      if (!refRes.ok) {
        return { content: [{ type: "text" as const, text: `Error: could not get main branch ref (${refRes.status})` }] };
      }
      const commitSha = ((refRes.data as { object: { sha: string } }).object).sha;

      // Get base tree
      const commitRes = await ghApi(ghToken, `/repos/${org}/${app_id}/git/commits/${commitSha}`);
      if (!commitRes.ok) {
        return { content: [{ type: "text" as const, text: `Error: could not get commit (${commitRes.status})` }] };
      }
      const baseTreeSha = ((commitRes.data as { tree: { sha: string } }).tree).sha;

      // Create blobs for each file
      const treeItems: { path: string; mode: string; type: string; sha: string }[] = [];
      for (const file of files) {
        const blobRes = await ghApi(ghToken, `/repos/${org}/${app_id}/git/blobs`, {
          method: "POST",
          body: { content: file.content, encoding: "utf-8" },
        });
        if (!blobRes.ok) {
          return { content: [{ type: "text" as const, text: `Error creating blob for ${file.path}: ${JSON.stringify(blobRes.data)}` }] };
        }
        treeItems.push({
          path: file.path,
          mode: "100644",
          type: "blob",
          sha: (blobRes.data as { sha: string }).sha,
        });
      }

      // Create tree
      const treeRes = await ghApi(ghToken, `/repos/${org}/${app_id}/git/trees`, {
        method: "POST",
        body: { base_tree: baseTreeSha, tree: treeItems },
      });
      if (!treeRes.ok) {
        return { content: [{ type: "text" as const, text: `Error creating tree: ${JSON.stringify(treeRes.data)}` }] };
      }
      const newTreeSha = (treeRes.data as { sha: string }).sha;

      // Create commit
      const newCommitRes = await ghApi(ghToken, `/repos/${org}/${app_id}/git/commits`, {
        method: "POST",
        body: {
          message,
          tree: newTreeSha,
          parents: [commitSha],
        },
      });
      if (!newCommitRes.ok) {
        return { content: [{ type: "text" as const, text: `Error creating commit: ${JSON.stringify(newCommitRes.data)}` }] };
      }
      const newCommitSha = (newCommitRes.data as { sha: string }).sha;

      // Update ref
      const updateRefRes = await ghApi(ghToken, `/repos/${org}/${app_id}/git/refs/heads/main`, {
        method: "PATCH",
        body: { sha: newCommitSha },
      });
      if (!updateRefRes.ok) {
        return { content: [{ type: "text" as const, text: `Error updating ref: ${JSON.stringify(updateRefRes.data)}` }] };
      }

      return {
        content: [{
          type: "text" as const,
          text: `Committed ${files.length} file(s): ${message}\n${files.map((f) => `  + ${f.path}`).join("\n")}`,
        }],
      };
    },
  );
}
