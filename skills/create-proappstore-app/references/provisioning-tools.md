# Provisioning tools — contracts this skill relies on

All tools live on the ProAppStore MCP server (`https://mcp.proappstore.online/mcp`;
reference: [MCP app tools](https://docs.proappstore.online/mcp-app-tools/)).
Nothing here is re-implemented by the skill.

## `provision_pas_app` (preferred)

| Input | Meaning |
|---|---|
| `app_id` | `^[a-z][a-z0-9-]*$`, ≤ 58; repo name and subdomain |
| `name`, `description` | display name; repo description |
| `template_repo` | approved template id from `list_templates`; omit for the default (`template-app`). Unknown/withdrawn → `Refused:` even in dry-run; deprecated → warning line |
| `allow_unapproved_template` | platform admins only; recorded on the app. Do not use unless asked |
| `private_repo` | default `true` |
| `reuse_existing_repo` | default `true` — reuse only when the caller owns the app or is an admin |
| `skip_compliance` | admins only; leave unset |
| `verify` | default `true`: repo, provision result, deploy status, host HEAD |
| `dry_run` | returns the plan; no changes; allowed in read-only mode |
| `confirm` | required `true` for the live run; the tool refuses otherwise |

What it does, in order: create the GitHub repo from the template
(`POST /repos/<org>/<template>/generate`) or reuse/adopt an existing one; set
the R2 deploy variables; replace `APPNAME` placeholders (one commit); resolve
and report the **template revision** actually copied; call
`POST /v1/provision` with `template` + `templateRev`; verify.

Result lines to look for:

```
+ GitHub repo: created <org>/<id> from <org>/template-app
~ GitHub repo: <org>/<id> already exists                      (rerun, owned)
+ Template revision: template-app@<12 hex>
~ Template revision: could not resolve …                       (recorded as unknown — never invented)
PAS app provisioned: **<name>** (<id>)                          (or "…finished with issues")
  route / create_d1 / deploy_worker / record_app / compliance / template steps
```

## `scaffold_app` (legacy)

Same pipeline, default template only, no `template_repo`, no `verify`. Use
only when `provision_pas_app` is unavailable.

## Read-only tools used for verification

| Tool | Answers |
|---|---|
| `whoami` | who the session is; platform roles (`admin` enables overrides) |
| `list_templates` | catalogue, selection contract, reviewed commit, known deviations |
| `app_info` | live URL, repo URL, data worker URL, host status |
| `deploy_status` / `get_deploy_status` | GitHub Actions runs (the *Deploy to R2* workflow) |
| `schema_status` | D1 migration attempts and whether the latest applied |
| `list_app_tools` | the app's registered actions (from `mcp.json`) |
| `qa_run`, `qa_list_runs` | queue/read a post-deploy browser smoke (needs a saved flow) |
| `list_apps` | the caller's apps — confirms the app record exists |

## Backend facts behind the tools

- `POST /v1/provision` steps: `template` (warning only), `compliance` (412 on
  a hard failure; detail cites the standard clause), `route`, `create_d1`,
  `deploy_worker`, `record_app` (records `creator`, `template_id`, `template_rev`).
- The app row's `template_id` / `template_rev` are returned by `GET /v1/apps`
  and surface via `app_info`.
- The first deploy runs when the placeholder commit lands: *Apply D1
  migrations* → *Mint deploy credentials (keyless)* → *Upload to R2* →
  *Register app tools*.
