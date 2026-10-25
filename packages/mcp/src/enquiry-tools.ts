/**
 * Owner-only MCP tools for an app's marketing-site enquiries (#413, epic #411).
 *
 * Thin by design: the backend's /v1/apps/:appId/enquiries routes decide who may
 * read or change an enquiry (the app's owner or a platform admin), called with
 * the connection's own PAS session. Nothing here widens that.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Env } from "./env.js";
import { audit, gateMutation } from "./safety.js";

type Text = { content: { type: "text"; text: string }[]; isError?: boolean };
// appId and enquiry ids are interpolated into the subrequest path: slugs only.
const APP_ID = z.string().regex(/^[a-z][a-z0-9-]*$/).describe("App id, e.g. stash");
const ENQUIRY_ID = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/).describe("Enquiry id, from list_enquiries");
const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;
const WRITE = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;

const json = (v: unknown, isError = false): Text => ({ content: [{ type: "text" as const, text: JSON.stringify(v, null, 2) }], ...(isError ? { isError } : {}) });

export function registerEnquiryTools(
  server: McpServer,
  env: Env,
  getUserContext: () => { userId: string | null; token: string | null },
): void {
  const NOT_AUTHENTICATED = "Not authenticated: connect with your PAS session to use the enquiry tools.";

  async function api(token: string, method: "GET" | "PATCH", path: string, body?: unknown): Promise<Text> {
    const res = await env.API.fetch(`${env.API_BASE}${path}`, {
      method,
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const text = await res.text();
    if (!res.ok) return json({ error: `API ${res.status}: ${text}` }, true);
    try { return json(JSON.parse(text)); } catch { return json({ error: `API returned non-JSON: ${text.slice(0, 200)}` }, true); }
  }

  server.tool(
    "list_enquiries",
    "List enquiries submitted through your app's about- marketing site, newest first, with counts { new, total }. Optional status filter (new or handled). When a page is full, `next.before_id` is the cursor for the following page. Owner (or platform admin) only. Read-only.",
    {
      app_id: APP_ID,
      status: z.enum(["new", "handled"]).optional().describe("Only enquiries in this state"),
      limit: z.number().int().min(1).max(100).optional().describe("Page size, default 50"),
      before_id: ENQUIRY_ID.optional().describe("Cursor: next.before_id from the previous page"),
    },
    READ_ONLY,
    async ({ app_id, status, limit, before_id }) => {
      const { userId, token } = getUserContext();
      if (!token) return json({ error: NOT_AUTHENTICATED }, true);
      await audit({ env, subject: userId }, { tool: "list_enquiries", action: "invoked", input: { app_id, status, limit, before_id } });
      const q = new URLSearchParams();
      if (status) q.set("status", status);
      if (limit) q.set("limit", String(limit));
      if (before_id) q.set("before_id", before_id);
      const qs = q.toString();
      return api(token, "GET", `/v1/apps/${app_id}/enquiries${qs ? `?${qs}` : ""}`);
    },
  );

  server.tool(
    "get_enquiry",
    "Read one enquiry (name, email, message, status, who handled it and when) from your app's about- marketing site. Owner (or platform admin) only. Read-only.",
    { app_id: APP_ID, enquiry_id: ENQUIRY_ID },
    READ_ONLY,
    async ({ app_id, enquiry_id }) => {
      const { userId, token } = getUserContext();
      if (!token) return json({ error: NOT_AUTHENTICATED }, true);
      await audit({ env, subject: userId }, { tool: "get_enquiry", action: "invoked", input: { app_id, enquiry_id } });
      return api(token, "GET", `/v1/apps/${app_id}/enquiries/${enquiry_id}`);
    },
  );

  server.tool(
    "mark_enquiry_handled",
    "Mark an enquiry handled (records you and the time), or set handled: false to put it back to new. Owner (or platform admin) only.",
    {
      app_id: APP_ID,
      enquiry_id: ENQUIRY_ID,
      handled: z.boolean().optional().describe("true (default) marks it handled; false reopens it as new"),
    },
    WRITE,
    async ({ app_id, enquiry_id, handled }) => {
      const { userId, token } = getUserContext();
      if (!token) return json({ error: NOT_AUTHENTICATED }, true);
      await gateMutation({ env, subject: userId }, "mark_enquiry_handled", { app_id, enquiry_id, handled: handled !== false });
      return api(token, "PATCH", `/v1/apps/${app_id}/enquiries/${enquiry_id}`, { status: handled === false ? "new" : "handled" });
    },
  );
}
