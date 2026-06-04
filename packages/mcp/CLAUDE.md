# ProAppStore MCP Server

Remote MCP server for AI agents to interact with the ProAppStore platform.

- Endpoint: `mcp.proappstore.online/mcp`
- Dev: `npm install && npm run dev`
- Deploy: `git push origin main` (auto-deploys via GitHub Actions)

## Tools

| Tool | Auth | Description |
|------|------|-------------|
| `list_apps` | Session token | List your published Pro apps |
| `deploy_status` | None | Check GitHub Actions deploy status |
| `app_info` | None | Get app URLs, repo, data worker, status |
| `platform_guide` | None | Fetch skills.md (full platform guide) |
| `sdk_reference` | None | Quick SDK reference (auth, db, storage, maps, AI, subscriptions, hooks, UI) |
| `discover_tools` | None | List the per-app tools currently registered (the `<app>/<tool>` set) |

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
| `set_project_running` | Play / pause the autonomous build loop |

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
