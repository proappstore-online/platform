# Agent Instructions — ProAppStore

Use ProAppStore **only** through the configured MCP server.

```
Endpoint: https://mcp.proappstore.online/mcp
Per app:  https://mcp.proappstore.online/mcp/apps/<app_id>
```

## Rules

- Do not call the REST API (`api.proappstore.online`) directly; do not drive the console or dashboard UI.
- Start by inspecting the tools you have (`whoami` tells you who you are and what roles you hold).
- Prefer read-only tools (`app_info`, `list_files`, `read_file`, `deploy_status`, `schema_status`, `list_tickets`, `qa_list_runs`) unless the task requires a change.
- Preview before committing: every expensive or irreversible tool accepts `dry_run: true` and returns the plan. Then call it for real.
- Destructive, public-facing or infrastructure tools need `confirm: true` — `provision_pas_app`, `scaffold_app`, `provision_app`, `publish_app`, `delete_file`. Ask the user before passing it.
- Never paste tokens, secrets or API keys into tool arguments other than the `token` argument the loop tools define. Vaulted keys stay on the platform.
- A failure comes back with `isError: true`; treat it as a failure even if the text looks informative.
- You act as the authenticated account. If `whoami` is not the person you expect, stop.

## Setup

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
    "proappstore": { "command": "npx", "args": ["mcp-remote", "https://mcp.proappstore.online/mcp"] }
  }
}
```

## Capabilities

| Group | Tools | Notes |
|---|---|---|
| Identity | `whoami`, `mcp_audit_log` | who you are; what you did |
| Platform | `list_apps`, `app_info`, `deploy_status`, `schema_status`, `list_templates`, `platform_guide`, `sdk_reference`, `recipe` | reads; `platform_guide` + `sdk_reference` + `recipe` are the docs you should consult before writing app code |
| App data | `list_app_tools`, `call_app_tool` | any published app's registered actions, executed by the platform with the app's own auth rules |
| Project | `provision_pas_app`, `scaffold_app`, `write_file`, `batch_write_files`, `read_file`, `list_files`, `search_files`, `delete_file`, `get_deploy_status`, `provision_app`, `publish_app` | build an app yourself: files commit to `main` and deploy keylessly |
| Agent Teams | `create_app`, `list_projects`, `get_project`, `build_knowledge_base`, `chat_agent`, `list_tickets`, `add_ticket`, `update_ticket`, `list_agents`, `get_project_files`, `write_project_files`, `delete_project_files`, `deploy_project`, `set_project_budget`, `set_project_running`, `set_model`, `run_tests` | an AI team (PO / BA / Dev / QA) builds the app; you steer it or write the tree yourself |
| Agent introspection | `agent_project_status`, `agent_board`, `agent_activity`, `agent_ticket_detail`, `agent_cost` | read-only views of a team's work and spend |
| QA | `qa_list_flows`, `qa_save_flow`, `qa_delete_flow`, `qa_run`, `qa_list_runs`, `qa_run_artifacts`, `qa_flow_playwright`, `qa_mint_key` | browser e2e flows stored on the platform and run headlessly after every deploy |

## Workflow recipes

### Build a Pro app yourself

```
1. list_templates              — pick the template (default: template-app)
2. provision_pas_app           — dry_run: true first, then confirm: true
3. list_files / read_file      — read the scaffold (web/src/App.tsx, mcp.json, migrations.json)
4. sdk_reference / recipe      — before writing platform code
5. batch_write_files           — write; each commit deploys (migrations → actions → R2)
6. deploy_status / schema_status — confirm the deploy and the D1 migrations
7. qa_save_flow + qa_run       — add a browser flow; it reruns after every deploy
```

### Let the Agent Team build it

```
1. create_app                  — a project with a slug
2. build_knowledge_base        — the Architect researches and writes KNOWLEDGE.md
3. chat_agent thread:'build'   — tell the PO what to build; it files tickets
4. set_project_budget          — cap monthly spend
5. set_project_running true    — play; watch with list_tickets / agent_board / agent_cost
6. get_project / deploy_status — the deploy stage registers mcp.json automatically
```

### Use an app's data

```
1. list_app_tools app_id       — what the app exposes (reads vs writes)
2. call_app_tool app_id tool   — runs as you; mutations are audited and refused in read-only mode
   (or connect to /mcp/apps/<app_id> and call the tools by name)
```

## Not supported

- **No per-app tools on `/mcp`.** The shared endpoint has a fixed tool set; app tools live on `/mcp/apps/<app_id>` or behind `call_app_tool`.
- **No token revocation or refresh** — OAuth access tokens are opaque and expire after 24 hours; reconnect to get a new one. Session JWTs last 30 days.
- **No delegated or third-party scopes** — every caller is the owner/operator of what they touch (single-admin model); there is no read/write/destructive scope taxonomy. Ownership is enforced per call instead.
- **No raw SQL, no secrets, no billing.** Data goes through registered actions; keys stay in the platform vault; the platform subscription is the only billing.
- **Rate limiting** applies to `POST /register` only, not to tool calls.
- **MCP tokens are not API tokens.** For plain HTTP scripts use a personal app token (`pas_at_…`) on the actions route; it is never accepted by MCP, and MCP tokens are never accepted by the REST API.

## Discovery

- `server.json` — registry manifest (tool list kept in sync with the server by test)
- `README.md` — connect + tool tables
- `llms.txt` — short index for LLM crawlers
- `CLAUDE.md` — maintainer notes and the full security model
- `/.well-known/oauth-authorization-server` and `/.well-known/oauth-protected-resource[/mcp/apps/<app_id>]` — OAuth discovery, live
