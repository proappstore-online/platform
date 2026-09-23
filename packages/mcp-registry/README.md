# @proappstore/mcp

MCP server for [ProAppStore](https://proappstore.online) — AI agent tools for building, provisioning, managing, and querying Pro web apps.

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

**Build apps** — `provision_pas_app`, `scaffold_app`, `write_file`, `read_file`, `list_files`, `delete_file`, `search_files`, `batch_write_files`, `get_deploy_status`, `provision_app`

**Agent Teams** — `create_app`, `list_projects`, `get_project`, `build_knowledge_base`, `chat_agent`, `list_tickets`, `list_agents`, `get_project_files`, `set_project_running`, `set_project_budget`, `run_tests`, `set_model`, `add_ticket`

**Introspection** — `agent_project_status`, `agent_board`, `agent_activity`, `agent_ticket_detail`, `agent_cost`

**App data** — dynamic per-app tools from `mcp.json` manifests

## Agent Skills

Open-format skills that orchestrate these tools (`create-proappstore-app`:
gather inputs, choose an approved template, dry-run `provision_pas_app`,
confirm, provision, verify; `choose-proappstore-architecture`: map requirements
to platform primitives with `sdk_reference` / `recipe`, read-only) live in the
platform repository under
[`skills/`](https://github.com/proappstore-online/platform/tree/main/skills).
Copy a skill directory into your client's skills location and connect this
server.

## Links

- [Full setup guide](https://proappstore.online/build-with-ai#mcp)
- [SDK docs](https://docs.proappstore.online/)
- [Platform source](https://github.com/proappstore-online/platform)
