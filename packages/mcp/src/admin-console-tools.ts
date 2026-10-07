/**
 * Admin-console authoring tools over MCP, part 1: read-only (#295, Admin console
 * T4). An agent inspects an app's operator_view, learns what the contract may
 * contain, and previews a proposal before writing it into mcp.json.
 *
 * Thin by design: every answer comes from the backend's /v1/operator-view and
 * /v1/apps/:appId/operator-view/* routes, which run the real validateOperatorView
 * (no second validator here) and enforce owner-only access with the connection's
 * PAS session. Nothing is changed and no app data is read. Each call is audited
 * like the other MCP tools; being read-only, they still run in read-only mode.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Env } from "./env.js";
import { audit } from "./safety.js";

type Text = { content: { type: "text"; text: string }[]; isError?: boolean };
// appId is interpolated into the subrequest path: a plain slug only.
const APP_ID = z.string().regex(/^[a-z][a-z0-9-]*$/).describe("App id, e.g. stash");
const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;

const json = (v: unknown, isError = false): Text => ({ content: [{ type: "text" as const, text: JSON.stringify(v, null, 2) }], ...(isError ? { isError } : {}) });

export function registerAdminConsoleTools(
  server: McpServer,
  env: Env,
  getUserContext: () => { userId: string | null; token: string | null },
): void {
  async function call(tool: string, input: Record<string, unknown>, path: string, body?: unknown): Promise<Text> {
    const { userId, token } = getUserContext();
    if (!token) return json({ error: "Not authenticated: connect with your PAS session token (the app's owner) to use the admin-console tools." }, true);
    await audit({ env, subject: userId }, { tool, action: "invoked", input });
    const res = await env.API.fetch(`${env.API_BASE}${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const text = await res.text();
    if (!res.ok) return json({ error: `API ${res.status}: ${text}` }, true);
    try { return json(JSON.parse(text)); } catch { return json({ error: `API returned non-JSON: ${text.slice(0, 200)}` }, true); }
  }

  server.tool(
    "inspect_admin_console",
    "Inspect an app's admin console (operator_view) — owner only. Returns the stored contract, the query/execute actions it references (operation, params, app roles, step_up, callers), gaps against the app's current tools (action_missing, wrong_operation, not_role_gated, not_user_callable, step_up_missing, column_not_selected, sensitive_field…), and what renders per resource. Reads no app data.",
    { appId: APP_ID },
    READ_ONLY,
    async ({ appId }) => call("inspect_admin_console", { appId }, `/v1/apps/${appId}/operator-view/inspect`),
  );

  server.tool(
    "list_admin_capabilities",
    "What an app's admin console contract (mcp.json operator_view) may contain: resource kinds, column formats, action operations, limits (20 resources, 20 actions, …), supported features, the sensitive-field list, the rules that need the app's tools, and the JSON Schema of operator_view including admin_access.",
    {},
    READ_ONLY,
    async () => call("list_admin_capabilities", {}, "/v1/operator-view/capabilities"),
  );

  server.tool(
    "preview_admin_console",
    "Dry-run an operator_view proposal for an app — owner only. Runs the platform's own contract validator against the app's registered tools (or a proposed mcp.json `tools` array) and, when valid, renders it: tabs, columns, row actions, the role access matrix, and which fields the sensitive-field list blocks. Stores nothing and reads no app data, so it never shows a field value.",
    {
      appId: APP_ID,
      proposal: z.record(z.unknown()).describe("The proposed operator_view object, as it would appear in mcp.json"),
      tools: z.array(z.record(z.unknown())).optional().describe("Optional: the proposed mcp.json tools array, to validate against instead of the registered tools"),
    },
    READ_ONLY,
    async ({ appId, proposal, tools }) =>
      call("preview_admin_console", { appId, ...(tools ? { tools: tools.length } : {}) }, `/v1/apps/${appId}/operator-view/preview`, {
        operator_view: proposal,
        ...(tools ? { tools } : {}),
      }),
  );
}
