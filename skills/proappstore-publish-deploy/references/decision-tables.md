# Decision tables

Each row: the situation, what to do, the clause, the docs page, and what not
to do. Every tool, workflow step and log line named here exists today.

## Release path

| Situation | Do | Clause | Docs | Do not |
|---|---|---|---|---|
| First publish of a new app | `pas publish` (or the creator console) provisions; every later release is a push | [PAS-STACK-004](https://docs.proappstore.online/standard/stack/#pas-stack-004) | [publishing flow](https://docs.proappstore.online/publishing-flow/) | `gh repo create`, Cloudflare Pages, DNS by hand |
| Any release | commit to `main`, push; the template `deploy.yml` runs: *Build* → *Apply D1 migrations* → *Mint deploy credentials* → *Upload to R2* → *Register app tools* → *Run E2E against the live app* | [PAS-STACK-005](https://docs.proappstore.online/standard/stack/#pas-stack-005), [PAS-OPS-005](https://docs.proappstore.online/standard/ops/#pas-ops-005) | [build and deploy](https://docs.proappstore.online/build-and-deploy/) | `wrangler deploy`, copying `dist/` into R2, a manual workflow with stored keys |
| Repository requires pull requests | branch → PR → review → merge; the merge commit is the release | [PAS-OPS-004](https://docs.proappstore.online/standard/ops/#pas-ops-004) | — | bypassing protection, force-push |
| Repository is direct-to-main | commit and push after the gates pass | [PAS-OPS-004](https://docs.proappstore.online/standard/ops/#pas-ops-004) | — | pushing with red CI |
| Gates | `pnpm install --frozen-lockfile`, `pnpm typecheck`, `pnpm test`, `pas check`; CI green on the SHA | [PAS-OPS-004](https://docs.proappstore.online/standard/ops/#pas-ops-004), [PAS-OPS-001](https://docs.proappstore.online/standard/ops/#pas-ops-001) | [CLI overview](https://docs.proappstore.online/cli-overview/) | skipping a failing test; disabling the compliance workflow |
| Deploy auth | GitHub OIDC minted inside the run; no repository secrets except an e2e fixture session | [PAS-OPS-006](https://docs.proappstore.online/standard/ops/#pas-ops-006), [PAS-STACK-005](https://docs.proappstore.online/standard/stack/#pas-stack-005) | — | Cloudflare tokens, R2 keys or platform tokens as secrets |
| Third-party credentials the release needs | `pas secret set` before the push; used through the proxy | [PAS-OPS-006](https://docs.proappstore.online/standard/ops/#pas-ops-006), [PAS-STACK-015](https://docs.proappstore.online/standard/stack/#pas-stack-015) | — | `.env` committed; keys in `VITE_*` |

## What to inspect before pushing

| Change | Check | Clause |
|---|---|---|
| `migrations.json` | new entries appended with new names; additive only; `NOT NULL` with a default; nothing edited or removed since the deployed commit | [PAS-OPS-008](https://docs.proappstore.online/standard/ops/#pas-ops-008), [PAS-DATA-002](https://docs.proappstore.online/standard/data/#pas-data-002) |
| `mcp.json` | every column exists in `migrations.json`; `requires_auth` explicit; removed or renamed actions listed as consequential; `discover_tools` for the current baseline | [PAS-STACK-008](https://docs.proappstore.online/standard/stack/#pas-stack-008), [PAS-DATA-004](https://docs.proappstore.online/standard/data/#pas-data-004) |
| Tests | negative authorization tests updated with `mcp.json`; the smoke flow still covers load, sign in, read, write, sign out | [PAS-OPS-002](https://docs.proappstore.online/standard/ops/#pas-ops-002), [PAS-OPS-010](https://docs.proappstore.online/standard/ops/#pas-ops-010) |
| `deploy.yml` / `ci.yml` | unchanged from the template, or the change reviewed line by line; no new secrets | [PAS-STACK-005](https://docs.proappstore.online/standard/stack/#pas-stack-005), [PAS-OPS-004](https://docs.proappstore.online/standard/ops/#pas-ops-004) |
| Dependencies | `pnpm-lock.yaml` committed; `pnpm audit --prod` clean of high/critical | [PAS-OPS-007](https://docs.proappstore.online/standard/ops/#pas-ops-007) |
| Logging | no tokens, e-mails, names or wholesale params in `app.logs` calls added by the release | [PAS-OPS-011](https://docs.proappstore.online/standard/ops/#pas-ops-011) |

## Monitoring and verification

| Signal | Tool / source | Pass means | Clause |
|---|---|---|---|
| Deploy run | `deploy_status` / `get_deploy_status` (last runs, SHA, URL) | the run for the pushed SHA succeeded | [PAS-OPS-005](https://docs.proappstore.online/standard/ops/#pas-ops-005) |
| Migration step | run log: `Applied migration(s): […]` or `already: […]`; `schema_status` | latest entry applied, no failed rows | [PAS-OPS-008](https://docs.proappstore.online/standard/ops/#pas-ops-008) |
| Registration step | run log: `Registered N app tool(s)`; `discover_tools` | N equals the committed manifest; no warnings about missing columns | [PAS-STACK-008](https://docs.proappstore.online/standard/stack/#pas-stack-008) |
| Upload step | run log: `Deployed apps/<app> from <sha>` | the SHA is the pushed commit | [PAS-OPS-005](https://docs.proappstore.online/standard/ops/#pas-ops-005) |
| Smoke / QA | `qa_list_runs` (deploy-triggered run for this SHA), `qa_run` to queue one, `qa_run_artifacts` for screenshots, `qa_flow_playwright` for CI parity | status `passed`, all steps | [PAS-OPS-010](https://docs.proappstore.online/standard/ops/#pas-ops-010), [PAS-OPS-003](https://docs.proappstore.online/standard/ops/#pas-ops-003) |
| Served build | the bundle's `VITE_COMMIT_SHA`; `app.logs` entries carry it as `build`; a hard reload of the installed PWA | equals the pushed SHA | [PAS-OPS-020](https://docs.proappstore.online/standard/ops/#pas-ops-020), [PAS-OPS-012](https://docs.proappstore.online/standard/ops/#pas-ops-012) |
| Errors after deploy | `app.logs` error level for the new build; the [monitoring runbook](https://docs.proappstore.online/monitoring-runbook/) thresholds | no new error category | [PAS-OPS-012](https://docs.proappstore.online/standard/ops/#pas-ops-012) |
| Human checks | sign-in per provider and hostname, custom domains, the operational checklist | recorded by a person with date and operator | [PAS-OPS-019](https://docs.proappstore.online/standard/ops/#pas-ops-019), [PAS-AUTH-020](https://docs.proappstore.online/standard/auth/#pas-auth-020) |

## Failure: stop, retry, or roll back

| Failure | Where it shows | Do | Clause |
|---|---|---|---|
| Typecheck, test or `pas check` red | locally or CI | fix; never ship; never weaken the gate | [PAS-OPS-004](https://docs.proappstore.online/standard/ops/#pas-ops-004) |
| Migration step failed | run log; `schema_status` failed | stop; read the error; append a corrective migration; never edit or delete the applied one; never `app.db.migrate` against production; the [migration repair runbook](https://docs.proappstore.online/migration-repair-runbook/) if the row is stuck | [PAS-OPS-008](https://docs.proappstore.online/standard/ops/#pas-ops-008) |
| Upload or registration step failed, earlier steps fine | run log | re-run the same workflow run (or push an empty commit); every step is idempotent — migrations by name (`already`), R2 by prefix replacement, registration by manifest replacement | [PAS-OPS-005](https://docs.proappstore.online/standard/ops/#pas-ops-005), [PAS-STACK-005](https://docs.proappstore.online/standard/stack/#pas-stack-005) |
| Registration rejected the manifest (422: missing column, undeclared param) | run log | fix `mcp.json` or append the migration; push again | [PAS-STACK-008](https://docs.proappstore.online/standard/stack/#pas-stack-008), [PAS-DATA-005](https://docs.proappstore.online/standard/data/#pas-data-005) |
| Upload done, smoke failed | `qa_list_runs` | `git revert <sha>` → push → deploy → smoke passes; schema stays; two failures in a row → incident | [PAS-OPS-009](https://docs.proappstore.online/standard/ops/#pas-ops-009), [PAS-OPS-015](https://docs.proappstore.online/standard/ops/#pas-ops-015) |
| Live page serves the old SHA | served build ≠ pushed SHA | check the upload line and the run's SHA; hard reload / service worker update; if the upload never ran, re-run the workflow; never copy files into R2 | [PAS-OPS-020](https://docs.proappstore.online/standard/ops/#pas-ops-020), [PAS-UI-018](https://docs.proappstore.online/standard/ui/#pas-ui-018) |
| Partial deployment (migrations applied, nothing else) | run log ends after migrations | re-run; the schema is additive so the old frontend keeps working meanwhile | [PAS-OPS-009](https://docs.proappstore.online/standard/ops/#pas-ops-009), [PAS-OPS-008](https://docs.proappstore.online/standard/ops/#pas-ops-008) |
| Rollback needs a column gone | — | not possible; make the reverted code tolerate the column, or ship a forward fix | [PAS-OPS-009](https://docs.proappstore.online/standard/ops/#pas-ops-009) |
| Data loss or unauthorised access reported | user report | incident record within the day: window, logs by category with build, deploy run URLs, `schema_status` | [PAS-OPS-015](https://docs.proappstore.online/standard/ops/#pas-ops-015), [PAS-OPS-014](https://docs.proappstore.online/standard/ops/#pas-ops-014) |

## Evidence bundle (per production deploy)

| Item | Source |
|---|---|
| Commit SHA and its CI run URL | git, GitHub Actions |
| Deploy run URL with the migration, registration and upload lines | `deploy_status`, run log |
| Smoke / QA run id and result | `qa_list_runs` |
| `schema_status` after the deploy | `schema_status` |
| `pas check` output | local run |
| Repository secrets list (should be empty or the e2e fixture only) | `gh secret list` |
| Served build SHA | a fresh `app.logs` entry's `build` |
| Date and operator of the last human checklist | the person |

Clause: [PAS-OPS-005](https://docs.proappstore.online/standard/ops/#pas-ops-005), [PAS-OPS-020](https://docs.proappstore.online/standard/ops/#pas-ops-020).
