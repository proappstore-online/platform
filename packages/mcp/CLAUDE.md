# ProAppStore MCP Server

Remote MCP server for AI agents to interact with the ProAppStore platform.

- Endpoint: `mcp.proappstore.online/mcp`
- Dev: `npm install && npm run dev`
- Deploy: `git push origin main` (auto-deploys via GitHub Actions)

## Tools (37 static + dynamic per-app)

### Platform tools (no auth required unless noted)

| Tool | Auth | Description |
|------|------|-------------|
| `whoami` | Connection | Show the authenticated PAS account — uid, login, platform roles, per-app roles, token expiry. Confirms which identity owner-scoped tools run as |
| `list_apps` | Session token | List your published Pro apps |
| `deploy_status` | None | Check GitHub Actions deploy status |
| `schema_status` | Session token | Show an app's D1 migration status (#33) — recent migrate attempts + whether the latest applied or FAILED (surfaces schema drift). Owner-only |
| `app_info` | None | Get app URLs, repo, data worker, status |
| `platform_guide` | None | Fetch skills.md (full platform guide) |
| `sdk_reference` | None | Quick SDK reference (auth, db, storage, maps, AI, subscriptions, hooks, UI, recipes, design_system) |
| `discover_tools` | None | List the per-app tools currently registered (the `<app>/<tool>` set) |
| `recipe` | None | Get a pre-built code recipe (19 available). No name = list all, with name = full code |

### Project tools (build apps over MCP)

Each requires a session token via connection-level auth.

Tools marked **confirm** need `confirm: true` to execute; **dry_run** tools accept
`dry_run: true` to preview the plan without making changes (see Security & safety).

| Tool | Description |
|------|-------------|
| `scaffold_app` | Create a new PAS app from template (GitHub repo + CF Pages + D1 + DNS) — **confirm**, **dry_run** |
| `write_file` | Create/overwrite a file in an app's repo (commits to main) |
| `read_file` | Read a file from an app's repo |
| `list_files` | List files in an app's repo |
| `delete_file` | Delete a file from an app's repo — **confirm**, **dry_run** |
| `search_files` | Search file contents in an app's repo |
| `batch_write_files` | Write multiple files in one commit |
| `get_deploy_status` | Check deploy status for a specific app |
| `provision_app` | Provision platform resources (CF Pages, D1, DNS, data worker) — **dry_run** |
| `publish_app` | Provision + list the app on the public storefront — **confirm**, **dry_run** |

### Agent Teams loop (drive the autonomous build over MCP)

Each takes an explicit `token` (PAS session token) argument. The token's user must
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

### Per-app tools (dynamic)

Beyond the fixed tools above, the server loads each app's own tools from its
`mcp.json` manifest and exposes them as `<app_id>/<tool_name>` (each tool is one
parameterized SQL op against that app's D1, proxied to its data worker; auth via
the caller's session token). Two ways an app gets registered:

- **CLI apps** — `pas publish` reads the repo's `mcp.json` (`PUT /v1/apps/:id/tools`).
- **Agent-built apps** — the Agent Teams deploy stage auto-registers the working
  tree's `mcp.json` after a green deploy (`POST /v1/apps/:id/tools/internal`), so
  every agent-built app with `app.db` data is MCP-callable without a manual step.

Use `discover_tools` to see what's currently available.

## Security & safety model

The safety layer (`src/safety.ts`) is vendored from the PAGS MCP server (the
best-in-class reference) and adapted to PAS's **single-admin trust model**: the
caller is always the owner/operator of what they touch, so PAS deliberately omits
PAGS's per-tool scope taxonomy (read/write/runtime/destructive). Everything else
from the reference is present:

- **OAuth 2.1 + PKCE (S256)** — `src/oauth-provider.ts`. Discovery docs
  (`/.well-known/oauth-authorization-server`, `.../oauth-protected-resource`),
  dynamic client registration (`POST /register`, rate-limited 20/hr/IP), authorize
  + token endpoints. Plaintext PKCE is rejected; non-S256 challenge methods are
  refused. Access tokens are opaque, KV-stored, 24h TTL. `mcp-remote` compatible.
- **Session tokens** — the alternative to browser OAuth: pass a PAS session JWT as
  `Authorization: Bearer` (connection-level) or a per-call `token` arg on the loop
  tools. Verified locally via `verifySession` (`@proappstore/build-core`,
  timing-safe, `exp` enforced). Sessions are 30-day.
- **Audit log** — every mutating tool call (and read-only denials + dry-runs) is
  recorded to `OAUTH_KV` keyed by the verified `uid`, 90-day TTL, secrets redacted.
  Read your own trail with the `mcp_audit_log` tool. Best-effort: no-ops without a
  KV binding or an authenticated subject; reads aren't logged.
- **Read-only mode** — set `MCP_READ_ONLY=1` (server-wide) to block every mutating
  tool (they throw, so a caller can't misreport success). Reads + dry-runs still work.
- **confirm** — irreversible/public tools (`scaffold_app`, `delete_file`,
  `publish_app`) refuse unless called with `confirm: true`.
- **dry_run** — expensive/irreversible tools accept `dry_run: true` to audit +
  return the plan they *would* execute and make no changes. A preview needs no
  `confirm` and is allowed even in read-only mode. Tools: `scaffold_app`,
  `provision_app`, `publish_app`, `delete_file`, `deploy_project`,
  `delete_project_files`.
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

**Known gaps vs. the PAGS reference** (intentional / deferred, not holes): no scope
taxonomy (single-admin model); no token revocation or refresh; rate limiting only
on `POST /register`, not `/token` or tool calls; audit skips reads and
subject-less calls. Revisit if PAS ever authorizes third-party/delegated agents.

## Connect from Claude Code

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
