# ProAppStore MCP Server

Remote MCP server for AI agents to interact with the ProAppStore platform.

- Endpoint: `mcp.proappstore.online/mcp`
- Dev: `npm install && npm run dev`
- Deploy: `git push origin main` (auto-deploys via GitHub Actions)

## Tools (36 static + dynamic per-app)

### Platform tools (no auth required unless noted)

| Tool | Auth | Description |
|------|------|-------------|
| `whoami` | Connection | Show the authenticated PAS account — uid, login, platform roles, per-app roles, token expiry. Confirms which identity owner-scoped tools run as |
| `list_apps` | Session token | List your published Pro apps |
| `deploy_status` | None | Check GitHub Actions deploy status |
| `app_info` | None | Get app URLs, repo, data worker, status |
| `platform_guide` | None | Fetch skills.md (full platform guide) |
| `sdk_reference` | None | Quick SDK reference (auth, db, storage, maps, AI, subscriptions, hooks, UI, recipes, design_system) |
| `discover_tools` | None | List the per-app tools currently registered (the `<app>/<tool>` set) |
| `recipe` | None | Get a pre-built code recipe (19 available). No name = list all, with name = full code |

### Project tools (build apps over MCP)

Each requires a session token via connection-level auth.

| Tool | Description |
|------|-------------|
| `scaffold_app` | Create a new PAS app from template (GitHub repo + CF Pages + D1 + DNS) |
| `write_file` | Create/overwrite a file in an app's repo (commits to main) |
| `read_file` | Read a file from an app's repo |
| `list_files` | List files in an app's repo |
| `delete_file` | Delete a file from an app's repo |
| `search_files` | Search file contents in an app's repo |
| `batch_write_files` | Write multiple files in one commit |
| `get_deploy_status` | Check deploy status for a specific app |
| `provision_app` | Provision platform resources (CF Pages, D1, DNS, data worker) |

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
| `delete_project_files` | Remove files from the working tree (project paused) |
| `deploy_project` | Deploy the current working tree, no LLM (needs a provisioned repo) |

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
