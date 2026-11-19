/**
 * MCP tools for an app's verified email setup (#605, feature #566).
 *
 * Thin by design: the backend's /v1/apps/:appId/email routes (and /v1/admin/email
 * for the attestation) decide who may do what, called with the connection's own
 * PAS session, so they work for whichever identity (GitHub or Google) the
 * session carries. Backend refusals come back unchanged, stable `code` included.
 * There is deliberately no send tool: sending stays with `pas.email.send` in the app.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Env } from "./env.js";
import { audit, gateMutation } from "./safety.js";

type Text = { content: { type: "text"; text: string }[]; isError?: boolean };
// These values are interpolated into the subrequest path: restrict their shape.
const APP_ID = z.string().regex(/^[a-z][a-z0-9-]*$/).describe("App id, e.g. hiring");
const IDENTITY_ID = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/).describe("Identity id, from app_email_status");
const DOMAIN = z.string().regex(/^[A-Za-z0-9.-]{1,253}$/).describe("Domain, e.g. betabuilders.org");
const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;
const WRITE = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;
const REVOKE = { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false } as const;

const json = (v: unknown, isError = false): Text => ({ content: [{ type: "text" as const, text: JSON.stringify(v, null, 2) }], ...(isError ? { isError } : {}) });

export function registerAppEmailTools(
  server: McpServer,
  env: Env,
  getUserContext: () => { userId: string | null; token: string | null },
): void {
  const NOT_AUTHENTICATED = "Not authenticated: connect with your PAS session to use the app email tools.";

  async function api(token: string, method: "GET" | "POST", path: string, body?: unknown): Promise<Text> {
    const res = await env.API.fetch(`${env.API_BASE}${path}`, {
      method,
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const text = await res.text();
    if (!res.ok) return json({ error: `API ${res.status}: ${text}` }, true);
    try { return json(JSON.parse(text)); } catch { return json({ error: `API returned non-JSON: ${text.slice(0, 200)}` }, true); }
  }

  async function read(tool: string, input: Record<string, unknown>, path: string): Promise<Text> {
    const { userId, token } = getUserContext();
    if (!token) return json({ error: NOT_AUTHENTICATED }, true);
    await audit({ env, subject: userId }, { tool, action: "invoked", input });
    return api(token, "GET", path);
  }

  async function write(tool: string, input: Record<string, unknown>, path: string, body: unknown): Promise<Text> {
    const { userId, token } = getUserContext();
    if (!token) return json({ error: NOT_AUTHENTICATED }, true);
    await gateMutation({ env, subject: userId }, tool, input);
    return api(token, "POST", path, body);
  }

  server.tool(
    "app_email_status",
    "Read an app's verified email setup: whether email is configured, suspended, limits and usage today, the claimed domains (pending until a platform administrator attests them) and the sender identities with their status. Owner only. Read-only.",
    { app_id: APP_ID },
    READ_ONLY,
    ({ app_id }) => read("app_email_status", { app_id }, `/v1/apps/${app_id}/email`),
  );

  server.tool(
    "app_email_claim_domain",
    "Claim a domain for an app's verified email (owner only). It stays pending until a platform administrator attests it; a domain belongs to one app. Refusals carry a stable code such as domain_taken or domain_reserved.",
    { app_id: APP_ID, domain: DOMAIN },
    WRITE,
    ({ app_id, domain }) => write("app_email_claim_domain", { app_id, domain }, `/v1/apps/${app_id}/email/domains`, { domain }),
  );

  server.tool(
    "app_email_declare_identity",
    "Declare a sender identity (an address on a claimed domain) for an app. Owner or editor. It starts pending until the owner approves it with app_email_approve_identity.",
    {
      app_id: APP_ID,
      address: z.string().min(3).max(254).describe("Sender address on a claimed domain, e.g. careers@betabuilders.org"),
      display_name: z.string().max(200).optional().describe("Name shown as the sender"),
      reply_to: z.string().max(254).optional().describe("Default Reply-To address"),
    },
    WRITE,
    ({ app_id, address, display_name, reply_to }) =>
      write("app_email_declare_identity", { app_id, address, display_name, reply_to }, `/v1/apps/${app_id}/email/identities`,
        { address, ...(display_name !== undefined ? { displayName: display_name } : {}), ...(reply_to !== undefined ? { replyTo: reply_to } : {}) }),
  );

  server.tool(
    "app_email_approve_identity",
    "Approve a pending sender identity (owner only). allow_external chooses whether it may mail people with no relationship to the app (its creator, team and app-role holders).",
    { app_id: APP_ID, identity_id: IDENTITY_ID, allow_external: z.boolean().describe("true lets this identity mail anyone; false limits it to people related to the app") },
    WRITE,
    ({ app_id, identity_id, allow_external }) =>
      write("app_email_approve_identity", { app_id, identity_id, allow_external }, `/v1/apps/${app_id}/email/identities/${identity_id}/approve`, { allowExternal: allow_external }),
  );

  server.tool(
    "app_email_revoke_identity",
    "Revoke a sender identity (owner only). It stops sending immediately.",
    { app_id: APP_ID, identity_id: IDENTITY_ID },
    REVOKE,
    ({ app_id, identity_id }) =>
      write("app_email_revoke_identity", { app_id, identity_id }, `/v1/apps/${app_id}/email/identities/${identity_id}/revoke`, {}),
  );

  server.tool(
    "app_email_list_sends",
    "List the platform's records of an app's sent email, newest first: status, recipients, delivered/bounced/complained times. Owner or editor. Read-only.",
    { app_id: APP_ID, limit: z.number().int().min(1).max(200).optional().describe("How many records, default 50, max 200") },
    READ_ONLY,
    ({ app_id, limit }) => read("app_email_list_sends", { app_id, limit }, `/v1/apps/${app_id}/email/sends${limit ? `?limit=${limit}` : ""}`),
  );

  server.tool(
    "app_email_list_suppressions",
    "List the addresses suppressed for an app (permanent bounces and complaints), newest first, up to 500. Owner only. Read-only.",
    { app_id: APP_ID },
    READ_ONLY,
    ({ app_id }) => read("app_email_list_suppressions", { app_id }, `/v1/apps/${app_id}/email/suppressions`),
  );

  server.tool(
    "admin_email_attest_domain",
    "Platform administrator only: attest (verified: true) or withdraw (false) that a domain is an onboarded Cloudflare Email Sending zone, and optionally set forward_copy_to, the verified Email Routing destination that gets a copy of inbound mail (null clears it).",
    {
      domain: DOMAIN,
      verified: z.boolean().describe("true attests the domain; false withdraws the attestation and stops every identity on it"),
      forward_copy_to: z.string().max(254).nullable().optional().describe("Mailbox to copy inbound mail to; null clears it; omit to leave it unchanged"),
    },
    WRITE,
    ({ domain, verified, forward_copy_to }) =>
      write("admin_email_attest_domain", { domain, verified, forward_copy_to }, `/v1/admin/email/domains/${domain}`,
        { verified, ...(forward_copy_to !== undefined ? { forwardCopyTo: forward_copy_to } : {}) }),
  );
}
