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
