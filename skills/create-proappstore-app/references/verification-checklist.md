# Verification checklist

Mark each item **passed**, **pending** (expected to resolve on its own, e.g.
the first deploy has not run yet) or **failed**, and name the tool result that
decided it. Never mark an item passed without a tool result.

| # | Item | Tool | Passed when |
|---|---|---|---|
| 1 | GitHub repository | `provision_pas_app` result; `app_info` | `+ GitHub repo: created …` or `~ … already exists`; `app_info` shows the repo URL |
| 2 | Template provenance | `provision_pas_app` result | `+ Template revision: <template>@<sha>` (an `~ … could not resolve` line is a **pending** with a note, not a failure) |
| 3 | R2 route | `/v1/provision` step `route` | status `ok` (or `skip` when re-provisioning an existing route) |
| 4 | D1 database | step `create_d1` | `ok` or `skip … already exists` |
| 5 | Data worker | step `deploy_worker` | `ok`; `app_info` shows `data-<id>.proappstore.online` |
| 6 | App record | step `record_app` | `ok`, detail names the creator and `template: <id>@<rev>` |
| 7 | Deploy configuration | `provision_pas_app` result | `setRepoVariable` lines / "R2 deploy variables" reported; the workflow is the template's `deploy.yml` |
| 8 | First deploy | `deploy_status` / `get_deploy_status` | the *Deploy to R2* run for the placeholder commit succeeded (pending until it runs) |
| 9 | Migrations applied | `schema_status` | latest migration `applied`, no `failed` rows (pending before the first deploy) |
| 10 | Registered actions | `discover_tools` | the template's tools (`list_items`, `get_item`, …) are listed (pending before the first deploy) |
| 11 | Live status | `app_info` | `Live (200)` |
| 12 | Post-deploy smoke | `qa_run` → `qa_list_runs` | a saved flow passed (pending until a flow exists) |

Compliance: if `/v1/provision` returned 412, item 3–6 are blocked; report the
rule named in the `compliance` step and its clause URL as a **blocker:
compliance**.
