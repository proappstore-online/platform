/**
 * Admin-console authoring tools over MCP (Admin console T4/T5). Part 1, read-only
 * (#295): inspect an app's operator_view, learn what it may contain, preview a
 * proposal. Part 2 (#296): propose (validate without applying), validate the
 * security of a proposal, and apply it — the only tool here that writes: it
 * commits the app repo's mcp.json and reports the registration after deploy.
 *
 * Thin by design: every answer comes from the backend's /v1/operator-view and
 * /v1/apps/:appId/operator-view/* routes, which run the real validateOperatorView
 * (no second validator here) and enforce owner-only access with the connection's
 * PAS session. Nothing is changed and no app data is read. Each call is audited
 * like the other MCP tools; being read-only, they still run in read-only mode.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { makeGitHub } from "@proappstore/build-core";
import type { Env } from "./env.js";
import { audit, dryRun, gateMutation } from "./safety.js";
import { refusedRepoPath } from "./project-tools.js";

type Text = { content: { type: "text"; text: string }[]; isError?: boolean };
// appId is interpolated into the subrequest path: a plain slug only.
const APP_ID = z.string().regex(/^[a-z][a-z0-9-]*$/).describe("App id, e.g. stash");
const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;

const WRITE = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true } as const;
/** The one file apply_admin_update writes. Never anything under .github/ (#280). */
export const MANIFEST_PATH = "mcp.json";
const DEFAULT_WAIT_SECONDS = 120;
const TOOLS_ARG = z.array(z.record(z.unknown())).optional().describe("Optional: the proposed mcp.json tools array, to validate against instead of the registered tools");

const json = (v: unknown, isError = false): Text => ({ content: [{ type: "text" as const, text: JSON.stringify(v, null, 2) }], ...(isError ? { isError } : {}) });

export function registerAdminConsoleTools(
  server: McpServer,
  env: Env,
  getUserContext: () => { userId: string | null; token: string | null },
): void {
  const NOT_AUTHENTICATED = "Not authenticated: connect with your PAS session token (the app's owner) to use the admin-console tools.";

  /** One backend call with the connection's session: the parsed body, or the error to return. */
  async function api(token: string, path: string, body?: unknown): Promise<{ ok: true; data: Record<string, unknown> } | { ok: false; error: string }> {
    const res = await env.API.fetch(`${env.API_BASE}${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const text = await res.text();
    if (!res.ok) return { ok: false, error: `API ${res.status}: ${text}` };
    try { return { ok: true, data: JSON.parse(text) as Record<string, unknown> }; } catch { return { ok: false, error: `API returned non-JSON: ${text.slice(0, 200)}` }; }
  }

  async function call(tool: string, input: Record<string, unknown>, path: string, body?: unknown): Promise<Text> {
    const { userId, token } = getUserContext();
    if (!token) return json({ error: NOT_AUTHENTICATED }, true);
    await audit({ env, subject: userId }, { tool, action: "invoked", input });
    const r = await api(token, path, body);
    return r.ok ? json(r.data) : json({ error: r.error }, true);
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

  server.tool(
    "propose_admin_update",
    "Validate an operator_view proposal for an app WITHOUT applying it — owner only. Returns valid (the platform validator's verdict: an invalid proposal is one a deploy would refuse), the normalized contract, and errors, warnings, missing requirements (unregistered actions, unselected columns) and security issues, each with a path. Set validateAgainstActions false to check the structure only.",
    {
      appId: APP_ID,
      proposal: z.record(z.unknown()).describe("The proposed operator_view object, as it would appear in mcp.json"),
      validateAgainstActions: z.boolean().default(true).describe("Check the referenced actions, their roles and columns (default true)"),
      tools: TOOLS_ARG,
    },
    READ_ONLY,
    async ({ appId, proposal, validateAgainstActions, tools }) =>
      call("propose_admin_update", { appId, validateAgainstActions }, `/v1/apps/${appId}/operator-view/propose`, {
        operator_view: proposal, validate_against_actions: validateAgainstActions !== false, ...(tools ? { tools } : {}),
      }),
  );

  server.tool(
    "validate_admin_security",
    "Security and compatibility checks on an operator_view proposal — owner only: secret-field exposure, missing actions, destructive actions without step_up, audit and admin role errors, undefined roles, and row-scoping smells in the referenced SQL (unscoped writes, SELECT *, caller-scoped or unbounded reads). Returns passesSecurityGates and each issue with path, code and severity.",
    { appId: APP_ID, proposal: z.record(z.unknown()).describe("The proposed operator_view object"), tools: TOOLS_ARG },
    READ_ONLY,
    async ({ appId, proposal, tools }) => {
      const { userId, token } = getUserContext();
      if (!token) return json({ error: NOT_AUTHENTICATED }, true);
      await audit({ env, subject: userId }, { tool: "validate_admin_security", action: "invoked", input: { appId } });
      const r = await api(token, `/v1/apps/${appId}/operator-view/security`, { operator_view: proposal, ...(tools ? { tools } : {}) });
      if (!r.ok) return json({ error: r.error }, true);
      return json({ passesSecurityGates: r.data.passes_security_gates === true, ...r.data });
    },
  );

  server.tool(
    "apply_admin_update",
    "Apply an operator_view proposal to an app — owner only, requires confirm: true (or dry_run: true to preview). Validates it against the tools in the app repo's own mcp.json with the platform validator and security gates, refuses anything invalid or failing a gate, then commits ONE change to mcp.json on main (never anything else, never under .github/). The deploy registers it: this waits up to wait_seconds for that deploy and reports the registration status.",
    {
      appId: APP_ID,
      proposal: z.record(z.unknown()).describe("The operator_view object to write into mcp.json"),
      confirm: z.boolean().optional().describe("Must be true to write (commits to main and deploys)"),
      message: z.string().min(1).max(200).optional().describe("Commit message (default: feat(admin-console): update operator_view)"),
      dry_run: z.boolean().optional().describe("Validate and show the change without committing"),
      wait_seconds: z.number().int().min(0).max(240).optional().describe(`How long to wait for the deploy that registers it (default ${DEFAULT_WAIT_SECONDS})`),
    },
    WRITE,
    async ({ appId, proposal, confirm, message, dry_run, wait_seconds }) => {
      const { userId, token } = getUserContext();
      if (!token) return json({ error: NOT_AUTHENTICATED }, true);
      if (!dry_run && confirm !== true) {
        return json({ error: "apply_admin_update commits mcp.json to main and deploys: call it again with confirm: true (or dry_run: true to preview the change)." }, true);
      }
      const guard = refusedRepoPath(MANIFEST_PATH);
      if (guard) return json({ error: `Refused: ${guard}` }, true);
      const ctx = { env, subject: userId };
      const gh = makeGitHub(env.GITHUB_TOKEN, env.GITHUB_ORG);

      // The manifest the deploy will register: validate against ITS tools, not the registered ones.
      const file = await gh.getFile(appId, MANIFEST_PATH);
      if (!file.ok || file.content === undefined) return json({ error: `could not read ${MANIFEST_PATH} from the app repo (${file.status}); create it first` }, true);
      let manifest: Record<string, unknown>;
      try {
        const parsed = JSON.parse(file.content) as unknown;
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
        manifest = parsed as Record<string, unknown>;
      } catch {
        return json({ error: `${MANIFEST_PATH} in the app repo is not a JSON object; fix it before applying` }, true);
      }

      // Owner-only and the validator's verdict, both from the backend: a non-owner gets its 403, an invalid proposal is never written.
      const checked = await api(token, `/v1/apps/${appId}/operator-view/propose`, {
        operator_view: proposal, tools: Array.isArray(manifest.tools) ? manifest.tools : [],
      });
      if (!checked.ok) return json({ error: checked.error }, true);
      const report = checked.data;
      if (report.valid !== true || report.passes_security_gates !== true) {
        return json({ error: "not applied: the proposal is invalid or fails the security gates", report }, true);
      }

      // Replace operator_view in place (its key keeps its position), everything else untouched.
      const next = { ...manifest, operator_view: proposal };
      const content = `${JSON.stringify(next, null, 2)}\n`;
      const contract = report.contract as { resources?: unknown[]; actions?: unknown[] } | null;
      const summary = `${contract?.resources?.length ?? 0} resource(s), ${contract?.actions?.length ?? 0} action(s)`;
      if (content === file.content) return json({ applied: false, reason: `${MANIFEST_PATH} already holds this operator_view`, report });

      const plan = `commit ${MANIFEST_PATH} to main of ${env.GITHUB_ORG}/${appId} with operator_view = ${summary}; the deploy then registers it`;
      const preview = await dryRun(ctx, "apply_admin_update", dry_run, plan, { appId });
      if (preview) return json({ dry_run: true, plan: preview, report });

      await gateMutation(ctx, "apply_admin_update", { appId, resources: contract?.resources?.length ?? 0, actions: contract?.actions?.length ?? 0 });
      const put = await gh.putFile(appId, MANIFEST_PATH, content, message ?? "feat(admin-console): update operator_view (apply_admin_update)", file.sha);
      if (!put.ok) return json({ error: `committing ${MANIFEST_PATH} failed (${put.status}): ${JSON.stringify(put.data).slice(0, 300)}` }, true);
      const sha = ((put.data as { commit?: { sha?: string } }).commit?.sha) ?? null;

      // Registration happens in the deploy run for this commit (it fails the run if registration fails).
      let registration: Record<string, unknown> = { status: "pending", next: "call inspect_admin_console once the deploy finishes" };
      if (sha) {
        const deploy = await gh.deployResult(appId, { sha, waitMs: (wait_seconds ?? DEFAULT_WAIT_SECONDS) * 1000 });
        if (!deploy.ok && deploy.status === "pending") {
          registration = { status: "pending", deploy, next: "the deploy has not finished; call inspect_admin_console later" };
        } else if (!deploy.ok) {
          registration = { status: "failed", deploy, next: "the deploy failed — see errorTail (a registration error names the action or field)" };
        } else {
          const now = await api(token, `/v1/apps/${appId}/operator-view/inspect`);
          const registered = now.ok && JSON.stringify(now.data.contract) === JSON.stringify(report.contract);
          registration = registered
            ? { status: "registered", deploy: { url: deploy.url, conclusion: deploy.conclusion } }
            : { status: "deployed_contract_differs", deploy: { url: deploy.url, conclusion: deploy.conclusion }, next: "the registered contract is not this one (a later commit?) — check inspect_admin_console" };
        }
      }
      return json({ applied: true, commit: { sha, path: MANIFEST_PATH }, summary, warnings: report.warnings, security_issues: report.security_issues, registration });
    },
  );
}

