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
const PRINCIPAL_ID = z.string().regex(/^tp_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i).describe("Managed principal id returned by create_test_principal (tp_<uuid>)");
const REASON = z.string().max(240).optional().describe("Audit reason; never include credentials or secrets");
const PAGE = {
  limit: z.number().int().min(1).max(100).optional().describe("Page size, default 50, maximum 100"),
  cursor: z.string().min(1).optional().describe("Opaque next_cursor from the preceding page"),
};
const CONFIRM = {
  confirm: z.boolean().optional().describe("Set true only after reviewing the preview"),
  dry_run: z.boolean().optional().describe("Preview without applying; overrides confirm"),
};
const MANAGED_GRANT = {
  principal_id: PRINCIPAL_ID,
  repository: REPOSITORY.refine((v) => /^proappstore-online\//.test(v) || v === "ChessClubs-online/chess-clubs", "Repository must be allowed by PAS"),
  workflow: WORKFLOW.unwrap().describe("Required exact workflow, e.g. .github/workflows/deploy.yml"),
  ref: REF.unwrap().default("refs/heads/main"),
  label: z.string().max(120).optional(),
  environment: z.string().regex(/^[A-Za-z0-9._-]{1,60}$/).optional().describe("Exact GitHub environment claim, e.g. production; omit only if the workflow has none"),
  expires_at: z.number().finite().refine((v) => v > Date.now(), "Expiry must be in the future").describe("Required future grant expiry in epoch milliseconds"),
  session_ttl_seconds: z.number().int().min(60).max(14400).default(3600).describe("Session TTL in seconds, 60..14400; default 3600"),
  scope: z.enum(["user", "creator"]).default("user").describe("Use user for E2E; creator requires explicit authority; never admin"),
  reason: REASON,
};

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

  async function api(token: string, method: "GET" | "POST" | "PATCH" | "DELETE", path: string, body?: unknown) {
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

  // #577: keep the legacy user-backed tools above compatible. These wrappers
  // use the same backend authorization; a local preview grants no authority.
  type Request = { method: "GET" | "POST" | "PATCH" | "DELETE"; path: string; body?: unknown };
  function register(
    name: string,
    description: string,
    shape: z.ZodRawShape,
    request: (args: Record<string, unknown>) => Request,
    mutation = false,
    previewOnly = false,
  ) {
    server.tool(name, `Platform admins only: ${description}`, shape, mutation ? SECURITY_WRITE : READ_ONLY, async (raw) => {
      const { userId, token } = getUserContext();
      if (!userId || !token) return json({ error: NOT_AUTHENTICATED }, true);
      // Parse in the handler too: relational/default validation must apply to
      // previews and applies identically, including non-SDK callers in tests.
      const parsed = z.object(shape).strict().safeParse(raw);
      if (!parsed.success) return json({ error: "Invalid input", issues: parsed.error.issues.map(({ path, message }) => ({ path, message })) }, true);
      const args = parsed.data;
      const req = request(args);
      if (previewOnly || (mutation && (args.dry_run || args.confirm !== true))) {
        const preview = await dryRun({ env, subject: userId }, name, true, JSON.stringify(req, null, 2), req);
        const needsConfirmation = mutation && !args.dry_run && args.confirm !== true;
        return json({ request: req, preview, ...(needsConfirmation ? { error: "Requires confirm: true after reviewing the preview." } : {}) }, needsConfirmation);
      }
      if (mutation) await gateMutation({ env, subject: userId }, name, req);
      else await audit({ env, subject: userId }, { tool: name, action: "invoked" });
      try {
        return result(await api(token, req.method, req.path, req.body));
      } catch {
        return json({ error: "PAS API request failed; retry or inspect service health." }, true);
      }
    });
  }
  const query = (path: string, args: Record<string, unknown>) => {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(args)) if (value !== undefined) params.set(key, String(value));
    return params.size ? `${path}?${params}` : path;
  };
  const principalPath = (id: unknown) => `/v1/admin/test-principals/${id}`;
  const grantPath = (id: unknown) => `/v1/admin/oidc-session-grants/${id}`;
  const description = z.string().max(240).nullable().describe("Bounded principal description; null clears it");
  const id = { principal_id: PRINCIPAL_ID };
  const grantId = { grant_id: z.string().uuid().describe("Grant id returned by the grant listing") };

  register("list_test_principals", "List managed test principals. Follow next_cursor for additional pages.",
    { status: z.enum(["active", "disabled"]).optional(), ...PAGE },
    (args) => ({ method: "GET", path: query("/v1/admin/test-principals", args) }));
  register("read_test_principal", "Read a principal and its latest 100 grants. Use list_principal_grants to paginate all grants.", id,
    ({ principal_id }) => ({ method: "GET", path: principalPath(principal_id) }));
  register("create_test_principal", "Create an isolated test:<slug> subject with no interactive login. Example slug: leads-e2e. Preview first; confirm to apply.",
    { slug: z.string().regex(/^[a-z0-9][a-z0-9-]{2,39}$/).describe("Unique slug, 3..40 lowercase letters, digits and hyphens; e.g. leads-e2e"), description: description.optional(), reason: REASON, ...CONFIRM },
    ({ slug, description, reason }) => ({ method: "POST", path: "/v1/admin/test-principals", body: { slug, description, reason } }), true);
  register("update_test_principal", "Update description only; identity and status are immutable here. Preview first; confirm to apply.",
    { ...id, description, reason: REASON, ...CONFIRM },
    ({ principal_id, description, reason }) => ({ method: "PATCH", path: principalPath(principal_id), body: { description, reason } }), true);
  register("disable_test_principal", "Disable a principal and revoke all its live grants. Existing sessions last until expiry. Preview first; confirm to apply.",
    { ...id, reason: REASON, ...CONFIRM },
    ({ principal_id, reason }) => ({ method: "POST", path: `${principalPath(principal_id)}/disable`, body: { reason } }), true);
  register("enable_test_principal", "Reactivate a disabled principal. Revoked grants remain revoked; enabling restores no grant. Preview first; confirm to apply.",
    { ...id, reason: REASON, ...CONFIRM },
    ({ principal_id, reason }) => ({ method: "POST", path: `${principalPath(principal_id)}/enable`, body: { reason } }), true);
  register("list_principal_grants", "List a principal's OIDC grants, including revoked grants and mint counters. Follow next_cursor.",
    { ...id, ...PAGE }, (args) => ({ method: "GET", path: query("/v1/admin/oidc-session-grants", args) }));
  register("read_oidc_session_grant", "Read one legacy or principal-backed OIDC grant and its mint counters.", grantId,
    ({ grant_id }) => ({ method: "GET", path: grantPath(grant_id) }));
  const grantRequest = ({ confirm: _confirm, dry_run: _dryRun, ...body }: Record<string, unknown>): Request =>
    ({ method: "POST", path: "/v1/admin/oidc-session-grants", body });
  register("create_principal_grant", "Create a bounded principal-backed OIDC grant. Requires workflow and future expiry; defaults to user scope and one hour. Never substitutes a human account. Preview first; confirm to apply.",
    { ...MANAGED_GRANT, ...CONFIRM }, grantRequest, true);
  register("preview_principal_grant", "Validate and preview the exact principal-backed grant request locally. No backend call: does not verify caller admin authority, principal existence or effective app access; apply is authorized by the backend.",
    MANAGED_GRANT, grantRequest, false, true);
  register("revoke_principal_grant", "Revoke an OIDC grant by id with an audit reason. Existing sessions last until expiry. Preview first; confirm to apply.",
    { ...grantId, reason: REASON, ...CONFIRM },
    ({ grant_id, reason }) => ({ method: "DELETE", path: grantPath(grant_id), body: { reason } }), true);
  register("list_test_principal_events", "Read durable secret-free lifecycle/grant audit events, optionally filtered by principal and grant. Follow next_cursor.",
    { principal_id: PRINCIPAL_ID.optional(), grant_id: grantId.grant_id.optional(), ...PAGE },
    (args) => ({ method: "GET", path: query("/v1/admin/test-principal-events", args) }));
}
