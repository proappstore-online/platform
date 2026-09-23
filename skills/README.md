# ProAppStore Agent Skills

Portable workflows in the open [Agent Skills](https://agentskills.io/specification)
format (`<skill>/SKILL.md` + optional `references/`, `scripts/`, `assets/`,
`evals/`). Skills teach the *workflow*; the
[ProAppStore MCP server](https://mcp.proappstore.online/mcp) remains the
authenticated action layer — skills never re-implement provisioning, deploys,
tests or platform data access, and never carry credentials.

| Skill | Use when | Tools it may call |
|---|---|---|
| [`create-proappstore-app`](./create-proappstore-app/SKILL.md) | creating, scaffolding or provisioning a **new** ProAppStore app | read-only MCP tools + `provision_pas_app` / `scaffold_app` (dry-run → explicit confirm) |
| [`proappstore-auth-sessions-roles`](./proappstore-auth-sessions-roles/SKILL.md) | adding or reviewing **authentication, cookie sessions, roles and permissions** in a ProAppStore app — platform-cookie sessions, SDK sign-in/sign-out, app roles + manifest gates + SQL scoping, a gated permissions UI, negative tests; detects storage-held sessions, `app.auth.token` coupling, home-grown sign-in, membership-only gates, unsafe return URLs, incomplete sign-out | read-only MCP tools only (`sdk_reference`, `recipe`, `platform_guide`, `app_info`, `discover_tools`, `schema_status`, `whoami`) |
| [`proappstore-data-migrations-actions`](./proappstore-data-migrations-actions/SKILL.md) | designing or reviewing **migrations, registered actions and tenant-safe data access** — store choice, additive `migrations.json`, `mcp.json` actions with typed params and server-owned magic params, SQL scoping and invariants, batches, idempotency, negative tests, migration and deployment checks; detects cross-tenant access, guessed ids, replayable grants, unsafe writes, drift, raw browser SQL, client-only authorization | read-only MCP tools only (`sdk_reference`, `recipe`, `platform_guide`, `app_info`, `discover_tools`, `schema_status`, `whoami`) |
| [`choose-proappstore-architecture`](./choose-proappstore-architecture/SKILL.md) | choosing the **architecture and platform services** for a ProAppStore app — which primitive serves each need, what is unsupported, the trade-offs, a bounded decision citing the standard | read-only MCP tools only (`sdk_reference`, `recipe`, `platform_guide`, `list_templates`, `app_info`, `discover_tools`, `schema_status`, `whoami`) |

## Install (until the plugin package lands — issue #169)

Copy a skill directory into your client's skills location, unchanged:

- **Claude Code**: `.claude/skills/<name>/` in the project, or `~/.claude/skills/<name>/`.
- **Other Agent Skills clients** (Codex, Copilot, …): the client's skills directory per its documentation.

Then connect the ProAppStore MCP server (`npx mcp-remote https://mcp.proappstore.online/mcp`,
or `npx @proappstore/mcp`). Skills are content-only: no scripts, no secrets,
no client-specific copies.

## Rules every skill here follows

- Frontmatter per the spec: `name` (= directory), `description` (what + when),
  `license`, `metadata`, and a **minimal `allowed-tools`** list of MCP tool
  names — never `write_file`, `delete_*`, `set_*`, `batch_write_files`, shell
  or `wrangler`.
- Mutating MCP tools are called **dry-run first**, then only with the user's
  explicit confirmation; read-only server mode degrades to planning.
- Links go to the live docs (https://docs.proappstore.online/) and the
  [Application Standard](https://docs.proappstore.online/standard/); platform
  rules are cited, not restated.
- `test/skills.test.ts` validates every skill (format, links, tool allow-list,
  secret shapes, duplicates, dry-run-before-confirm for mutating skills,
  read-only for advisory ones) and each skill ships machine-checked
  evaluations (`evals/cases.json`; e.g. `packages/mcp/src/skill-create-app.evals.test.ts`,
  `test/skills-architecture.evals.test.ts`, `test/skills-auth.evals.test.ts`, `test/skills-data.evals.test.ts`).
