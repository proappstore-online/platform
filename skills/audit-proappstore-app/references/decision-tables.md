# Decision tables

## Result state

| Situation | State | Notes | Source |
|---|---|---|---|
| Evidence shows the clause is met | `pass` | cite the evidence, class and path | [audit instructions](https://docs.proappstore.online/standard/audit-instructions/) |
| Evidence shows it is not met, or a MUST's evidence is absent | `fail` | say where you looked; absence is not `manual-review` | [audit instructions](https://docs.proappstore.online/standard/audit-instructions/) |
| The clause's applicability condition is not met | `not-applicable` | with the evidence that the condition is not met (e.g. Tailored app for a Ready-only clause) | [audit model](https://docs.proappstore.online/standard/audit-model/) |
| Evidence insufficient, or verification class is `human` | `manual-review` | never `pass` from an AI for [PAS-AUTH-020](https://docs.proappstore.online/standard/auth/#pas-auth-020), [PAS-UI-006](https://docs.proappstore.online/standard/ui/#pas-ui-006), [PAS-UI-023](https://docs.proappstore.online/standard/ui/#pas-ui-023), [PAS-OPS-019](https://docs.proappstore.online/standard/ops/#pas-ops-019) | [audit model](https://docs.proappstore.online/standard/audit-model/) |
| Clause withdrawn in the governance page | `not-applicable` | reason "withdrawn in <version>" | [governance](https://docs.proappstore.online/standard/governance/) |

## Evidence by class

| Class | Where | Cite as |
|---|---|---|
| configuration | `package.json`, workflows, `mcp.json`, `migrations.json`, `web/vite.config.ts`, `web/index.html` | `path:line` + excerpt |
| source | `web/src/**` | `path:line` + excerpt (never a secret or personal data) |
| process | CI runs, deploy runs, `pas check` output, `gh secret list`, git history | URL or command + observation |
| runtime | the deployed app: `app_info`, `deploy_status`, `schema_status`, `list_app_tools`, `qa_list_runs`, a browser | URL + observation |
| documentation | README, privacy notice, recovery section | `path:line` |

## Severity, confidence, human validation

| Field | Rule | Source |
|---|---|---|
| severity | the clause's default; lowered only with a stated reason; never raised without human validation | [audit model — severity](https://docs.proappstore.online/standard/audit-model/) |
| confidence | `high` only for direct, unambiguous evidence; `medium` when inferred from one indirect signal; `low` otherwise | [audit instructions](https://docs.proappstore.online/standard/audit-instructions/) |
| human_validation | `required` when the clause is `human`, confidence is below `high`, or the remediation changes architecture | [audit instructions](https://docs.proappstore.online/standard/audit-instructions/) |
| automation | a compliance check (`pas check`) is evidence for its facet only; `full` checks decide their clause, `partial` never close one alone | [audit model — automation levels](https://docs.proappstore.online/standard/audit-model/) |

## Applicability shortcuts

| Signal | Effect |
|---|---|
| `deploy.yml` uploads to `apps/<id>/`, or `app_info` shows a hostname | hosted → AUTH cookie clauses apply |
| Tailored (one fork per customer, no membership tables) | Ready-only tenancy clauses ([PAS-STACK-011](https://docs.proappstore.online/standard/stack/#pas-stack-011)) `not-applicable` with the evidence |
| no `app.rooms`, `app.storage`, `app.proxy`, `app.ai`, … use | the capability's clauses `not-applicable` — absent use is never a finding |
| no deployed app given | runtime-class items `manual-review` with the reason |

## Modes, thresholds, exclusions

| Mode | Writes | Output |
|---|---|---|
| read-only (default) | nothing | the full report |
| issue-creation (explicit) | GitHub issues in the app repository, after the duplicate check on the dedupe key | the report + issue links |

Severity threshold and clause exclusions are recorded in the envelope and
applied only to what is raised as issues; every clause is still recorded.

## Deployment evidence bundle (deployed apps)

| Item | Source |
|---|---|
| commit SHA and CI run | git, GitHub Actions |
| deploy run URL with migration, registration and upload lines | `deploy_status`, run log |
| smoke / QA run id and result | `qa_list_runs` |
| `schema_status` | `schema_status` |
| `pas check` output; `gh secret list`; served build SHA; last human checklist | process / runtime |

Clause: [PAS-OPS-020](https://docs.proappstore.online/standard/ops/#pas-ops-020), [PAS-OPS-005](https://docs.proappstore.online/standard/ops/#pas-ops-005).
