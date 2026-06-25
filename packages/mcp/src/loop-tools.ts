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
import { verifyToken } from "./api-helpers.js";
import { audit, isReadOnly } from "./safety.js";

type Text = { content: { type: "text"; text: string }[] };
const text = (s: string): Text => ({ content: [{ type: "text" as const, text: s }] });

interface LoopEnv {
  AGENTS_BASE: string;
  OAUTH_KV?: KVNamespace;
  MCP_READ_ONLY?: string;
  SESSION_SIGNING_KEY?: string;
}

export function registerLoopTools(server: McpServer, env: LoopEnv): void {
  const base = env.AGENTS_BASE;

  /**
   * Call the Agent Teams API with a bearer token; return parsed JSON or an error
   * string. This is the single chokepoint for all loop tools, so read-only
   * enforcement + audit live here: every non-GET call is gated and recorded
   * (attributed to the token's user). Read-only mode throws so a tool can't
   * report success on a blocked write.
   */
  async function call(
    path: string,
    token: string,
    init?: { method?: string; body?: unknown },
  ): Promise<{ ok: boolean; data: unknown }> {
    const method = init?.method ?? "GET";
    const mutating = method !== "GET";

    if (mutating) {
      const subject = env.SESSION_SIGNING_KEY
        ? (await verifyToken(env.SESSION_SIGNING_KEY, token))?.id ?? null
        : null;
      const ctx = { env, subject };
      if (isReadOnly(env)) {
        await audit(ctx, { tool: `loop:${method} ${path}`, action: "denied", reason: "read_only" });
        throw new Error(`MCP is in read-only mode (MCP_READ_ONLY); ${method} ${path} was blocked.`);
      }
      await audit(ctx, { tool: `loop:${method} ${path}`, action: "invoked", body: init?.body });
    }

    const res = await fetch(`${base}${path}`, {
      method,
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

  // ── run_tests ────────────────────────────────────────────
  server.tool(
    "run_tests",
    "Trigger a Playwright E2E test run for a project. The tests run via GitHub Actions and results appear in the Test tab.",
    { token: TOKEN, slug: SLUG },
    async ({ token, slug }) => {
      const r = await call(`/v1/projects/${slug}/run-tests`, token, { method: "POST" });
      if (!r.ok) return text(String(r.data));
      const d = r.data as { ok?: boolean; specs?: number; runUrl?: string; error?: string };
      return text(d.error ? `Error: ${d.error}` : `Test run started (${d.specs ?? '?'} spec file(s)). ${d.runUrl ?? ''}`);
    },
  );

  // ── set_model ──────────────────────────────────────────────
  server.tool(
    "set_model",
    "Set the AI model for a specific agent role (BA, Dev, or QA). Example models: 'claude-sonnet-4-20250514', 'claude-opus-4-20250514', 'gpt-4o'.",
    {
      token: TOKEN,
      slug: SLUG,
      roles: z.array(z.object({
        role: z.enum(["BA", "Dev", "QA"]).describe("Agent role"),
        model: z.string().describe("Model ID"),
      })).describe("Array of {role, model} pairs to update"),
    },
    async ({ token, slug, roles }) => {
      const r = await call(`/v1/projects/${slug}/roles`, token, { method: "PUT", body: { roles } });
      return text(r.ok ? `Models updated for ${slug}: ${roles.map(rc => `${rc.role}=${rc.model}`).join(', ')}` : String(r.data));
    },
  );

  // ── add_ticket ─────────────────────────────────────────────
  server.tool(
    "add_ticket",
    "Add a ticket to the project's backlog directly (bypasses the PO chat). The ticket enters 'inbox' status and the BA agent refines it when the loop is running.",
    {
      token: TOKEN,
      slug: SLUG,
      title: z.string().describe("Short ticket title"),
      rawIdea: z.string().describe("Full description of what to build/fix"),
    },
    async ({ token, slug, title, rawIdea }) => {
      const r = await call(`/v1/projects/${slug}/tickets`, token, { method: "POST", body: { title, rawIdea } });
      if (!r.ok) return text(String(r.data));
      const d = r.data as { ticket?: { id?: string; seq?: number } };
      return text(`Ticket created: #${d.ticket?.seq ?? '?'} "${title}"`);
    },
  );

  // ── Direct (agent-free) build ──────────────────────────────────
  // Write the project working tree yourself (any AI brain) instead of paying the
  // BYO-key agents, then deploy. Pairs with get_project_files. The DO requires the
  // project PAUSED so a direct edit never races an in-flight agent run.

  server.tool(
    "write_project_files",
    "Directly write files into an Agent Teams project's working tree — agent-free build, for when YOUR client writes the code instead of the BYO-key agents (no repo clone needed). PAUSE the project first (set_project_running running:false). Read context with get_project_files (esp. KNOWLEDGE.md). Then deploy_project. NOTE: this is the agent-teams working tree; for a standalone scaffolded app use batch_write_files (commits to the repo) instead.",
    {
      token: TOKEN,
      slug: SLUG,
      files: z.array(z.object({
        path: z.string().describe("repo-relative path, e.g. src/App.tsx"),
        content: z.string().describe("full file contents"),
      })).describe("Files to create/overwrite (max 200 per call)"),
    },
    async ({ token, slug, files }) => {
      const r = await call(`/v1/projects/${slug}/files`, token, { method: "POST", body: { files } });
      if (!r.ok) return text(String(r.data));
      const d = r.data as { written?: number; totalFiles?: number };
      return text(`Wrote ${d.written ?? files.length} file(s); working tree now has ${d.totalFiles ?? "?"} files. Call deploy_project to ship.`);
    },
  );

  server.tool(
    "delete_project_files",
    "Delete files from an Agent Teams project's working tree (agent-free). The project must be paused.",
    { token: TOKEN, slug: SLUG, paths: z.array(z.string()).describe("repo-relative paths to remove") },
    async ({ token, slug, paths }) => {
      const r = await call(`/v1/projects/${slug}/files`, token, { method: "DELETE", body: { paths } });
      if (!r.ok) return text(String(r.data));
      const d = r.data as { deleted?: number };
      return text(`Deleted ${d.deleted ?? 0} file(s) from the working tree.`);
    },
  );

  server.tool(
    "deploy_project",
    "Deploy the project's current working tree with NO agent/LLM — pushes to GitHub and runs CI. Use after write_project_files for a direct build. Requires a provisioned repo (provision the app first). Poll list_tickets / get_project for status.",
    { token: TOKEN, slug: SLUG },
    async ({ token, slug }) => {
      const r = await call(`/v1/projects/${slug}/deploy`, token, { method: "POST" });
      if (!r.ok) return text(String(r.data));
      const d = r.data as { ticketId?: string };
      return text(`Deploy started (ticket ${d.ticketId ?? "?"}). Poll list_tickets / get_project for status.`);
    },
  );
}
