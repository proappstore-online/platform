/**
 * Agent Teams loop tools — drive the autonomous build process over MCP: create a
 * project, build its Knowledge Base, chat the PO/Architect, file tickets, run the
 * team, and inspect tickets/agents/files. A thin MCP frontend over the Agent
 * Teams REST API (AGENTS_BASE, e.g. agents.proappstore.online).
 *
 * Auth: like `list_apps`, every tool takes an explicit `token` argument (a PAS
 * session token) rather than relying on connection-level auth — so these work
 * regardless of the MCP transport's prop wiring. The token's user must own the
 * project, and must have a BYO Anthropic key in the vault for the agents to run.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

type Text = { content: { type: "text"; text: string }[] };
const text = (s: string): Text => ({ content: [{ type: "text" as const, text: s }] });

interface LoopEnv { AGENTS_BASE: string }

export function registerLoopTools(server: McpServer, env: LoopEnv): void {
  const base = env.AGENTS_BASE;

  /** Call the Agent Teams API with a bearer token; return parsed JSON or an error string. */
  async function call(
    path: string,
    token: string,
    init?: { method?: string; body?: unknown },
  ): Promise<{ ok: boolean; data: unknown }> {
    const res = await fetch(`${base}${path}`, {
      method: init?.method ?? "GET",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      ...(init?.body ? { body: JSON.stringify(init.body) } : {}),
    });
    const raw = await res.text();
    let data: unknown = raw;
    try { data = raw ? JSON.parse(raw) : {}; } catch { /* keep text */ }
    return { ok: res.ok, data: res.ok ? data : `API ${res.status}: ${typeof data === "string" ? data : JSON.stringify(data)}` };
  }

  const TOKEN = z.string().describe("PAS session token (the owner's). The user must also have a BYO Anthropic key in the vault for agents to run.");
  const SLUG = z.string().describe("Project slug / app id (lowercase)");

  // ── create_app ────────────────────────────────────────────
  server.tool(
    "create_app",
    "Create a new Agent Teams project (an app the AI team builds). Idempotent on slug — reusing a slug returns the existing project without creating a new repo. Returns the project.",
    {
      token: TOKEN,
      name: z.string().describe("Display name, e.g. 'Habit Tracker'"),
      slug: z.string().regex(/^[a-z][a-z0-9-]*$/).describe("App id (lowercase, e.g. 'habit-tracker')"),
      idea: z.string().describe("One-paragraph description of what the app is — grounds the PO + Architect."),
    },
    async ({ token, name, slug, idea }) => {
      const r = await call(`/v1/projects`, token, { method: "POST", body: { name, slug, idea } });
      return text(r.ok ? `Project ready: ${slug}\n${JSON.stringify(r.data, null, 2)}` : String(r.data));
    },
  );

  // ── list_projects ─────────────────────────────────────────
  server.tool(
    "list_projects",
    "List your Agent Teams projects (apps in progress).",
    { token: TOKEN },
    async ({ token }) => {
      const r = await call(`/v1/projects`, token);
      if (!r.ok) return text(String(r.data));
      const projects = (r.data as { projects?: { slug: string; name: string }[] }).projects ?? [];
      if (projects.length === 0) return text("No projects yet. Use create_app to start one.");
      return text(projects.map((p) => `- ${p.slug} — ${p.name}`).join("\n"));
    },
  );

  // ── get_project ───────────────────────────────────────────
  server.tool(
    "get_project",
    "Get one project's status (play state, cost, repo, etc.).",
    { token: TOKEN, slug: SLUG },
    async ({ token, slug }) => {
      const r = await call(`/v1/projects/${slug}`, token);
      return text(r.ok ? JSON.stringify(r.data, null, 2) : String(r.data));
    },
  );

  // ── build_knowledge_base ──────────────────────────────────
  server.tool(
    "build_knowledge_base",
    "Trigger the Architect to research the app (it has live web access) and write/refresh its Knowledge Base (KNOWLEDGE.md + docs/). The KB is a conversation, not a ticket — this is a shortcut for chat_agent(thread='research'); running it again refreshes the KB. Returns once started (409 if a build is already in flight); poll get_project_files for KNOWLEDGE.md.",
    { token: TOKEN, slug: SLUG },
    async ({ token, slug }) => {
      const r = await call(`/v1/projects/${slug}/research`, token, { method: "POST" });
      return text(r.ok ? `KB build started for ${slug}. Poll get_project_files for KNOWLEDGE.md.\n${JSON.stringify(r.data)}` : String(r.data));
    },
  );

  // ── chat_agent ────────────────────────────────────────────
  server.tool(
    "chat_agent",
    "Send a message to a conversational agent. thread='build' talks to the PO (it answers and files build tickets); thread='research' talks to the Architect (it revises the Knowledge Base). Returns the agent's reply. Note: the agent runs async — for the PO, follow up with list_tickets to see filed tickets.",
    {
      token: TOKEN,
      slug: SLUG,
      thread: z.enum(["build", "research"]).describe("'build' = PO (tickets), 'research' = Architect (KB)"),
      message: z.string().describe("What to tell the agent (e.g. 'Build the counter app: scaffold + UI + persistence. Break into tickets.')"),
    },
    async ({ token, slug, thread, message }) => {
      const r = await call(`/v1/projects/${slug}/chat`, token, { method: "POST", body: { thread, message } });
      if (!r.ok) return text(String(r.data));
      const d = r.data as { role?: string; body?: string };
      return text(`${d.role ?? "agent"}: ${d.body ?? JSON.stringify(r.data)}`);
    },
  );

  // ── list_tickets ──────────────────────────────────────────
  server.tool(
    "list_tickets",
    "List the project's tickets (the kanban) with status + assignee — use to watch the build loop progress.",
    { token: TOKEN, slug: SLUG },
    async ({ token, slug }) => {
      const r = await call(`/v1/projects/${slug}/tickets`, token);
      if (!r.ok) return text(String(r.data));
      const tickets = (r.data as { tickets?: { seq: number; title: string; status: string; assigneeRole?: string | null; iterations?: number }[] }).tickets ?? [];
      if (tickets.length === 0) return text("No tickets yet.");
      return text(tickets
        .sort((a, b) => a.seq - b.seq)
        .map((t) => `#${t.seq} [${t.status}${t.assigneeRole ? ` · ${t.assigneeRole}` : ""}${t.iterations ? ` · iter ${t.iterations}` : ""}] ${t.title}`)
        .join("\n"));
    },
  );

  // ── list_agents ───────────────────────────────────────────
  server.tool(
    "list_agents",
    "Show the project's agent team — each agent's identity, system prompt source, skills, and model (the resolved catalog).",
    { token: TOKEN, slug: SLUG },
    async ({ token, slug }) => {
      const r = await call(`/v1/projects/${slug}/agents`, token);
      if (!r.ok) return text(String(r.data));
      const agents = (r.data as { agents?: { id: string; surface: string; identitySource: string; tools: string[]; model: string }[] }).agents ?? [];
      return text(agents.map((a) => `${a.id} (${a.surface}) · model ${a.model} · identity ${a.identitySource} · tools: ${a.tools.join(", ") || "—"}`).join("\n"));
    },
  );

  // ── get_project_files ─────────────────────────────────────
  server.tool(
    "get_project_files",
    "List the project's working-tree files (and optionally read one). Use to verify the KB (KNOWLEDGE.md, docs/*.md) or app source the team wrote.",
    { token: TOKEN, slug: SLUG, path: z.string().optional().describe("If set, return this file's content instead of the list.") },
    async ({ token, slug, path }) => {
      // Reading a file: the list endpoint returns paths only (no content) — the
      // content lives behind a separate endpoint.
      if (path) {
        const r = await call(`/v1/projects/${slug}/files/content?path=${encodeURIComponent(path)}`, token);
        if (!r.ok) return text(String(r.data));
        const d = r.data as { content?: string };
        return text(d.content ?? "(empty)");
      }
      const r = await call(`/v1/projects/${slug}/files`, token);
      if (!r.ok) return text(String(r.data));
      const files = (r.data as { files?: { path: string }[] }).files ?? [];
      if (files.length === 0) return text("No files yet — nothing built.");
      return text(files.map((f) => f.path).sort().join("\n"));
    },
  );

  // ── set_project_budget ────────────────────────────────────
  server.tool(
    "set_project_budget",
    "Set the project's monthly cost cap in USD (1–1000). The loop auto-pauses when the team's spend for the month reaches this cap.",
    { token: TOKEN, slug: SLUG, monthly_usd: z.number().min(1).max(1000).describe("Monthly budget cap in USD") },
    async ({ token, slug, monthly_usd }) => {
      const r = await call(`/v1/projects/${slug}/budget`, token, { method: "PUT", body: { costCapMonthlyUsd: monthly_usd } });
      return text(r.ok ? `Budget for ${slug} set to $${monthly_usd}/mo.` : String(r.data));
    },
  );

  // ── set_project_running ───────────────────────────────────
  server.tool(
    "set_project_running",
    "Play (start) or pause the autonomous build loop. Play lets the team pick up ready tickets and build them through to deploy.",
    { token: TOKEN, slug: SLUG, running: z.boolean().describe("true = play, false = pause") },
    async ({ token, slug, running }) => {
      const r = await call(`/v1/projects/${slug}/${running ? "play" : "pause"}`, token, { method: "POST" });
      return text(r.ok ? `Project ${slug} ${running ? "running" : "paused"}.` : String(r.data));
    },
  );
}
