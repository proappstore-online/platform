# ProAppStore MCP Server

Remote MCP server for AI agents to interact with the ProAppStore platform.

- Endpoint: `mcp.proappstore.online/mcp`
- Dev: `npm install && npm run dev`
- Deploy: `git push origin main` (auto-deploys via GitHub Actions)
- Discovery docs (#114): `server.json` (registry manifest — kept equal to the
  registered tool set by `src/server-json.test.ts`), `AGENTS.md` (rules for
  agents), `README.md` (connect + tool tables), `llms.txt`. Explicit failure
  returns go through `errText()` (`src/errors.ts`) so they carry `isError: true`.

## Delivery mode

**Straight to `main`. No branches, no pull requests.** Declared 2026-08-16. Do not run
`git checkout -b`, `git switch -c`, or `gh pr create`; if you find yourself on a non-`main` branch,
stop and report it. See `platform/CLAUDE.md` § Delivery mode.

## Tools (68 shared + dynamic per-app)

### Platform tools (authenticated connection required)

| Tool | Auth | Description |
|------|------|-------------|
| `whoami` | Connection | Show the authenticated PAS account — uid, login, email, sign-in provider, platform roles, token expiry. Confirms which identity owner-scoped tools run as, and answers which email the account is tied to (#136). Email/provider come from `GET /v1/auth/me/account`, which requires INTERNAL_TOKEN as well as the session; without that secret whoami still prints the token-derived identity |
| `list_apps` | Connection | List apps you own or belong to |
| `deploy_status` | None | Check GitHub Actions deploy status |
| `schema_status` | Connection | Show an app's D1 migration status (#33) — recent migrate attempts + whether the latest applied or FAILED (surfaces schema drift). Owner-only |
| `app_info` | None | Get app URLs, repo, data worker, status |
| `find_apps` | Connection | Read-only app directory (#424): every app you reach plus your drafts, searchable by id, name, live/store/repo URL or custom domain, filtered by lifecycle (`status`) and access; an exact id reports `yours` / `accessible` / `unclaimed` / `reserved` / `exists_inaccessible` (never the holder). `check_health` adds live `routeHealth` for the first 25 |
| `list_templates` | None | Approved-template catalogue + selection contract (#178) — read-only; the same data as https://docs.proappstore.online/templates/catalogue.json. Pass an id as `template_repo` to `provision_pas_app`; unknown/withdrawn ids are refused, deprecated ones warn, and the copied source commit is recorded on the app |
| `platform_guide` | None | Fetch skills.md (full platform guide), with the current build-on-AppShell block appended (#237) |
| `sdk_reference` | None | Quick SDK reference. `shell` first: the AppShell-with-`nav` app frame and a complete minimal app. `components`: every UI component. Then auth, db, storage, maps, AI, subscriptions, hooks, UI, recipes, design_system. |
| `list_app_tools` | Connection | One app's registered tools (names, reads/writes, descriptions; params on request). Never SQL. The app's team also sees its staged actions, marked (#428) |
| `call_app_tool` | Connection | Call one app's tool through the platform action executor (mutations audited; refused in read-only mode) |
| `recipe` | None | Get a pre-built code recipe (19 available). No name = list all, with name = full code |

### Project tools (build apps over MCP)

Each requires a session token via connection-level auth.

Tools marked **confirm** need `confirm: true` to execute; **dry_run** tools accept
`dry_run: true` to preview the plan without making changes (see Security & safety).

| Tool | Description |
|------|-------------|
| `provision_pas_app` | Operator workflow: create/reuse a PAS app GitHub repo from `template-app`, configure deploy variables, provision R2 route + D1 + data worker, and verify status — **confirm**, **dry_run** |
| `provisioning_status` | Historical receipt plus bounded, timestamped current deployment and route checks. Fresh diagnostics require current app ownership; no mutation. |
| `scaffold_app` | Legacy create-from-template flow (GitHub repo + R2 route + D1 + data worker) — **confirm**, **dry_run** |
| `write_file` | Create/overwrite a file in an app's repo (commits to main) |
| `read_file` | Read a file from an app's repo |
| `list_files` | List files in an app's repo |
| `delete_file` | Delete a file from an app's repo — **confirm**, **dry_run** |
| `search_files` | Search file contents in an app's repo |
| `batch_write_files` | Write multiple files in one commit |
| `add_marketing_site` | Add template-app's Astro marketing site (`marketing/`) in one commit, never overwriting; pre-fills `site.ts`, adds root scripts, reports whether `deploy.yml` publishes it (#421, = `pas marketing add`) — **dry_run** |
| `get_deploy_status` | Check deploy status for a specific app |
| `provision_app` | Provision platform resources (route, D1, data worker) — **confirm**, **dry_run** |
| `publish_app` | Provision + list the app on the public storefront — **confirm**, **dry_run** |

### Agent Teams loop (drive the autonomous build over MCP)

Every tool uses the OAuth-authenticated connection. No tool takes a credential argument. The user must
own the project and have a BYO Anthropic key in the vault for agents to run.

| Tool | Description |
|------|-------------|
| `create_app` | Create an Agent Teams project (idempotent on slug) |
| `list_projects` | List your projects |
| `get_project` | One project's status (play state, cost, repo) |
| `build_knowledge_base` | Trigger the Architect to write KNOWLEDGE.md + docs/ |
| `chat_agent` | Message the PO (`thread:'build'` → files tickets) or Architect (`thread:'research'` → revises KB) |
| `list_tickets` | The kanban — status + assignee per ticket |
| `list_agents` | Resolved agent catalog (identity, skills, model) |
| `get_project_files` | List working-tree files, or read one (e.g. `KNOWLEDGE.md`) |
| `set_project_budget` | Set monthly cost cap ($1–$1000) |
| `set_project_running` | Play / pause the autonomous build loop |
| `run_tests` | Trigger a Playwright E2E test run |
| `set_model` | Set AI model per agent role (BA/Dev/QA) |
| `add_ticket` | Add a ticket to the backlog directly (bypasses PO chat) |
| `write_project_files` | **Direct/agent-free build** — write the working tree yourself (project must be paused). Pairs with `get_project_files` |
| `delete_project_files` | Remove files from the working tree (project paused) — **dry_run** |
| `deploy_project` | Deploy the current working tree, no LLM (needs a provisioned repo) — **dry_run** |

### Agent introspection tools

Use connection-level auth or internal token.

| Tool | Description |
|------|-------------|
| `agent_project_status` | Project status summary (play state, cost, tickets) |
| `agent_board` | Full kanban board with ticket details |
| `agent_activity` | Recent activity log entries |
| `agent_ticket_detail` | Detailed ticket info with messages |
| `agent_cost` | Cost breakdown by role and model |

### Admin console authoring (#295, #296)

Owner only (the backend enforces it) and audited. All but `apply_admin_update` are read-only
(`readOnlyHint`). They call `/v1/operator-view/capabilities` and
`/v1/apps/:appId/operator-view/{inspect,preview,propose,security}`, which run the backend's own
`validateOperatorView`; none reads app data. `apply_admin_update` (**confirm**, **dry_run**)
validates against the repo's own `mcp.json` tools, refuses an invalid proposal or a failed security
gate, writes only `mcp.json` (the #280 `.github/` guard applies), and waits for the deploy to
report the registration.

| Tool | Description |
|------|-------------|
| `inspect_admin_console` | Stored `operator_view`, referenced actions, gaps against the current tools, what renders |
| `list_admin_capabilities` | Kinds, formats, operations, limits, features, sensitive fields, JSON Schema of `operator_view` |
| `preview_admin_console` | Dry-run a proposal: tabs, columns, actions, role access matrix, blocked fields |
| `propose_admin_update` | Validate without applying: verdict, contract, errors, warnings, missing requirements, security issues (with paths) |
| `validate_admin_security` | Security/compatibility checks; `passesSecurityGates` |
| `apply_admin_update` | Commit to `mcp.json`, then report the registration after deploy — **confirm**, **dry_run** |

### Ownership transfer and recovery (#423)

`src/ownership-tools.ts`, thin over the backend's `/v1/apps/:appId/ownership` routes with the
connection's session: the backend enforces who may act and shows other parties by login only.

| Tool | Description |
|------|-------------|
| `ownership_status` | Your relationship to an app's ownership (owner, recipient, sender, requester, admin or none), open transfer/recovery requests you are party to, and the immutable audit record. Other parties appear by login only; a non-party never learns who the owner is. Read-only. |
| `request_ownership_transfer` | Owner offers the app to a verified PAS account (GitHub login, email or user id). Shows repository, route, data worker, deploy and billing implications first; `confirm: true` creates a 7-day pending request the recipient must accept — **confirm**, **dry_run** |
| `respond_ownership_transfer` | `accept` (needs `confirm`) or `decline` a transfer offered to you; `cancel` one you sent or a recovery request you filed; `escalate` a stuck transfer to a platform admin — **confirm** (accept), **dry_run** (accept) |
| `request_ownership_recovery` | A verified non-owner asks a platform admin to recover an app created under another sign-in, with evidence. Never moves ownership by itself; the owner is not told who asked |
| `resolve_ownership_request` | Platform admins: `approve` (needs `confirm`) or `reject` an escalated request with a required reason, recorded in the audit record. Never to yourself; refused if the owner changed since filing — **confirm** (approve) |

### Per-app tools

An app's `mcp.json` tools are registered **only** on that app's endpoint,
`/mcp/apps/<app_id>`, under their manifest names, alongside `whoami` and
`mcp_audit_log`. The shared `/mcp` endpoint never registers app tools; its size
is fixed (`src/tool-count.ts`, asserted by `tool-count.test.ts`). From `/mcp`,
use `list_app_tools(app_id)` → `call_app_tool(app_id, tool, params)`. Both paths
execute through the platform action executor (`POST /v1/apps/:id/actions/:name`),
which enforces `requires_auth` and the manifest's roles; the MCP layer reads only
the public listing (`GET /v1/apps/:id/tools`, never SQL — #158). Two ways an app
gets registered:

- **CLI apps** — `pas publish` reads the repo's `mcp.json` (`PUT /v1/apps/:id/tools`).
- **Agent-built apps** — the Agent Teams deploy stage auto-registers the working
  tree's `mcp.json` after a green deploy (`POST /v1/apps/:id/tools/internal`), so
  every agent-built app with `app.db` data is MCP-callable without a manual step.

## Security & safety model

The safety layer (`src/safety.ts`) gates consequential operations, records mutations
and enforces read-only mode. Authorization comes from the verified connection plus
the platform's ownership, membership and app-action checks. The shared endpoint
grants broad platform capabilities, disclosed at consent; app endpoints are bound
to one app. Tool annotations describe behavior and are not authorization controls.

- **OAuth 2.1 + PKCE (S256)** — `src/oauth-provider.ts`. Discovery docs
  (`/.well-known/oauth-authorization-server`, `.../oauth-protected-resource`),
  dynamic client registration (`POST /register`, rate-limited 20/hr/IP), authorize
  + token endpoints. Plaintext PKCE is rejected; non-S256 challenge methods are
  refused. Access tokens are opaque, stored in the SQLite OAuthState authority, up to 24h TTL, and bound to the
  requested MCP resource (`/mcp` or `/mcp/apps/<app_id>`). `mcp-remote`
  compatible.
- **Per-app grants (#457)** — a token authorized from `/mcp/apps/<id>` works only on that endpoint
  (`index.ts` refuses a bound token on `/mcp` or any other app, which also closes `list_app_tools` /
  `call_app_tool`). Every authorization writes `grant:<uid>:<appId|_>:<familyId>` (client name and
  timestamps only; no credential), and access tokens carry their `familyId`, so `revokeGrant` kills
  live tokens and the refresh chain together. The API worker lists/revokes through
  `/internal/users/:uid/apps/:appId/grants` and `/internal/users/:uid/grants/:grantId`
  (`X-Internal-Token`) behind `GET /v1/apps/:appId/mcp` and
  `DELETE /v1/apps/:appId/mcp/grants/:grantId`. See `docs/mcp-app-tools.md`.
- **Refresh tokens (#418)** — issued alongside the access token on both the
  `authorization_code` and `refresh_token` grants. Opaque, durably stored, rotate on
  every use (retries within 30 seconds return the same successor; reuse after the window revokes the family), bound to `client_id` and to the appId/resource they were issued for.
  Lifetime is a sliding 30-day window by default (`OAUTH_REFRESH_TTL_SECONDS` to
  override), reset on every successful rotation — a client that keeps renewing retains its grant unless it is revoked or its credentials are lost. Each refresh re-mints the underlying PAS
  session from its original claims, so it keeps working for the full configured retention window (30 days by default)
  even though a session JWT's own TTL is 30 days.
  Privileged roles (anything beyond `user`/`creator`, i.e. `admin`) are
  granted at sign-in and never re-checked, so they last only as long as the
  session the user signed in with (its 30-day `exp`); later refreshes mint
  without them, and admin over MCP needs a fresh sign-in (#429).
- **Connection credentials** — only endpoint-bound MCP OAuth/broker credentials are accepted by the transport. Raw PAS session JWTs and personal app tokens are rejected. The resolved internal PAS session is verified through the canonical build-core verifier. All tool calls use it without model-visible credentials.
- **Audit log** — every mutating tool call (and read-only denials + dry-runs) is
  recorded to `OAUTH_KV` keyed by the verified `uid`, 90-day TTL, secrets redacted.
  Read your own trail with the `mcp_audit_log` tool. Best-effort: no-ops without a
  KV binding or an authenticated subject; reads aren't logged.
- **Read-only mode** — set `MCP_READ_ONLY=1` (server-wide) to block every mutating
  tool (they throw, so a caller can't misreport success). Reads + dry-runs still work.
- **confirm** — irreversible/public/infrastructure tools (`provision_pas_app`, `scaffold_app`,
  `provision_app`, `delete_file`, `publish_app`, `apply_admin_update`, `request_ownership_transfer`, and
  the accept/approve actions of `respond_ownership_transfer` / `resolve_ownership_request`) refuse unless
  called with `confirm: true`.
- **dry_run** — expensive/irreversible tools accept `dry_run: true` to audit +
  return the plan they *would* execute and make no changes. A preview needs no
  `confirm` and is allowed even in read-only mode. Tools: `scaffold_app`,
  `provision_pas_app`, `provision_app`, `publish_app`, `delete_file`, `deploy_project`,
  `delete_project_files`, `apply_admin_update`, `add_marketing_site`, `request_ownership_transfer`,
  `respond_ownership_transfer` (accept).
- **Ownership** — project tools (`write_file`, `read_file`, `provision_app`,
  `publish_app`, …) call `requireOwner` (`verifyAppOwnership`, 60s-cached) so a
  session can only touch apps it owns. Loop/agents/QA tools forward the token and
  let the downstream API enforce ownership.
- **App-tool role pre-flight** — dynamic `<app>/<tool>` tools whose manifest
  declares `auth.platform_roles` are rejected at the MCP edge when the session
  lacks the role (fast, clear error). `app_roles` are **not** pre-checked here (the
  session's per-app roles can lag a fresh D1 grant); the backend
  `enforceActionAuth` (`backend/routes/actions.ts`) is the live authority for both.
- **Input validation** — `app_id`/slug are regex-validated (`^[a-z][a-z0-9-]*$`)
  before being interpolated into service-binding subrequest paths.

**Operational limits:** shared grants are broad rather than per-tool scopes. Only
registration is rate-limited at this layer; service authorization, quotas and budgets
still apply to calls. Audit records mutations, previews and read-only denials, not
every read. See [the operations runbook](../../docs/mcp-operations.md) for deployment,
legacy credential migration, verification and incident handling.

## Connect from Claude Code

Shared platform/operator endpoint:

```json
{
  "mcpServers": {
    "proappstore": {
      "command": "npx",
      "args": ["mcp-remote", "https://mcp.proappstore.online/mcp"]
    }
  }
}
```

Single-app endpoint:

```json
{
  "mcpServers": {
    "crm": {
      "command": "npx",
      "args": ["mcp-remote", "https://mcp.proappstore.online/mcp/apps/crm"]
    }
  }
}
```

## Current transport and OAuth authority

`src/transport.ts` uses the official MCP SDK stateless HTTP transport. Every request
builds its own tool handlers from its verified connection identity and app scope.
`PasMcpAgent` is retained only for compatibility with the existing DO binding and
is not used to serve HTTP. `OAuthState` serializes OAuth transitions in SQLite;
KV is only the bounded read-only legacy migration source and the audit store.
See README for retry/revocation semantics and deployment binding requirements.
