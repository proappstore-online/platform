---
name: create-proappstore-app
description: Create, scaffold and provision a new ProAppStore app end to end through the ProAppStore MCP server — gather the app name, id, category, visibility and data needs, pick an approved template from the catalogue and explain the choice, dry-run provision_pas_app, get explicit confirmation, provision live, then verify the GitHub repository, R2 route, D1 database and data worker, deploy configuration, registered actions and live status. Use when the user asks to create a new ProAppStore app, scaffold a Pro app, provision an app on proappstore.online, set up a new PAS app, or start a new app from the ProAppStore template. Not for editing, deploying or auditing an existing app.
license: MIT
compatibility: Requires an MCP client connected to https://mcp.proappstore.online/mcp with a signed-in ProAppStore session (GitHub or Google). No local tools, tokens or shell access are needed.
metadata:
  author: proappstore-online
  version: "1.0"
  mcp-endpoint: https://mcp.proappstore.online/mcp
  standard-version: "1.5"
  issue: proappstore-online/platform#170
  triggers: create, scaffold, provision, new ProAppStore app
allowed-tools: whoami list_templates app_info deploy_status get_deploy_status schema_status discover_tools qa_run qa_list_runs list_apps platform_guide sdk_reference provision_pas_app scaffold_app
---

# Create and provision a new ProAppStore app

You are creating a **new** app on ProAppStore for the user. Every action goes
through the ProAppStore MCP server; you never provision, deploy or configure
infrastructure yourself. The MCP tools are the authenticated action layer —
this skill is the workflow around them.

## When to use / when not to

- **Use** when the goal is a brand-new app: "create a new ProAppStore app",
  "scaffold a Pro app", "provision <name> on proappstore.online".
- **Do not use** to change, deploy, audit or publish an existing app (other
  skills cover those), to create Agent Teams projects (`create_app` is a
  different, AI-built workflow), or when no ProAppStore MCP connection exists.

## Safety rules (non-negotiable)

1. **Dry-run first, confirm second.** Never call `provision_pas_app` with
   `confirm: true` until you have shown the user the `dry_run: true` plan and
   the user has explicitly said to proceed. The tool itself refuses without
   `confirm: true`; you must not paper over that refusal.
2. **Only the tools in `allowed-tools`.** No `write_file`, `delete_*`, `set_*`,
   `batch_write_files`, `publish_app`, `create_app`, shell, `wrangler`, or
   `gh repo create`. Provisioning is *only* `provision_pas_app` (preferred) or
   `scaffold_app` (default template, legacy).
3. **Never handle credentials.** Authentication is the MCP connection. If the
   server answers "authentication required", stop and hand back to the user —
   do not ask for, accept, or write tokens, `.env` files, or secrets.
4. **Read-only mode degrades to planning.** If a mutating call fails with
   "MCP is in read-only mode", present the dry-run plan as the deliverable and
   report that live provisioning is blocked on the operator's side.
5. **Report only what a tool returned.** A verification line is "passed" only
   when the tool result says so; never infer success.
6. **Approved templates only.** Choose from `list_templates`; omit the template
   for the default. Never pass `allow_unapproved_template` unless the user is
   a platform admin and asked for it explicitly.

## Workflow

### 1. Identify the session

Call `whoami`. Record the login and platform roles. If it errors with
"authentication required" → **blocker: credentials** (see below).

### 2. Gather the inputs

Ask for anything missing; do not guess product decisions.

| Input | Rule | Blocker if unresolved |
|---|---|---|
| **App name** | display name, ≤ 80 chars | product decision |
| **App id** | `^[a-z][a-z0-9-]*$`, ≤ 58 chars; becomes the repo name and `<id>.proappstore.online` | product decision |
| **Category** | one of the storefront categories the user wants (e.g. productivity, education, social); used later by `publish_app`, not by provisioning | product decision (may defer) |
| **Visibility** | private repo (default) or public | product decision |
| **Data needs** | what the app stores, whether it is per-user, per-project or multi-tenant — decides the template's fit and the day-one follow-ups | product decision |

Propose sensible values from the user's description, state them, and ask for
a single confirmation of the set.

### 3. Inspect the approved templates and choose

Call `list_templates`. Explain the choice in one paragraph: which template,
why it fits the category and data needs, its `status`, its **reviewed source
commit**, and its **known deviations** (Application Standard clause ids the
scaffold does not yet meet). Today the catalogue holds one approved template,
`template-app` (the default); say so rather than inventing alternatives. The
catalogue and contract are public at
https://docs.proappstore.online/templates/ (data:
https://docs.proappstore.online/templates/catalogue.json).

### 4. Dry-run

Call `provision_pas_app` with `dry_run: true` and the gathered inputs
(`app_id`, `name`, `description`, `private_repo`, `template_repo` only if not
the default). Show the returned plan verbatim. It lists the template with its
status and reviewed commit, the repository to create, the deploy variables,
the placeholder replacement, the `/v1/provision` call and the verification.
If the plan shows `Refused:` (unknown template, bad id), fix the input and
dry-run again — do not proceed.

### 5. Confirm

Ask the user, in plain words, whether to create `<org>/<app_id>` and provision
live infrastructure now. Only an explicit yes continues.

### 6. Provision live

Call `provision_pas_app` again with the same inputs plus `confirm: true` and
`verify: true`. Keep the full step list from the result; it is the evidence.

### 7. Verify

The tool's own verification covers repo, provision result, deploy status and
host response. Complete the checklist in
[references/verification-checklist.md](references/verification-checklist.md)
with the read-only tools: `app_info` (live URL, repo, data worker),
`deploy_status` / `get_deploy_status` (the first *Deploy to R2* run after the
template commit), `schema_status` (migrations applied), `discover_tools`
(registered actions from `mcp.json`), and `qa_run` / `qa_list_runs` for a
post-deploy smoke once a flow exists. Record each item as passed, pending
(e.g. no deploy run yet) or failed, with the tool that said so.

### 8. Report

Render [references/output-template.md](references/output-template.md): what
was created, the template and **copied revision** (the `Template revision:`
step), verification results, the day-one follow-ups from the template's known
deviations, and any blockers. Do not call `publish_app`; storefront listing is
a separate decision the user makes later.

## Idempotent reruns

`provision_pas_app` is safe to re-run for the same `app_id`:

- Repo already exists and the user owns the app → the tool reuses it
  (`~ GitHub repo: <org>/<id> already exists`) and re-runs `/v1/provision`,
  which fills in only missing pieces. Re-verify and report.
- Repo exists with **no** app record and is still the untouched scaffold → the
  tool adopts it (#144). Report that the earlier run was partial.
- Repo exists with commits beyond the scaffold and no record, or the record
  belongs to **another account** → the tool refuses. **Blocker: ownership** —
  the user must sign in as that account, choose another id, or involve a
  platform admin. Never pass `reuse_existing_repo: false` to "force" it.
- A failed `/v1/provision` step (`compliance`, `create_d1`, `deploy_worker`)
  is reported in the result; fix the cause, then re-run the same call.

## Blockers — hand back, do not work around

| Class | Signal | What to say |
|---|---|---|
| **Credentials** | `authentication required`; read-only mode | The user must authenticate the MCP connection (or the operator must lift `MCP_READ_ONLY`). Deliver the plan meanwhile. |
| **Ownership** | `owned by another account`, `commits beyond the template scaffold` | Needs the owning account or a platform admin. |
| **Template** | `Refused: unknown template`, `requires a platform admin session`, `must exist and be marked as a GitHub template` | Use an approved id; unknown ids need an admin override; a source repo not flagged as a GitHub template is a platform-side fix. |
| **Compliance** | `compliance` step failed (412) | The repo failed a compliance rule; the detail names the rule and cites the standard clause. |
| **Product decision** | missing name/id/category/visibility/data needs | Ask; do not invent. |

## Follow-ups the report must include

The template's `security_compliance.known_deviations` (from `list_templates`)
are Application Standard clauses the new app fails on day one. For
`template-app` today: set `authMode: 'platform-cookie'` in `initPro`
(https://docs.proappstore.online/standard/auth/#pas-auth-001), switch the theme
boot key to `stores-theme` (https://docs.proappstore.online/standard/ui/#pas-ui-002),
and remove `user-scalable=no` (https://docs.proappstore.online/standard/ui/#pas-ui-007).
List them as the first three tasks, with the clause URLs.

## Examples and negative cases

- Tool contracts and the exact step names: [references/provisioning-tools.md](references/provisioning-tools.md)
- Worked refusals and blockers: [references/negative-cases.md](references/negative-cases.md)
- Machine-checked end-to-end evaluations: [evals/cases.json](evals/cases.json)
