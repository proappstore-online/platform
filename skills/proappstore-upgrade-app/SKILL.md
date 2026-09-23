---
name: proappstore-upgrade-app
description: Upgrade an existing ProAppStore app to the current SDK, template and Application Standard without overwriting its product code — inventory the app, compare its dependencies, configuration and workflows with the supported baseline (SDK and CLI versions, Node and pnpm, the approved template revision, the canonical deploy, CI and compliance workflows), find template drift, and prepare a staged upgrade plan covering the platform-cookie session migration, registered actions and migrations, the UI/PWA baseline, MCP tools, tests and rollback. Runs in dry-run report mode by default and in a bounded implementation mode that changes one stage at a time, preserves customer customisations, and requires explicit review before any destructive or broad rewrite. Use when a user asks to upgrade, update, modernise or re-align an existing app on proappstore.online with the latest SDK, template or standard. Not for creating a new app, a release, or a full audit.
license: MIT
compatibility: Works with any Agent Skills client that can read and edit the app repository. Best with the ProAppStore MCP server (https://mcp.proappstore.online/mcp) for the approved template revision, the app's registered actions, migration status and deploy history; otherwise the public docs only. Read-only MCP allow-list — no provisioning, no credentials; edits happen only in the user's repository, one reviewed stage at a time.
metadata:
  author: proappstore-online
  version: "1.0"
  mcp-endpoint: https://mcp.proappstore.online/mcp
  standard-version: "1.5"
  issue: proappstore-online/platform#177
  triggers: upgrade, update, modernise, re-align, latest SDK, template drift, ProAppStore
allowed-tools: whoami app_info list_templates schema_status list_app_tools deploy_status sdk_reference recipe platform_guide qa_list_runs
---

# Upgrade an existing app to the current SDK, template and standard

You bring an app that was scaffolded from an older template, SDK or
standard version up to the current supported baseline — without touching
what makes it *that* app. You inventory, compare, and plan; in
implementation mode you change one bounded stage at a time, in
template-owned files or by additive edits, and you hand every broad or
destructive change back for review first.

## When to use / when not to

- **Use** for "upgrade this app", "is this app on the current SDK /
  template / standard?", "what changed since we scaffolded?", "migrate to
  platform-cookie", "our deploy workflow is old", and after a standard
  version bump.
- **Do not use** to create an app (`create-proappstore-app`), to ship a
  release (`proappstore-publish-deploy` — every stage here is released with
  it), to design data or auth from scratch
  (`proappstore-data-migrations-actions`, `proappstore-auth-sessions-roles`),
  or for a whole-standard audit.

## Rules

1. **Product code is never overwritten.** Files the customer wrote —
   `web/src/**`, `mcp.json`, `migrations.json`, `README.md`, `CLAUDE.md`,
   `web/public/**`, the title and description in `web/index.html` — are
   read, compared and *advised on*; they are edited only by a minimal,
   reviewed diff, never replaced with the template's copy. The
   [ownership table](references/decision-tables.md) says which files are
   template-owned and may be re-synced
   ([PAS-STACK-001](https://docs.proappstore.online/standard/stack/#pas-stack-001)).
2. **Dry-run first.** The default output is a report: inventory, baseline
   comparison, drift, staged plan, risks. Nothing is edited until the user
   picks a stage and says so.
3. **Bounded implementation.** One stage per run and per commit, from the
   [staged plan](references/decision-tables.md); each stage typechecks,
   tests and passes `pas check` before it is handed to
   `proappstore-publish-deploy`; each is a revert-sized unit
   ([PAS-OPS-009](https://docs.proappstore.online/standard/ops/#pas-ops-009)).
4. **Explicit review before anything destructive or broad.** Removing a
   file, replacing a workflow, changing `initPro`, touching `migrations.json`
   or `mcp.json`, or any diff over a product-owned file stops for review
   with the full diff shown. Schema changes stay additive
   ([PAS-DATA-002](https://docs.proappstore.online/standard/data/#pas-data-002)).
5. **The baseline is what the platform publishes.** SDK, CLI, Node and pnpm
   requirements and the reviewed template revision come from
   `list_templates` and the [template catalogue](https://docs.proappstore.online/templates/);
   workflows from the canonical deploy workflow; rules from the standard's
   current version and [changelog](https://docs.proappstore.online/standard/changelog/).
   Do not invent a "latest" from memory.
6. **Never fabricate APIs.** Name only SDK options and surfaces confirmed
   with `sdk_reference` (feature `auth`, `hooks`, `ui`, `db`) or `recipe`;
   the only auth modes are `platform-cookie` and `legacy-bearer`.
7. **Read-only and credential-free.** The MCP allow-list is read-only; agents
   running this skill never handle credentials: no tokens, no `.env`, no
   repository secrets, no `wrangler`, no `gh repo create`. A drifted
   workflow that holds a token is reported and replaced with the keyless one
   ([PAS-OPS-006](https://docs.proappstore.online/standard/ops/#pas-ops-006)).
8. **Some checks are human.** After the platform-cookie migration a person
   signs in on every hostname; after the UI stage a person checks the
   installed app. Record those as pending, never as passed
   ([PAS-AUTH-020](https://docs.proappstore.online/standard/auth/#pas-auth-020),
   [PAS-UI-023](https://docs.proappstore.online/standard/ui/#pas-ui-023)).

## Workflow

### 1. Inventory the app

Read, and record in the [output template](references/output-template.md):

- `app_info`: hostnames (custom domains matter for the cookie stage),
  template provenance (`template_id` / `template_rev` when recorded).
- `package.json` and `web/package.json`: `engines`, `packageManager`,
  `@proappstore/sdk` and `@proappstore/cli` versions, framework versions,
  `pnpm-lock.yaml` present.
- `web/src` for the `initPro` call and its `authMode`; storage, token or
  `/v1/auth` handling; `app.db.*` in user paths; `app.db.migrate` at runtime.
- `.github/workflows/`: `deploy.yml`, `ci.yml`, `compliance.yml` present and
  their diff from the canonical ones; repository secrets (`gh secret list` —
  there must be none; a stored token is a blocker, never an input).
- `migrations.json` and `mcp.json`: present, additive, actions with explicit
  `requires_auth`; `schema_status` and `list_app_tools` for the live state.
- `web/index.html` and `web/vite.config.ts`: theme key, viewport, PWA
  plugin settings, manifest and icons.
- Tests: `pnpm typecheck`, `pnpm test`, e2e or QA flows (`qa_list_runs`).
- Customisations: every product-owned file that differs from the template
  in shape — list them; they are what the plan must preserve.

### 2. Compare with the baseline

`list_templates` gives the approved template, its reviewed revision, its
`requires` (SDK, CLI, Node, pnpm) and its *known deviations* — the fixes an
app must have made on day one. Walk the
[baseline table](references/decision-tables.md) row by row and record for
each: current value, baseline value, drift (none / behind / diverged /
missing), and the clause. Then run the detections in
[references/anti-patterns.md](references/anti-patterns.md).

### 3. Write the staged plan (dry-run report)

Order the stages as in the [staged plan](references/decision-tables.md):
toolchain → SDK and CLI → workflows → platform-cookie → data layer → UI/PWA
→ MCP tools → tests. For each stage: the files touched (template-owned vs
product-owned), the exact edits, what is preserved, the risk, the check
that proves it, the rollback. Mark stages that need review (rule 4) and
human verification (rule 8). Stop here unless the user picks a stage.

### 4. Implement one stage (bounded mode)

On the user's explicit choice: apply that stage's edits only; show every
diff over a product-owned file before writing it; run
`pnpm install --frozen-lockfile` (or update the lockfile when the stage is
the dependency bump), `pnpm typecheck`, `pnpm test`, `pas check`; commit the
stage alone with a message naming it. Hand the commit to
`proappstore-publish-deploy` for the release and the smoke.

### 5. Verify and record

After each stage's deploy: `deploy_status` green, `schema_status` clean,
`list_app_tools` unchanged unless the stage changed `mcp.json`, the smoke
passed, and the human checks the stage needs listed as pending. Update the
report; the next stage starts from step 4.

### 6. Roll back a stage

A stage whose smoke fails is reverted as one commit
(`git revert <stage sha>`) and redeployed; schema stays additive so a
revert never needs a migration undone. Stages are independent by design —
reverting one does not undo the others
([PAS-OPS-009](https://docs.proappstore.online/standard/ops/#pas-ops-009)).

## Blockers — hand back, do not work around

| Class | Signal | What to say |
|---|---|---|
| **Review required** | a stage would delete a file, replace a workflow, change `initPro`, edit `migrations.json` / `mcp.json`, or diff a product-owned file | show the diff; wait for the user's decision; never batch it with other stages |
| **Unsupported requirement** | the app wants a template that is withdrawn or not in the catalogue, a non-additive schema change, a non-`main` deploy, an SDK major that does not exist | the interim pattern and the clause |
| **Live schema** | `schema_status` shows a failed migration | stop; the [migration repair runbook](https://docs.proappstore.online/migration-repair-runbook/) |
| **Credentials** | a stored token in a workflow or secret, or one offered to "make the upgrade easier" | never use it; replace the workflow with the keyless one and have the user delete the secret |
| **Manual verification** | sign-in per hostname after the cookie stage; the installed app after the UI stage | list as pending for a person |

## Reruns and failures

- **Rerun:** the dry-run report is idempotent — the same repository and
  baseline produce the same plan; a stage already applied is reported as
  done and skipped, never re-applied.
- **Failure:** a stage whose gates or smoke fail is reverted as one commit
  (`git revert`) and re-planned; the other stages stay in place.

## Worked examples

[references/worked-examples.md](references/worked-examples.md) covers a
dry-run report on an old customised app, each stage, preserving a heavily
customised app, and a stage rollback; [evals/cases.json](evals/cases.json)
holds the machine-checked expectations for the same scenarios.
