/**
 * QA automation tools over MCP — connect and write/run browser e2e tests for
 * any app you own, entirely through MCP. Flow specs live in the platform D1
 * (never the app repo); runs execute headlessly in Cloudflare Browser
 * Rendering and can be watched live at https://<appId>.proappstore.online/__qa/.
 *
 * All calls go to the backend `/v1/apps/:appId/qa/*` routes with the connection's
 * PAS session token; the backend enforces owner / scoped-QA-key auth. Mutations
 * are gated through the same read-only + audit path as the other MCP tools.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Env } from "./env.js";
import { gateMutation } from "./safety.js";

type Text = { content: { type: "text"; text: string }[] };
// Validated: appId is interpolated into internal API subrequest paths
// (/v1/apps/${appId}/qa/…) over a service binding, so reject anything that
// isn't a plain slug to prevent path/endpoint injection.
const APP_ID = z.string().regex(/^[a-z][a-z0-9-]*$/);

const text = (s: string): Text => ({ content: [{ type: "text" as const, text: s }] });
const json = (v: unknown): Text => text(typeof v === "string" ? v : JSON.stringify(v, null, 2));

async function qaCall(
  env: Env,
  token: string | null,
  path: string,
  init?: { method?: string; body?: unknown },
): Promise<unknown> {
  if (!token) return { error: "Not authenticated: connect with your PAS session token (owner) to use QA tools." };
  const res = await env.API.fetch(`${env.API_BASE}${path}`, {
    method: init?.method ?? "GET",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    ...(init?.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
  });
  const body = await res.text();
  if (!res.ok) return { error: `API ${res.status}: ${body}` };
  try {
    return JSON.parse(body);
  } catch {
    return body; // e.g. the Playwright transpile endpoint returns text/plain
  }
}

const stepSchema = z
  .object({
    op: z.enum(["goto", "click", "clickPoint", "fill", "press", "expectVisible", "expectText", "waitFor", "screenshot"]),
  })
  .passthrough();

export function registerQaTools(
  server: McpServer,
  env: Env,
  getUserContext: () => { userId: string | null; token: string | null },
): void {
  const gate = (tool: string, input?: Record<string, unknown>) =>
    gateMutation({ env, subject: getUserContext().userId }, tool, input);

  server.tool(
    "qa_list_flows",
    "List an app's browser e2e test flows. Specs live in the platform, never the app repo. Each flow has an id, name, and steps.",
    { appId: APP_ID.describe("App id, e.g. chess-academy") },
    async ({ appId }) => json(await qaCall(env, getUserContext().token, `/v1/apps/${appId}/qa/flows`)),
  );

  server.tool(
    "qa_save_flow",
    "Create or update ONE browser e2e test flow (owner only). The flow is validated server-side. Steps: goto{path} | click{target} | clickPoint{xPct,yPct} | fill{target,value} | press{key} | expectVisible{target} | expectText{text} | waitFor{ms?|target?} | screenshot{name?}. A target sets exactly one of {label|text|selector}. Prefer assertions over blind waits and include a negative/edge check when the flow allows.",
    {
      appId: APP_ID,
      flow: z
        .object({
          id: z.string().describe("kebab-slug; used as the flow id"),
          name: z.string(),
          startPath: z.string().optional().describe('starting path, e.g. "/"'),
          steps: z.array(stepSchema).min(1),
        })
        .describe("The flow spec."),
    },
    async ({ appId, flow }) => {
      await gate("qa_save_flow", { appId, flowId: flow.id });
      return json(await qaCall(env, getUserContext().token, `/v1/apps/${appId}/qa/flows/${flow.id}`, { method: "PUT", body: { flow } }));
    },
  );

  server.tool(
    "qa_delete_flow",
    "Delete a browser e2e test flow (owner only).",
    { appId: APP_ID, flowId: z.string() },
    async ({ appId, flowId }) => {
      await gate("qa_delete_flow", { appId, flowId });
      return json(await qaCall(env, getUserContext().token, `/v1/apps/${appId}/qa/flows/${flowId}`, { method: "DELETE" }));
    },
  );

  server.tool(
    "qa_run",
    "Queue headless browser test run(s) for an app on the platform (Cloudflare Browser Rendering). Omit flowId to run every flow. Watch any flow live at https://<appId>.proappstore.online/__qa/?flow=<flowId>. Poll results with qa_list_runs.",
    { appId: APP_ID, flowId: z.string().optional().describe("Run one flow; omit to run all.") },
    async ({ appId, flowId }) => {
      await gate("qa_run", { appId, flowId });
      const body = flowId ? { flowId, trigger: "manual" } : { trigger: "manual" };
      return json(await qaCall(env, getUserContext().token, `/v1/apps/${appId}/qa/runs`, { method: "POST", body }));
    },
  );

  server.tool(
    "qa_list_runs",
    "List an app's recent test runs (status, steps passed/total, failed step + error, trigger). Newest first.",
    { appId: APP_ID, flowId: z.string().optional().describe("Filter to one flow.") },
    async ({ appId, flowId }) =>
      json(await qaCall(env, getUserContext().token, `/v1/apps/${appId}/qa/runs${flowId ? `?flowId=${encodeURIComponent(flowId)}` : ""}`)),
  );

  server.tool(
    "qa_run_artifacts",
    "List a run's screenshot artifacts (name, size). Fetch the PNG bytes at GET /v1/apps/:appId/qa/runs/:runId/artifacts/:name with the same auth.",
    { appId: APP_ID, runId: z.string() },
    async ({ appId, runId }) => json(await qaCall(env, getUserContext().token, `/v1/apps/${appId}/qa/runs/${runId}/artifacts`)),
  );

  server.tool(
    "qa_flow_playwright",
    "Get a flow transpiled to a Playwright .spec.ts (for CI parity — run the same flow under Playwright).",
    { appId: APP_ID, flowId: z.string() },
    async ({ appId, flowId }) => json(await qaCall(env, getUserContext().token, `/v1/apps/${appId}/qa/flows/${flowId}/playwright`)),
  );

  server.tool(
    "qa_mint_key",
    "Mint a scoped QA API key for an app (owner only). Use it to connect an external test runner or the QA agent without handing over a session token. Returned ONCE — store it now.",
    { appId: APP_ID },
    async ({ appId }) => {
      await gate("qa_mint_key", { appId });
      return json(await qaCall(env, getUserContext().token, `/v1/apps/${appId}/qa/keys`, { method: "POST", body: {} }));
    },
  );
}
