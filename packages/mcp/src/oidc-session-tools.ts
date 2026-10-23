/** Platform-admin lifecycle for GitHub Actions OIDC e2e session grants (#475). */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Env } from "./env.js";
import { audit, dryRun, gateMutation } from "./safety.js";

type Text = { content: { type: "text"; text: string }[]; isError?: boolean };
const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;
const SECURITY_WRITE = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false } as const;
const REPOSITORY = z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/).describe("GitHub owner/repository");
const USER_ID = z.string().regex(/^(?:gh|google):\d+$/).describe("Existing PAS OAuth account id (gh:<id> or google:<id>)");
const WORKFLOW = z.string().regex(/^\.github\/workflows\/[A-Za-z0-9._-]+\.ya?ml$/).optional().describe("Optional workflow file restriction");
const REF = z.string().regex(/^refs\/(?:heads|tags)\/[A-Za-z0-9._\/-]+$/).optional().describe("Full git ref; defaults to refs/heads/main");

const json = (value: unknown, isError = false): Text => ({
  content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
  ...(isError ? { isError } : {}),
});

export function registerOidcSessionTools(
  server: McpServer,
  env: Env,
  getUserContext: () => { userId: string | null; token: string | null },
): void {
  const NOT_AUTHENTICATED = "Not authenticated: connect with the configured PAS platform-admin account.";

  async function api(token: string, method: "GET" | "POST" | "DELETE", path: string, body?: unknown) {
    if (!env.INTERNAL_TOKEN) return { ok: false as const, error: "OIDC grant management is unavailable: MCP internal authentication is not configured." };
    const response = await env.API.fetch(`${env.API_BASE}${path}`, {
      method,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
        "X-Internal-Token": env.INTERNAL_TOKEN,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    if (!response.ok) return { ok: false as const, error: `API ${response.status}: ${text}` };
    try {
      return { ok: true as const, data: JSON.parse(text) as Record<string, unknown> };
    } catch {
      return { ok: false as const, error: `API returned non-JSON: ${text.slice(0, 200)}` };
    }
  }

  const result = (response: Awaited<ReturnType<typeof api>>): Text => response.ok
    ? json(response.data)
    : json({ error: response.error }, true);

  server.tool(
    "list_oidc_session_grants",
    "Platform admins only: list GitHub Actions OIDC grants that may mint short-lived creator sessions for live e2e tests, including scope, target account, revocation and mint history. Read-only.",
    {},
    READ_ONLY,
    async () => {
      const { userId, token } = getUserContext();
      if (!token) return json({ error: NOT_AUTHENTICATED }, true);
      await audit({ env, subject: userId }, { tool: "list_oidc_session_grants", action: "invoked" });
      return result(await api(token, "GET", "/v1/admin/oidc-session-grants"));
    },
  );

  server.tool(
    "create_oidc_session_grant",
    "Platform admins only: authorize one GitHub Actions repository/workflow/ref to mint a four-hour non-admin PAS creator session as an existing GitHub or Google smoke account. Security-sensitive: defaults to a preview and requires confirm: true to create.",
    {
      repository: REPOSITORY,
      user_id: USER_ID,
      workflow: WORKFLOW,
      ref: REF,
      label: z.string().max(120).optional(),
      confirm: z.boolean().optional().describe("Must be true to create the grant"),
      dry_run: z.boolean().optional().describe("Preview the exact grant without creating it"),
    },
    SECURITY_WRITE,
    async ({ repository, user_id, workflow, ref, label, confirm, dry_run }) => {
      const { userId, token } = getUserContext();
      if (!token) return json({ error: NOT_AUTHENTICATED }, true);
      const grant = { repository, user_id, ...(workflow ? { workflow } : {}), ...(ref ? { ref } : {}), ...(label ? { label } : {}) };
      if (dry_run || confirm !== true) {
        const preview = await dryRun(
          { env, subject: userId },
          "create_oidc_session_grant",
          true,
          `create ${JSON.stringify({ ...grant, ref: ref ?? "refs/heads/main" }, null, 2)}`,
          { repository, user_id },
        );
        return json({
          ...(confirm !== true && !dry_run ? { error: "Creating this authentication grant requires confirm: true after reviewing the preview." } : {}),
          preview,
        }, confirm !== true && !dry_run);
      }
      await gateMutation({ env, subject: userId }, "create_oidc_session_grant", { repository, user_id });
      return result(await api(token, "POST", "/v1/admin/oidc-session-grants", grant));
    },
  );

  server.tool(
    "revoke_oidc_session_grant",
    "Platform admins only: revoke an OIDC e2e session grant. Existing short-lived sessions remain valid until expiry; future workflow exchanges are denied. Requires confirm: true.",
    {
      grant_id: z.string().uuid().describe("Grant id from list_oidc_session_grants"),
      confirm: z.boolean().optional().describe("Must be true to revoke the grant"),
      dry_run: z.boolean().optional().describe("Preview without revoking"),
    },
    SECURITY_WRITE,
    async ({ grant_id, confirm, dry_run }) => {
      const { userId, token } = getUserContext();
      if (!token) return json({ error: NOT_AUTHENTICATED }, true);
      if (dry_run || confirm !== true) {
        const preview = await dryRun(
          { env, subject: userId },
          "revoke_oidc_session_grant",
          true,
          `revoke grant ${grant_id}; future OIDC exchanges will be denied`,
          { grant_id },
        );
        return json({
          ...(confirm !== true && !dry_run ? { error: "Revoking this authentication grant requires confirm: true after reviewing the preview." } : {}),
          preview,
        }, confirm !== true && !dry_run);
      }
      await gateMutation({ env, subject: userId }, "revoke_oidc_session_grant", { grant_id });
      return result(await api(token, "DELETE", `/v1/admin/oidc-session-grants/${grant_id}`));
    },
  );
}
