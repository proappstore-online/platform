---
name: proappstore-publish-deploy
description: Publish, deploy, verify and roll back a ProAppStore app through the supported path — check the preconditions and repository policy, run the canonical gates (frozen lockfile, typecheck, tests, pas check), inspect the migrations and registered actions the release will apply, preview consequential changes, deploy by pushing to main so the keyless OIDC workflow runs, monitor the deploy run and the live status, confirm the smoke or QA run, check the served build is not stale, capture the evidence bundle, and stop or roll back with a git revert on failure. Covers idempotent retry, partial-deployment recovery, migration failures and the final release report. Use when a user asks to publish, deploy, release, ship, verify a deploy of, or roll back a ProAppStore app on proappstore.online. Not for creating or provisioning a new app, designing its data or auth, or a full audit.
license: MIT
compatibility: Works with any Agent Skills client that can run git and pnpm in the app repository. Best with the ProAppStore MCP server (https://mcp.proappstore.online/mcp) for deploy status, schema status, registered actions and QA runs; otherwise the GitHub Actions UI and the public docs. The MCP allow-list is read-only apart from queueing a QA run — no provisioning, no credentials, no manual infrastructure.
metadata:
  author: proappstore-online
  version: "1.0"
  mcp-endpoint: https://mcp.proappstore.online/mcp
  standard-version: "1.5"
  issue: proappstore-online/platform#174
  triggers: publish, deploy, verify, roll back, ship, release, ProAppStore
allowed-tools: whoami app_info list_apps deploy_status get_deploy_status schema_status list_app_tools qa_list_flows qa_run qa_list_runs qa_run_artifacts qa_flow_playwright platform_guide
---

# Publish, deploy, verify and roll back a ProAppStore app

You take a ProAppStore app from "ready to ship" to "verified in production
with evidence", or back to the last known-good state, using only the
supported path: the canonical gates in the repository, a push to `main`, the
template's keyless deploy workflow, the platform's status tools, and the
post-deploy smoke. You never touch infrastructure by hand and never call a
deploy successful on the strength of unit tests.

## When to use / when not to

- **Use** for "ship this", "deploy the app", "is the deploy healthy?", "roll
  back the last release", "why did the deploy fail?", and for a release
  after a schema or action change.
- **Do not use** to create or provision a new app (`create-proappstore-app`),
  to design migrations or actions (`proappstore-data-migrations-actions`),
  for auth (`proappstore-auth-sessions-roles`), or for a whole-standard
  audit.

## Rules

1. **One deploy path.** A push to `main` runs the template's `deploy.yml`
   (build → apply `migrations.json` → mint OIDC credentials → upload to R2 →
   register `mcp.json` → e2e). Nothing else deploys an app: no `wrangler`,
   no copying assets into R2, no editing the host, no `gh repo create`
   ([PAS-STACK-005](https://docs.proappstore.online/standard/stack/#pas-stack-005),
   [PAS-STACK-004](https://docs.proappstore.online/standard/stack/#pas-stack-004)).
2. **Green gates before the push.** `pnpm install --frozen-lockfile`,
   `pnpm typecheck`, `pnpm test` and `pas check` pass locally and CI is green
   on the commit; a red gate is fixed, never bypassed
   ([PAS-OPS-004](https://docs.proappstore.online/standard/ops/#pas-ops-004)).
3. **Schema goes forward only.** A release may append to `migrations.json`;
   it never edits or deletes an applied entry, and a bad migration is fixed
   by a new one. A failed migration step is investigated with
   `schema_status` before any re-push
   ([PAS-OPS-008](https://docs.proappstore.online/standard/ops/#pas-ops-008)).
4. **A deploy is failed until the smoke passes.** The post-deploy e2e or QA
   run against the live URL is the acceptance; unit tests, a green build or
   an uploaded bundle are not
   ([PAS-OPS-010](https://docs.proappstore.online/standard/ops/#pas-ops-010)).
5. **Rollback is a revert on `main`.** `git revert` (or push a known-good
   commit), let the deploy replace the R2 prefix, verify with the smoke.
   Additive migrations stay; the reverted code must still fit the current
   schema ([PAS-OPS-009](https://docs.proappstore.online/standard/ops/#pas-ops-009)).
6. **Evidence or it did not happen.** Every production deploy keeps the run
   URL, commit SHA, the migration, registration and upload lines, the smoke
   result, `schema_status` and the served build SHA
   ([PAS-OPS-005](https://docs.proappstore.online/standard/ops/#pas-ops-005),
   [PAS-OPS-020](https://docs.proappstore.online/standard/ops/#pas-ops-020)).
7. **Credential-free.** Agents running this skill never handle credentials:
   no tokens in prompts, no `.env`, no repository secrets, no session copied
   from a browser. Deploy auth is GitHub OIDC; the MCP allow-list is
   read-only apart from `qa_run`, which queues a smoke run with the
   client's own session
   ([PAS-OPS-006](https://docs.proappstore.online/standard/ops/#pas-ops-006)).
8. **Some checks are human.** Sign-in on every hostname, the operational
   checklist and custom-domain flows are verified by a person; record them
   as pending, never as passed
   ([PAS-OPS-019](https://docs.proappstore.online/standard/ops/#pas-ops-019),
   [PAS-AUTH-020](https://docs.proappstore.online/standard/auth/#pas-auth-020)).

## Workflow

### 1. Preconditions

Confirm with the client's git and the MCP tools before anything else:

- `whoami` succeeds; `app_info` shows the app, its hostnames and template.
- The working tree is clean, the branch is `main` (or the repository's
  release branch), and `git fetch` shows nothing to rebase.
- **Repository policy.** Read the repository's declared policy
  (`CLAUDE.md`, `CONTRIBUTING.md`, branch protection). *Direct-to-main*:
  commit and push. *Pull-request policy*: the release is the merge of a
  reviewed PR — prepare the branch and PR text, hand over, and resume at
  step 5 after the merge. Never bypass protection or force-push.
- `deploy_status` shows the previous deploy succeeded; `schema_status`
  shows no failed migration. A failed state is a blocker, not a baseline.

### 2. Run the canonical gates

In the repository, in this order, and stop on the first failure:
`pnpm install --frozen-lockfile`, `pnpm typecheck`, `pnpm test`, `pas check`.
Report failures verbatim with the file and rule; do not weaken a gate,
skip a test or disable the compliance workflow.

### 3. Inspect what the release applies

Diff `migrations.json` and `mcp.json` against the deployed commit:

- New migration entries are appended, named, additive (`CREATE`, `ALTER … ADD`
  with a default); no entry edited or removed.
- Actions added, changed or removed; every column they touch exists in
  `migrations.json`; `list_app_tools` gives the currently registered baseline.
- Changes to `deploy.yml`, `ci.yml`, dependencies or secrets handling.

### 4. Preview consequential changes and get the go-ahead

List, in the [output template](references/output-template.md), what the
push will do: migrations to apply, actions added / removed, auth or role
changes, workflow or dependency changes, and the rollback plan for each.
Removed actions and any migration are consequential; state them plainly and
wait for the user's explicit go-ahead before pushing.

### 5. Deploy

`git push origin main` (or merge the PR). Nothing else. Then watch:
`deploy_status` / `get_deploy_status` until the run for that SHA completes,
and read the run log for the three lines that must be present —
`Applied migration(s): […]` (or `already: […]`), `Registered N app tool(s)`,
`Deployed apps/<app> from <sha>`. A missing line means that step did not run.

### 6. Verify live

- `schema_status`: latest migration applied, no failed rows.
- `list_app_tools`: the registered actions equal the committed `mcp.json`.
- Smoke: `qa_list_runs` shows the deploy-triggered run for this SHA passing;
  if the app has no automatic run, `qa_run`, then `qa_list_runs` and
  `qa_run_artifacts` for the screenshots. A failed step is a failed deploy.
- Stale assets: the served build reports the pushed SHA (the template stamps
  `VITE_COMMIT_SHA` into the bundle and `app.logs` carries it as the build);
  a hard reload on an installed PWA picks up the new shell. A live page
  still reporting the previous SHA means the upload or the service worker
  update did not take — see [anti-patterns](references/anti-patterns.md).
- Human checks: list what a person still has to verify (sign-in per
  hostname, custom domains, the operational checklist) as **pending**.

### 7. On failure: stop, retry idempotently, or roll back

Use the [decision tables](references/decision-tables.md) *failure* section.
In short: a compliance or test failure never ships; a migration failure is
read from `schema_status` and fixed with a new migration; an upload or
registration failure on an otherwise good commit is retried by re-running
the same workflow (every step is idempotent: migrations by name, R2 by
prefix replacement, registration by manifest replacement); a smoke failure
after a successful upload is rolled back with `git revert` and verified
again. Two consecutive smoke failures are an incident
([PAS-OPS-015](https://docs.proappstore.online/standard/ops/#pas-ops-015)).

### 8. Release report

Render [references/output-template.md](references/output-template.md) with
the evidence bundle, the verification results, the pending human checks and
the rollback path. A report without the evidence is marked incomplete.

## Blockers — hand back, do not work around

| Class | Signal | What to say |
|---|---|---|
| **Credentials** | the user offers a token, asks to store a Cloudflare key, or the workflow wants a secret | never; deploy auth is OIDC — point at PAS-OPS-006 |
| **Repository policy** | protected `main`, required reviews, a declared PR policy | follow it; prepare the PR, hand over, resume after merge |
| **Live schema** | `schema_status` failed before or after the push | stop; the [migration repair runbook](https://docs.proappstore.online/migration-repair-runbook/) |
| **Unsupported requirement** | manual R2 upload, `wrangler`, a hotfix on the host, blue/green, a second environment | the supported path and the clause; no workaround |
| **Manual verification** | sign-in per hostname, custom domains, the operational checklist | list as pending for a person; never mark passed |

## Reruns and failures

- **Rerun:** a release is idempotent per commit — re-running the workflow
  for the same SHA re-applies nothing that already applied (migrations by
  name, R2 by prefix, the manifest whole) and is the standard recovery for a
  partial deployment.
- **Failure:** stop at the failed gate or step, read the run log and
  `schema_status`, then retry once or roll back with `git revert`; never
  loop.

## Worked examples

[references/worked-examples.md](references/worked-examples.md) covers a
successful release, a compliance failure, a deploy failure, a migration
failure, stale assets and a rollback; [evals/cases.json](evals/cases.json)
holds the machine-checked expectations for the same scenarios.
