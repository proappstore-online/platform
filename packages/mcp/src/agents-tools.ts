/**
 * Agent-team introspection tools — project status, board, activity, cost.
 * Ported from the standalone PAS MCP (proappstore-online/mcp).
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

async function agentsApi(
  agents: Fetcher,
  agentsBase: string,
  path: string,
  userToken: string | null,
  internalToken: string | null,
): Promise<{ ok: boolean; status: number; data: unknown }> {
  const headers: Record<string, string> = { Accept: "application/json" };
  if (userToken) {
    headers.Authorization = `Bearer ${userToken}`;
  } else if (internalToken) {
    headers["X-Internal-Token"] = internalToken;
  } else {
    return { ok: false, status: 401, data: { error: "no auth available" } };
  }
  const res = await agents.fetch(`${agentsBase}${path}`, { headers });
  let data: unknown;
  try {
    data = await res.json();
  } catch {
    data = { error: await res.text().catch(() => "unknown") };
  }
  return { ok: res.ok, status: res.status, data };
}

function txt(text: string) {
  return { content: [{ type: "text" as const, text }] };
}

export function registerAgentsTools(
  server: McpServer,
  getUserContext: () => { userId: string | null; token: string | null },
  internalToken: string | null,
  agentsBase: string,
  agents: Fetcher,
): void {
  server.tool(
    "agent_project_status",
    "Get the agent team's project status for an app — running/paused, monthly cost, budget cap.",
    { app_id: z.string().regex(/^[a-z][a-z0-9-]*$/).describe("App ID (slug)") },
    async ({ app_id }) => {
      const { token } = getUserContext();
      const r = await agentsApi(agents, agentsBase, `/v1/projects/${app_id}`, token, internalToken);
      if (!r.ok) {
        if (r.status === 404) return txt(`No agent team found for "${app_id}".`);
        return txt(`Error: ${r.status} ${JSON.stringify(r.data)}`);
      }
      const p = r.data as {
        id: string; name: string; slug: string; status: string;
        costSpentMonthlyUsd: number; costCapMonthlyUsd: number; repoUrl?: string;
      };
      return txt([
        `**${p.name}** (${p.slug})`,
        `Status: ${p.status === "running" ? "RUNNING" : "PAUSED"}`,
        `Monthly cost: $${(p.costSpentMonthlyUsd ?? 0).toFixed(2)} / $${(p.costCapMonthlyUsd ?? 50).toFixed(2)} cap`,
        p.repoUrl ? `Repo: ${p.repoUrl}` : null,
      ].filter(Boolean).join("\n"));
    },
  );

  server.tool(
    "agent_board",
    "Full Kanban board — all tickets with status, assignee, iteration count, cost.",
    { app_id: z.string().regex(/^[a-z][a-z0-9-]*$/).describe("App ID (slug)") },
    async ({ app_id }) => {
      const { token } = getUserContext();
      const [projR, ticketsR] = await Promise.all([
        agentsApi(agents, agentsBase, `/v1/projects/${app_id}`, token, internalToken),
        agentsApi(agents, agentsBase, `/v1/projects/${app_id}/tickets`, token, internalToken),
      ]);
      if (!projR.ok) return txt(`Error fetching project: ${projR.status}`);
      if (!ticketsR.ok) return txt(`Error fetching tickets: ${ticketsR.status}`);

      const p = projR.data as { status: string; costSpentMonthlyUsd: number; costCapMonthlyUsd: number };
      const tickets = ((ticketsR.data as { tickets: unknown[] }).tickets ?? []) as Array<{
        id: string; seq: number; title: string; status: string;
        assigneeRole: string | null; iterations: number;
        costSpentUsd: number; stuckReason: string | null;
      }>;

      if (tickets.length === 0) return txt(`Project is ${p.status}. No tickets.`);

      const groups = new Map<string, typeof tickets>();
      for (const t of tickets) {
        const list = groups.get(t.status) ?? [];
        list.push(t);
        groups.set(t.status, list);
      }

      const lines = [`**Project: ${p.status}** | $${(p.costSpentMonthlyUsd ?? 0).toFixed(2)}/$${(p.costCapMonthlyUsd ?? 50).toFixed(2)}`, ""];
      const order = [
        "needs-input", "dev-active", "qa-active", "ba-refining",
        "deploying", "qa-failed", "awaiting-approval", "ready",
        "inbox", "done", "failed", "cancelled",
      ];
      for (const status of order) {
        const group = groups.get(status);
        if (!group) continue;
        lines.push(`### ${status} (${group.length})`);
        for (const t of group) {
          const parts = [`#${t.seq} ${t.title}`];
          if (t.assigneeRole) parts.push(`[${t.assigneeRole}]`);
          if (t.iterations > 0) parts.push(`iter:${t.iterations}`);
          if (t.costSpentUsd > 0) parts.push(`$${t.costSpentUsd.toFixed(3)}`);
          if (t.stuckReason) parts.push(`\n  STUCK: ${t.stuckReason}`);
          lines.push(`- ${parts.join(" ")}`);
        }
        lines.push("");
      }
      return txt(lines.join("\n"));
    },
  );

  server.tool(
    "agent_activity",
    "Activity log (audit trail) for an app's agent team.",
    {
      app_id: z.string().regex(/^[a-z][a-z0-9-]*$/).describe("App ID (slug)"),
      last: z.number().optional().describe("Show only the last N entries"),
    },
    async ({ app_id, last }) => {
      const { token } = getUserContext();
      const r = await agentsApi(agents, agentsBase, `/v1/projects/${app_id}/activity`, token, internalToken);
      if (!r.ok) return txt(`Error: ${r.status}`);

      let entries = ((r.data as { activity: unknown[] }).activity ?? []) as Array<{
        id: string; type: string; detail: string; createdAt: number;
      }>;
      if (last && last > 0) entries = entries.slice(-last);
      if (entries.length === 0) return txt("No activity recorded yet.");

      const lines = entries.map((e) => {
        const ts = new Date(e.createdAt).toISOString().replace("T", " ").slice(0, 19);
        return `${ts} [${e.type}] ${e.detail}`;
      });
      return txt(lines.join("\n"));
    },
  );

  server.tool(
    "agent_ticket_detail",
    "One ticket's full conversation — all agent messages.",
    {
      app_id: z.string().regex(/^[a-z][a-z0-9-]*$/).describe("App ID (slug)"),
      ticket_seq: z.number().describe("Ticket number (e.g. 1)"),
    },
    async ({ app_id, ticket_seq }) => {
      const { token } = getUserContext();
      const ticketsR = await agentsApi(agents, agentsBase, `/v1/projects/${app_id}/tickets`, token, internalToken);
      if (!ticketsR.ok) return txt(`Error: ${ticketsR.status}`);
      const tickets = ((ticketsR.data as { tickets: unknown[] }).tickets ?? []) as Array<{
        id: string; seq: number; title: string; status: string;
        assigneeRole: string | null; iterations: number;
        costSpentUsd: number; stuckReason: string | null; rawIdea?: string;
      }>;
      const ticket = tickets.find((t) => t.seq === ticket_seq);
      if (!ticket) return txt(`Ticket #${ticket_seq} not found.`);

      const msgsR = await agentsApi(agents, agentsBase, `/v1/projects/${app_id}/tickets/${ticket.id}/messages`, token, internalToken);
      const messages = msgsR.ok
        ? (((msgsR.data as { messages: unknown[] }).messages ?? []) as Array<{
            id: string; author: string; body: string; createdAt: number;
          }>)
        : [];

      const lines = [
        `**#${ticket.seq} ${ticket.title}**`,
        `Status: ${ticket.status} | Assignee: ${ticket.assigneeRole ?? "none"} | Iterations: ${ticket.iterations} | Cost: $${(ticket.costSpentUsd ?? 0).toFixed(3)}`,
      ];
      if (ticket.stuckReason) lines.push(`STUCK: ${ticket.stuckReason}`);
      if (ticket.rawIdea) lines.push(`\nIdea: ${ticket.rawIdea}`);
      lines.push(`\n--- Messages (${messages.length}) ---`);

      for (const m of messages) {
        const ts = new Date(m.createdAt).toISOString().replace("T", " ").slice(0, 19);
        const body = m.body.length > 2000 ? m.body.slice(0, 2000) + "... [truncated]" : m.body;
        lines.push(`\n[${ts}] **${m.author}**:\n${body}`);
      }
      return txt(lines.join("\n"));
    },
  );

  server.tool(
    "agent_cost",
    "Cost breakdown for an app's agent team — per-role spend, token counts.",
    { app_id: z.string().regex(/^[a-z][a-z0-9-]*$/).describe("App ID (slug)") },
    async ({ app_id }) => {
      const { token } = getUserContext();
      const r = await agentsApi(agents, agentsBase, `/v1/projects/${app_id}/cost`, token, internalToken);
      if (!r.ok) return txt(`Error: ${r.status}`);
      return txt(JSON.stringify(r.data, null, 2));
    },
  );
}
