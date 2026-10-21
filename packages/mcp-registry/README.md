# @proappstore/mcp

MCP server for [ProAppStore](https://proappstore.online) — AI agent tools for building, provisioning, managing, and querying Pro web apps.

## Quick start

### Claude Code (recommended)

```bash
claude mcp add --transport http --scope user proappstore https://mcp.proappstore.online/mcp
```

### Codex

```bash
codex mcp add proappstore --url https://mcp.proappstore.online/mcp
codex mcp login proappstore
```

Complete browser sign-in and verify `whoami`. All tools use connection auth;
never copy session tokens into prompts or tool arguments. MCP setup does not
create a plugin mention: install/enable the ProAppStore plugin separately.

### Any MCP client

```
npx @proappstore/mcp
```

The npm launcher uses its installed, pinned `mcp-remote` dependency. It does not
start a nested package download or installation prompt on the MCP input stream.

Or connect directly to the remote endpoint:

```
https://mcp.proappstore.online/mcp
```

## Tools

**Platform info** — `sdk_reference`, `recipe`, `platform_guide`, `deploy_status`, `app_info`, `list_apps`, `list_app_tools`, `call_app_tool`

**Build apps** — `provision_pas_app`, `scaffold_app`, `write_file`, `read_file`, `list_files`, `delete_file`, `search_files`, `batch_write_files`, `get_deploy_status`, `provision_app`

**Agent Teams** — `create_app`, `list_projects`, `get_project`, `build_knowledge_base`, `chat_agent`, `list_tickets`, `list_agents`, `get_project_files`, `set_project_running`, `set_project_budget`, `run_tests`, `set_model`, `add_ticket`

**Introspection** — `agent_project_status`, `agent_board`, `agent_activity`, `agent_ticket_detail`, `agent_cost`

**App data** — registered `mcp.json` actions on `/mcp/apps/<app_id>`, or through `list_app_tools` / `call_app_tool` on `/mcp`. The shared endpoint exposes 68 annotated platform tools.

## Agent Skills

Open-format skills that orchestrate these tools (`create-proappstore-app`:
gather inputs, choose an approved template, dry-run `provision_pas_app`,
confirm, provision, verify; `choose-proappstore-architecture`: map requirements
to platform primitives with `sdk_reference` / `recipe`, read-only;
`proappstore-auth-sessions-roles`: platform-cookie sessions, app roles and
permissions, auth anti-pattern remediation, read-only;
`proappstore-data-migrations-actions`: migrations, registered actions and
tenant-safe SQL, read-only; `proappstore-publish-deploy`: gates, push-to-main
deploy, deploy/schema/QA status monitoring, evidence and `git revert`
rollback, read-only plus `qa_run`; `proappstore-upgrade-app`: staged upgrade
to the current SDK, template and standard with `list_templates` as the
baseline, dry-run by default, read-only; `audit-proappstore-app`: audit
against the published standard, findings in the finding contract, read-only)
live in the platform repository under
[`skills/`](https://github.com/proappstore-online/platform/tree/main/skills).
Copy a skill directory into your client's skills location and connect this
server.

## Links

- [Full setup guide](https://proappstore.online/build-with-ai#mcp)
- [SDK docs](https://docs.proappstore.online/)
- [Platform source](https://github.com/proappstore-online/platform)
