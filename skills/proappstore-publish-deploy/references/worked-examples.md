# Worked examples

One per evaluation scenario, in the output template's shape.

## successful-release — a feature with one migration and one new action

Preconditions: clean tree on `main`, direct-to-main policy, previous deploy
green (`deploy_status`), `schema_status` clean. Gates: all four pass. Inspect:
`0004_tasks_priority` appended (`ALTER TABLE tasks ADD COLUMN priority TEXT DEFAULT 'normal'`);
`list_tasks_by_priority` added, column present in `migrations.json`; no
workflow change. Preview shown; go-ahead given. Push. `deploy_status` shows
the run for the SHA succeeded; log: `Applied migration(s): ["0004_tasks_priority"]`,
`Registered 7 app tool(s)`, `Deployed apps/tasks from <sha>`. `schema_status`
applied; `discover_tools` lists 7 tools; `qa_list_runs` shows the
deploy-triggered run passed 5/5; served build equals the SHA. Report with
the evidence bundle; human checks pending. Clauses:
[PAS-OPS-004](https://docs.proappstore.online/standard/ops/#pas-ops-004), [PAS-OPS-005](https://docs.proappstore.online/standard/ops/#pas-ops-005),
[PAS-OPS-008](https://docs.proappstore.online/standard/ops/#pas-ops-008), [PAS-OPS-010](https://docs.proappstore.online/standard/ops/#pas-ops-010),
[PAS-OPS-020](https://docs.proappstore.online/standard/ops/#pas-ops-020), [PAS-OPS-019](https://docs.proappstore.online/standard/ops/#pas-ops-019). Unsupported: none.

## compliance-failure — `pas check` fails on a hard rule

Finding: `pas check` reports a hard failure (a `VITE_*` secret in the bundle).
Do not push; do not remove the rule. Remediation: move the key to
`pas secret set` and call it through `app.proxy.fetch`; re-run the gates.
Clause: [PAS-OPS-004](https://docs.proappstore.online/standard/ops/#pas-ops-004),
[PAS-OPS-006](https://docs.proappstore.online/standard/ops/#pas-ops-006), [PAS-STACK-015](https://docs.proappstore.online/standard/stack/#pas-stack-015).
Prove: `pas check` passes; CI green on the new SHA; then the normal release.
Unsupported: none.

## deploy-failure — upload step failed after migrations applied

Finding: the run log shows `Applied migration(s): ["0005_notes"]` and then
*Upload to R2* failed (transient); no `Deployed apps/<app>` line, no
registration. Partial deployment: schema ahead, frontend and manifest old —
safe, because the migration is additive. Remediation: re-run the same
workflow run; the migration reports `already: ["0005_notes"]`, the upload
replaces the prefix, registration replaces the manifest. Prove: the three
lines present; `schema_status` applied; smoke passed. Clause:
[PAS-OPS-005](https://docs.proappstore.online/standard/ops/#pas-ops-005), [PAS-OPS-008](https://docs.proappstore.online/standard/ops/#pas-ops-008),
[PAS-STACK-005](https://docs.proappstore.online/standard/stack/#pas-stack-005). Unsupported: none.

## migration-failure — `NOT NULL` without a default

Finding: the *Apply D1 migrations* step failed — `0006_items_owner`
adds `owner_id TEXT NOT NULL` with no default; `schema_status` shows the
attempt FAILED; nothing shipped. Remediation: never edit `0006_items_owner`
if any environment applied it — here it never applied, and the platform
rejected it before running, so replace it in the same commit series with
`0006_items_owner` carrying `DEFAULT ''` **only if** `schema_status` shows
no applied row for that name; otherwise append `0007_items_owner_default`.
Never `app.db.migrate` against production. Push; verify. Prove:
`Applied migration(s): […]`; `schema_status` applied, no failed rows. Clause:
[PAS-OPS-008](https://docs.proappstore.online/standard/ops/#pas-ops-008), [PAS-DATA-002](https://docs.proappstore.online/standard/data/#pas-data-002).
Unsupported: rolling back a migration (interim: forward fix).

## stale-assets — the live page reports the previous SHA

Finding: the run succeeded but a fresh `app.logs` entry carries the old
`build`, and the installed PWA still shows the old shell. The log has
`Deployed apps/<app> from <sha>`, so the upload ran; the service worker in
the repo was changed to cache `/.pas/*` and lost `autoUpdate`. Remediation:
restore the template's service worker config; push; hard reload the
installed app. If the upload line had been missing, re-run the workflow
instead. Prove: a fresh log entry's `build` equals the pushed SHA. Clause:
[PAS-OPS-020](https://docs.proappstore.online/standard/ops/#pas-ops-020), [PAS-UI-018](https://docs.proappstore.online/standard/ui/#pas-ui-018).
Unsupported: none.

## rollback — smoke failed after a successful upload

Finding: `qa_list_runs` shows the deploy-triggered run failed at "write a
note" (500 from a new action); upload and registration were fine. Deploy is
failed. Remediation: `git revert <sha>`; push; the deploy replaces the
prefix and re-registers the previous manifest; the migration from the
release stays (additive, harmless). Prove: run for the revert SHA
succeeded; `qa_list_runs` passed; served build equals the revert SHA. Then
fix forward. Two consecutive smoke failures would be an incident. Clause:
[PAS-OPS-009](https://docs.proappstore.online/standard/ops/#pas-ops-009), [PAS-OPS-010](https://docs.proappstore.online/standard/ops/#pas-ops-010),
[PAS-OPS-015](https://docs.proappstore.online/standard/ops/#pas-ops-015). Unsupported: rolling back the migration (interim: forward fix).
