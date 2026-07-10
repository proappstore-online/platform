/**
 * Platform-info MCP tools — list_apps, deploy_status, app_info,
 * platform_guide, sdk_reference, discover_tools, recipe.
 *
 * Registers the static (non project-building, non app-data) tools on the
 * MCP server.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Env } from "./env.js";
import { getDeployStatus, pasApi } from "./api-helpers.js";
import { buildSdkReferenceSections } from "./sdk-reference.js";
import { fetchTools } from "./tool-loader.js";
import { getRecipe } from "../../agent-teams/src/recipes.js";

export function registerPlatformTools(server: McpServer, env: Env) {
  // ── list_apps ──────────────────────────────────────────────
  server.tool(
    "list_apps",
    "List your published apps on ProAppStore. Requires a session token.",
    { token: z.string().describe("PAS session token") },
    async ({ token }) => {
      const data = (await pasApi(env.API, env.API_BASE, "/v1/apps", token)) as {
        apps?: Array<{ id: string; name: string; category: string | null; description: string | null }>;
        error?: string;
      };
      if (data.error) return { content: [{ type: "text" as const, text: `Error: ${data.error}` }] };
      const apps = data.apps ?? [];
      if (apps.length === 0) return { content: [{ type: "text" as const, text: "No apps yet. Use `pas create my-app` to get started." }] };
      const lines = apps.map(
        (a) => `- **${a.name}** (${a.id}) — ${a.description || a.category || "no description"}\n  Live: https://${a.id}.proappstore.online | Repo: https://github.com/${env.GITHUB_ORG}/${a.id}`
      );
      return { content: [{ type: "text" as const, text: `${apps.length} app(s):\n\n${lines.join("\n")}` }] };
    }
  );

  // ── deploy_status ──────────────────────────────────────────
  server.tool(
    "deploy_status",
    "Check the deploy status of a Pro app (last 5 GitHub Actions runs).",
    { app_id: z.string().describe("App ID (e.g. 'meetup', 'kanban')") },
    async ({ app_id }) => {
      const runs = await getDeployStatus(env.GITHUB_ORG, app_id, env.GITHUB_TOKEN);
      if ("error" in runs) return { content: [{ type: "text" as const, text: `Error: ${(runs as { error: string }).error}` }] };
      if ((runs as Array<unknown>).length === 0)
        return { content: [{ type: "text" as const, text: `No workflow runs found for ${app_id}.` }] };
      const lines = (runs as Array<{ name: string; status: string; updatedAt: string; sha: string; url: string }>).map(
        (r) => `- ${r.status === "success" ? "✅" : r.status === "failure" ? "❌" : "⏳"} ${r.name} (${r.sha}) — ${r.updatedAt}\n  ${r.url}`
      );
      return { content: [{ type: "text" as const, text: `Deploy history for **${app_id}**:\n\n${lines.join("\n")}` }] };
    }
  );

  // ── app_info ───────────────────────────────────────────────
  server.tool(
    "app_info",
    "Get info about any app on ProAppStore — live URL, repo, data worker, store listing.",
    { app_id: z.string().describe("App ID (e.g. 'meetup', 'kanban')") },
    async ({ app_id }) => {
      const domain = "proappstore.online";
      const org = env.GITHUB_ORG;
      const liveUrl = `https://${app_id}.${domain}`;
      const repoUrl = `https://github.com/${org}/${app_id}`;
      const listingUrl = `https://${domain}/apps/${app_id}/`;
      const dataUrl = `https://data-${app_id}.${domain}`;

      let status: string;
      try {
        // App hostnames are served by the route-mapped host worker — a plain
        // same-zone fetch would bypass it and report a false status.
        const check = await env.HOST.fetch(liveUrl, { method: "HEAD" });
        status = check.ok ? "Live (200)" : `Down (${check.status})`;
      } catch {
        status = "Down (unreachable)";
      }

      return {
        content: [{
          type: "text" as const,
          text: [
            `**${app_id}**`,
            `Status: ${status}`,
            `Live: ${liveUrl}`,
            `Repo: ${repoUrl}`,
            `Listing: ${listingUrl}`,
            `Data worker: ${dataUrl}`,
            `Deploy: push to main → auto-deploy via GitHub Actions`,
          ].join("\n"),
        }],
      };
    }
  );

  // ── platform_guide ─────────────────────────────────────────
  server.tool(
    "platform_guide",
    "Get the ProAppStore platform guide (skills.md) for AI-assisted development. Full reference for SDK, CLI, deployment, rules.",
    {},
    async () => {
      const res = await fetch("https://proappstore.online/skills.md");
      if (!res.ok) return { content: [{ type: "text" as const, text: "Failed to fetch skills.md" }] };
      const text = await res.text();
      return { content: [{ type: "text" as const, text }] };
    }
  );

  // ── sdk_reference ──────────────────────────────────────────
  server.tool(
    "sdk_reference",
    "Quick reference for @proappstore/sdk — imports, features, and usage patterns. Covers auth, db, storage, maps, AI, subscriptions, rooms, hooks, and UI components.",
    {
      feature: z.enum([
        "all", "auth", "kv", "counters", "rooms", "proxy",
        "db", "storage", "maps", "ai", "notifications", "sms",
        "subscription", "tenant", "hooks", "ui", "recipes", "design_system"
      ]).optional().describe("Specific feature or 'all'")
    },
    async ({ feature }) => {
      const sections = buildSdkReferenceSections();

      const selected = feature === "all" || !feature
        ? Object.values(sections).join("\n\n")
        : sections[feature] ?? `Unknown feature: ${feature}`;

      return { content: [{ type: "text" as const, text: `# @proappstore/sdk Reference\n\n${selected}` }] };
    }
  );

  // ── discover_tools ─────────────────────────────────────────
  server.tool(
    "discover_tools",
    "List all app data tools available on ProAppStore. Shows tools grouped by app with descriptions and parameters.",
    {},
    async () => {
      const tools = await fetchTools(env.API, env.API_BASE);
      if (tools.length === 0) {
        return { content: [{ type: "text" as const, text: "No app tools registered yet. Apps can expose tools by adding an mcp.json manifest." }] };
      }

      // Group by app
      const byApp = new Map<string, typeof tools>();
      for (const t of tools) {
        const list = byApp.get(t.app_id) ?? [];
        list.push(t);
        byApp.set(t.app_id, list);
      }

      const lines: string[] = [];
      for (const [appId, appTools] of byApp) {
        lines.push(`## ${appId}`);
        for (const t of appTools) {
          const params = Object.entries(t.params)
            .map(([name, def]) => {
              const p = def as { type: string; optional?: boolean; description?: string };
              const opt = p.optional ? '?' : '';
              return `${name}${opt}: ${p.type}${p.description ? ` — ${p.description}` : ''}`;
            })
            .join(', ');
          lines.push(`- **${appId}/${t.name}** [auth required]: ${t.description}`);
          if (params) lines.push(`  Params: ${params}`);
        }
        lines.push('');
      }

      return { content: [{ type: "text" as const, text: `# Available App Tools\n\n${tools.length} tool(s) across ${byApp.size} app(s):\n\n${lines.join("\n")}` }] };
    }
  );

  // ── recipe ──────────────────────────────────────────────────
  server.tool(
    "recipe",
    "Get a pre-built code recipe for common PAS app patterns (CRUD list, forms, modals, maps, AI chat, notifications, etc.). No name = list all recipes. With name = full copy-paste-ready code.",
    { name: z.string().optional().describe("Recipe name (e.g. 'crud-list', 'ai-chat'). Omit to list all.") },
    async ({ name }) => {
      return { content: [{ type: "text" as const, text: getRecipe(name) }] };
    }
  );
}
