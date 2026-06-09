# @proappstore/mcp

MCP server for [ProAppStore](https://proappstore.online) — 35 AI agent tools for building, managing, and querying Pro web apps.

## Quick start

### Claude Code (recommended)

Add to `~/.claude/settings.json`:

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

### Any MCP client

```
npx @proappstore/mcp
```

Or connect directly to the remote endpoint:

```
https://mcp.proappstore.online/mcp
```

## Tools

**Platform info** — `sdk_reference`, `recipe`, `platform_guide`, `deploy_status`, `app_info`, `list_apps`, `discover_tools`

**Build apps** — `scaffold_app`, `write_file`, `read_file`, `list_files`, `delete_file`, `search_files`, `batch_write_files`, `get_deploy_status`, `provision_app`

**Agent Teams** — `create_app`, `list_projects`, `get_project`, `build_knowledge_base`, `chat_agent`, `list_tickets`, `list_agents`, `get_project_files`, `set_project_running`, `set_project_budget`, `run_tests`, `set_model`, `add_ticket`

**Introspection** — `agent_project_status`, `agent_board`, `agent_activity`, `agent_ticket_detail`, `agent_cost`

**App data** — dynamic per-app tools from `mcp.json` manifests

## Links

- [Full setup guide](https://proappstore.online/build-with-ai#mcp)
- [SDK docs](https://kb.proappstore.online/platform/)
- [Platform source](https://github.com/proappstore-online/platform)
