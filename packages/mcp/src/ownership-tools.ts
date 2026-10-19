/**
 * App ownership transfer and recovery over MCP (#423).
 *
 * Thin by design: every answer and every rule comes from the backend's
 * /v1/apps/:appId/ownership routes, called with the connection's own PAS
 * session. The backend decides who may do what, shows the other party by login
 * only, and hides a recovery requester and the owner from each other — so these
 * tools never see another user's email, id or credentials to leak.
 *
 * The irreversible steps (offering an app, accepting one, an admin approving a
 * move) need `confirm: true`; without it they return what would change hands.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Env } from "./env.js";
import { audit, dryRun, gateMutation } from "./safety.js";

type Text = { content: { type: "text"; text: string }[]; isError?: boolean };
// appId is interpolated into the subrequest path: a plain slug only.
const APP_ID = z.string().regex(/^[a-z][a-z0-9-]*$/).describe("App id, e.g. stash");
const TRANSFER_ID = z.number().int().positive().describe("Transfer or recovery request id, from ownership_status");
const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;
const WRITE = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false } as const;
const MOVES_OWNERSHIP = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false } as const;

const json = (v: unknown, isError = false): Text => ({ content: [{ type: "text" as const, text: JSON.stringify(v, null, 2) }], ...(isError ? { isError } : {}) });

export function registerOwnershipTools(
  server: McpServer,
  env: Env,
  getUserContext: () => { userId: string | null; token: string | null },
): void {
  const NOT_AUTHENTICATED = "Not authenticated: connect with your PAS session to use the ownership tools.";

  /** One backend call with the connection's session: the parsed body, or the backend's own refusal. */
  async function api(token: string, method: "GET" | "POST", path: string, body?: unknown): Promise<{ ok: true; data: Record<string, unknown> } | { ok: false; error: string }> {
    const res = await env.API.fetch(`${env.API_BASE}${path}`, {
      method,
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const text = await res.text();
    if (!res.ok) return { ok: false, error: `API ${res.status}: ${text}` };
    try { return { ok: true, data: JSON.parse(text) as Record<string, unknown> }; } catch { return { ok: false, error: `API returned non-JSON: ${text.slice(0, 200)}` }; }
  }

  function session(): { userId: string | null; token: string } | null {
    const { userId, token } = getUserContext();
    return token ? { userId, token } : null;
  }

  const result = (r: Awaited<ReturnType<typeof api>>): Text => (r.ok ? json(r.data) : json({ error: r.error }, true));

  server.tool(
    "ownership_status",
    "Who owns an app, from your point of view, and any ownership transfer or recovery request you are part of. Any signed-in user may ask: the owner and parties see open requests, history and the immutable audit record (other parties by login only); anyone else learns only that they are not the owner and may file a recovery request — never who the owner is. Read-only.",
    { app_id: APP_ID },
    READ_ONLY,
    async ({ app_id }) => {
      const s = session();
      if (!s) return json({ error: NOT_AUTHENTICATED }, true);
      await audit({ env, subject: s.userId }, { tool: "ownership_status", action: "invoked", input: { app_id } });
      return result(await api(s.token, "GET", `/v1/apps/${app_id}/ownership`));
    },
  );

  server.tool(
    "request_ownership_transfer",
    "Offer your app to another verified PAS account (signed in with GitHub or Google) — the app's owner only. `to` is their GitHub login, email or PAS user id. Without confirm: true (or with dry_run: true) it only shows what changes hands: repository, route and custom domains, data worker, app worker, CI deploy grants, team, licences/billing. With confirm: true it creates a pending request the recipient must accept within 7 days; nothing moves until they do, and you can cancel it with respond_ownership_transfer.",
    {
      app_id: APP_ID,
      to: z.string().min(1).max(320).describe("Recipient: GitHub login, email, or PAS user id (gh:… / google:…)"),
      message: z.string().max(2000).optional().describe("Optional note to the recipient"),
      confirm: z.boolean().optional().describe("Must be true to create the request"),
      dry_run: z.boolean().optional().describe("Preview the implications only"),
    },
    WRITE,
    async ({ app_id, to, message, confirm, dry_run }) => {
      const s = session();
      if (!s) return json({ error: NOT_AUTHENTICATED }, true);
      const ctx = { env, subject: s.userId };
      if (dry_run || confirm !== true) {
        // The backend's own dry run: the same checks, the same implications, nothing written.
        const preview = await api(s.token, "POST", `/v1/apps/${app_id}/ownership/transfer`, { to, dry_run: true });
        if (!preview.ok) return json({ error: preview.error }, true);
        const plan = await dryRun(ctx, "request_ownership_transfer", true, JSON.stringify(preview.data, null, 2), { app_id });
        return json(
          { ...(confirm !== true && !dry_run ? { error: "request_ownership_transfer offers your app to another account: review the implications, then call it again with confirm: true." } : {}), preview: plan },
          confirm !== true && !dry_run,
        );
      }
      await gateMutation(ctx, "request_ownership_transfer", { app_id });
      return result(await api(s.token, "POST", `/v1/apps/${app_id}/ownership/transfer`, { to, ...(message ? { message } : {}) }));
    },
  );

  server.tool(
    "respond_ownership_transfer",
    "Act on an ownership request you are part of. Recipient: `accept` (needs confirm: true — the app becomes yours immediately; dry_run: true shows what you would take on) or `decline`. Sender: `cancel` a transfer you offered; a recovery requester: `cancel` (withdraw) your request. Either party: `escalate` a stuck pending transfer to a platform admin, with an optional reason.",
    {
      app_id: APP_ID,
      transfer_id: TRANSFER_ID,
      action: z.enum(["accept", "decline", "cancel", "escalate"]),
      reason: z.string().max(2000).optional().describe("Why, for escalate"),
      confirm: z.boolean().optional().describe("Must be true to accept"),
      dry_run: z.boolean().optional().describe("For accept: show the transfer and its implications without accepting"),
    },
    MOVES_OWNERSHIP,
    async ({ app_id, transfer_id, action, reason, confirm, dry_run }) => {
      const s = session();
      if (!s) return json({ error: NOT_AUTHENTICATED }, true);
      const ctx = { env, subject: s.userId };
      if (action === "accept" && (dry_run || confirm !== true)) {
        const status = await api(s.token, "GET", `/v1/apps/${app_id}/ownership`);
        if (!status.ok) return json({ error: status.error }, true);
        const open = (status.data.open as { id: number }[] | undefined) ?? [];
        const transfer = open.find((t) => t.id === transfer_id) ?? null;
        if (!transfer) return json({ error: `No open transfer ${transfer_id} for ${app_id} is visible to you.` }, true);
        const plan = await dryRun(ctx, "respond_ownership_transfer", true, JSON.stringify(transfer, null, 2), { app_id, transfer_id, action });
        return json(
          { ...(confirm !== true && !dry_run ? { error: "Accepting makes you the owner of this app immediately: review the transfer, then call again with confirm: true." } : {}), preview: plan },
          confirm !== true && !dry_run,
        );
      }
      await gateMutation(ctx, "respond_ownership_transfer", { app_id, transfer_id, action });
      return result(await api(s.token, "POST", `/v1/apps/${app_id}/ownership/transfer/${transfer_id}/${action}`, action === "escalate" && reason ? { reason } : {}));
    },
  );

  server.tool(
    "request_ownership_recovery",
    "Ask a platform admin to recover an app you created under another sign-in — for a verified account (GitHub or Google) that is not the app's current owner. `evidence` says how you can show it is yours (the other sign-in, the repository, commits). The request goes straight to admin review and never changes ownership by itself; the owner is told a request exists but not who filed it. An app being down or empty is not grounds for recovery.",
    {
      app_id: APP_ID,
      evidence: z.string().min(1).max(2000).describe("How you can show you created this app"),
    },
    WRITE,
    async ({ app_id, evidence }) => {
      const s = session();
      if (!s) return json({ error: NOT_AUTHENTICATED }, true);
      await gateMutation({ env, subject: s.userId }, "request_ownership_recovery", { app_id });
      return result(await api(s.token, "POST", `/v1/apps/${app_id}/ownership/recovery`, { evidence }));
    },
  );

  server.tool(
    "resolve_ownership_request",
    "Platform admins only: decide an escalated ownership transfer or recovery request. `approve` (needs confirm: true) moves the app to the requester, only while the app is still owned by the account the request was filed against, and never to yourself; `reject` leaves the owner in place. A reason is required and is recorded in the immutable audit record both parties can read.",
    {
      app_id: APP_ID,
      transfer_id: TRANSFER_ID,
      action: z.enum(["approve", "reject"]),
      reason: z.string().min(1).max(2000).describe("Why — recorded and shown to both parties"),
      confirm: z.boolean().optional().describe("Must be true to approve"),
    },
    MOVES_OWNERSHIP,
    async ({ app_id, transfer_id, action, reason, confirm }) => {
      const s = session();
      if (!s) return json({ error: NOT_AUTHENTICATED }, true);
      if (action === "approve" && confirm !== true) {
        return json({ error: "Approving moves ownership of the app: inspect it with ownership_status, then call again with confirm: true." }, true);
      }
      await gateMutation({ env, subject: s.userId }, "resolve_ownership_request", { app_id, transfer_id, action });
      return result(await api(s.token, "POST", `/v1/admin/apps/${app_id}/ownership/transfer/${transfer_id}/resolve`, {
        action: action === "approve" ? "approve" : "decline",
        reason,
      }));
    },
  );
}
