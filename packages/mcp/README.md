# ProAppStore MCP server

Remote MCP server for AI agents working with [ProAppStore](https://proappstore.online)
(PAS), the Pro app marketplace: build Pro apps (write files directly or drive the
autonomous Agent Teams loop), provision and deploy them, inspect deploys and D1
schema, author and run browser e2e flows, read the platform guide and SDK
reference, and reach any published app's registered data tools.

| | |
|---|---|
| Endpoint | `https://mcp.proappstore.online/mcp` (streamable HTTP) |
| Per-app endpoint | `https://mcp.proappstore.online/mcp/apps/<app_id>` — that app's own tools |
| Auth | OAuth 2.1 + PKCE (S256) with dynamic client registration, or `Authorization: Bearer <PAS session JWT>` |
| Discovery | [`server.json`](./server.json) (MCP registry manifest) · [`AGENTS.md`](./AGENTS.md) (rules for agents) · [`llms.txt`](./llms.txt) · [`CLAUDE.md`](./CLAUDE.md) (maintainer notes) · [`.well-known/oauth-authorization-server`](https://mcp.proappstore.online/.well-known/oauth-authorization-server) |
| Source | `packages/mcp` in [proappstore-online/platform](https://github.com/proappstore-online/platform); deploys on push to `main` |

## Connect

Claude Code:

```bash
claude mcp add proappstore -- npx mcp-remote https://mcp.proappstore.online/mcp
```

Codex:

```bash
codex mcp add proappstore --url https://mcp.proappstore.online/mcp
```

Project-local `.mcp.json`:

```json
{
  "mcpServers": {
    "proappstore": { "command": "npx", "args": ["mcp-remote", "https://mcp.proappstore.online/mcp"] },
    "crm": { "command": "npx", "args": ["mcp-remote", "https://mcp.proappstore.online/mcp/apps/crm"] }
  }
}
```

The first connection opens the browser for OAuth (GitHub or Google, via the
platform). Scripts can skip the browser by sending a PAS session JWT as the
bearer instead. Tokens are bound to the endpoint they were issued for: a token
for `/mcp/apps/crm` does not open `/mcp`.

## Tools

53 tools on the shared endpoint (the count is pinned in `src/tool-count.ts` and
checked against `server.json` by `src/server-json.test.ts`). Tools marked
**confirm** refuse unless called with `confirm: true`; **dry_run** tools accept
`dry_run: true` to return the plan without changing anything.

### Connection

| Tool | Description |
|---|---|
| `whoami` | The account this connection is authenticated as — uid, login, email, provider, platform roles, token expiry. |
| `mcp_audit_log` | Your recent MCP audit events (mutating calls, dry-runs, read-only denials), redacted, 90-day retention. |

### Platform

| Tool | Description |
|---|---|
| `list_apps` | List your published apps on ProAppStore. |
| `deploy_status` | Check the deploy status of a Pro app (last 5 GitHub Actions runs). |
| `schema_status` | Show an app's D1 migration status (#33) — recent deploy-time migration attempts and whether the latest one applied or FAILED. |
| `list_templates` | List the approved ProAppStore app templates and the selection contract: id, purpose, supported categories, required SDK/CLI/Node, capabilities, sec… |
| `app_info` | Get info about any app on ProAppStore — live URL, repo, data worker, store listing. |
| `platform_guide` | Get the ProAppStore platform guide (skills.md) for AI-assisted development. |
| `sdk_reference` | Quick reference for @proappstore/sdk — imports, features, and usage patterns. |
| `recipe` | Get a pre-built code recipe for common PAS app patterns (CRUD list, forms, modals, maps, AI chat, notifications, etc.). |

### App data tools (any published app)

| Tool | Description |
|---|---|
| `list_app_tools` | One app's registered tools (names, reads/writes, descriptions; params on request). |
| `call_app_tool` | Call one app's registered tool through the platform action executor (mutations audited; refused in read-only mode). |

An app's registered actions (`mcp.json`) are reached from the shared endpoint
with `list_app_tools(app_id)` → `call_app_tool(app_id, tool, params)`, or
directly on the app's own endpoint where they appear under their manifest names.
Execution always goes through the platform action executor, which enforces
`requires_auth` and the manifest's roles; the MCP layer never sees SQL. Large
manifests are exposed progressively (a core set stays resident; the rest is
found with `discover_tools` / `describe_tool` on the app endpoint).

### Project (build a PAS app over MCP)

| Tool | Description |
|---|---|
| `provision_pas_app` | Operator workflow: create or reuse a PAS app GitHub repo from template-app, configure deploy credentials/placeholders, provision platform infrastru… — **confirm**, **dry_run** |
| `scaffold_app` | Create a new PAS app. — **confirm**, **dry_run** |
| `write_file` | Create or overwrite a file in a PAS app's GitHub repo. |
| `read_file` | Read a file from a PAS app's GitHub repo. |
| `list_files` | List all files in a PAS app's GitHub repo. |
| `delete_file` | Delete a file from a PAS app's GitHub repo. — **confirm**, **dry_run** |
| `search_files` | Search for text across all files in a PAS app's GitHub repo. |
| `get_deploy_status` | Check the latest deploy status for a PAS app (GitHub Actions workflow runs). |
| `provision_app` | Provision platform resources for a PAS app (R2 route, D1 database, data worker). — **dry_run** |
| `publish_app` | Publish a PAS app to the storefront. — **confirm**, **dry_run** |
| `batch_write_files` | Write multiple files in a single commit to a PAS app's GitHub repo. |

### Agent Teams (drive the autonomous build loop)

| Tool | Description |
|---|---|
| `create_app` | Create a new Agent Teams project (an app the AI team builds). |
| `list_projects` | List your Agent Teams projects (apps in progress). |
| `get_project` | Get one project's status (play state, cost, repo, etc.). |
| `build_knowledge_base` | Trigger the Architect to research the app (it has live web access) and write/refresh its Knowledge Base (KNOWLEDGE.md + docs/). |
| `chat_agent` | Send a message to a conversational agent. |
| `list_tickets` | List the project's tickets (the kanban) with status + assignee — use to watch the build loop progress. |
| `list_agents` | Show the project's agent team — each agent's identity, system prompt source, skills, and model (the resolved catalog). |
| `get_project_files` | List the project's working-tree files (and optionally read one). |
| `set_project_budget` | Set the project's monthly cost cap in USD (1–1000). |
| `set_project_running` | Play (start) or pause the autonomous build loop. |
| `run_tests` | Trigger a Playwright E2E test run for a project. |
| `set_model` | Set the AI model for a specific agent role (BA, Dev, or QA). |
| `add_ticket` | Add a ticket to the project's backlog directly (bypasses the PO chat). |
| `update_ticket` | Edit an existing backlog ticket's wording: its title and/or its description and reasoning (`rawIdea` — the full statement of what to build/fix and… |
| `write_project_files` | Directly write files into an Agent Teams project's working tree — agent-free build, for when YOUR client writes the code instead of the BYO-key age… |
| `delete_project_files` | Delete files from an Agent Teams project's working tree (agent-free). — **dry_run** |
| `deploy_project` | Deploy the project's current working tree with NO agent/LLM — pushes to GitHub and runs CI. — **dry_run** |

### Agent introspection

| Tool | Description |
|---|---|
| `agent_project_status` | Get the agent team's project status for an app — running/paused, monthly cost, budget cap. |
| `agent_board` | Full Kanban board — all tickets with status, assignee, iteration count, cost. |
| `agent_activity` | Activity log (audit trail) for an app's agent team. |
| `agent_ticket_detail` | One ticket's full conversation — all agent messages. |
| `agent_cost` | Cost breakdown for an app's agent team — per-role spend, token counts. |

### QA (browser e2e flows, platform-run)

| Tool | Description |
|---|---|
| `qa_list_flows` | List an app's browser e2e test flows. |
| `qa_save_flow` | Create or update ONE browser e2e test flow (owner only). |
| `qa_delete_flow` | Delete a browser e2e test flow (owner only). |
| `qa_run` | Queue headless browser test run(s) for an app on the platform (Cloudflare Browser Rendering). |
| `qa_list_runs` | List an app's recent test runs (status, steps passed/total, failed step + error, trigger). |
| `qa_run_artifacts` | List a run's screenshot artifacts (name, size). |
| `qa_flow_playwright` | Get a flow transpiled to a Playwright .spec.ts (for CI parity — run the same flow under Playwright). |
| `qa_mint_key` | Mint a scoped QA API key for an app (owner only). |

## Safety

- **Read-only mode** — `MCP_READ_ONLY=1` on the worker blocks every mutating tool (they throw, so a caller cannot misreport success); reads and dry-runs still work.
- **Audit** — every mutating call, dry-run and read-only denial is recorded per authenticated user, secrets redacted, 90-day retention; read your own trail with `mcp_audit_log`.
- **confirm / dry_run** — as marked above.
- **Ownership** — project tools verify you own the app; loop, agent and QA tools forward your token and the platform enforces ownership.
- **Structured errors** — failures return `isError: true` (thrown errors via the SDK, explicit returns via `errText`), so an agent never has to parse text to notice one.
- Rate limit on `POST /register` (20/hour/IP). Full model: [`CLAUDE.md`](./CLAUDE.md#security--safety-model).

## Related

- App-side manifest and calling conventions: https://docs.proappstore.online/mcp-app-tools/
- Platform guide for building apps: https://proappstore.online/skills.md
- Personal app tokens for plain HTTP (not MCP): https://docs.proappstore.online/mcp-app-tools/#personal-app-tokens-http-only
