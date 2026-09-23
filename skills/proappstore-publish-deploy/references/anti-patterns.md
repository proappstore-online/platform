# Anti-patterns to detect and remediate

Each entry: what to look for, why it is wrong, the clause, the remediation,
and the proof. Findings cite the clause and the file, run or command.

## 1. Manual infrastructure deploy

**Detect:** `wrangler` in `package.json` scripts or a workflow; a script that copies `dist/` to R2; instructions to "upload the build"; a Cloudflare Pages project for the app; edits to DNS or the host by hand.
**Why:** the platform owns the R2 prefix, the host and the registry; a manual upload bypasses migrations, registration and the smoke, and leaves no evidence.
**Clause:** [PAS-STACK-004](https://docs.proappstore.online/standard/stack/#pas-stack-004), [PAS-STACK-005](https://docs.proappstore.online/standard/stack/#pas-stack-005).
**Remediate:** remove the script; push to `main` and let `deploy.yml` run.
**Prove:** the deploy run URL shows *Upload to R2* and *Register app tools* for the SHA.

## 2. Infrastructure secrets in the repository

**Detect:** `gh secret list` shows Cloudflare, R2 or platform tokens; `.env*` not git-ignored; a `CLOUDFLARE_API_TOKEN` in a workflow; a session copied into a test.
**Why:** deploy auth is GitHub OIDC minted inside the run; a stored token is a standing credential anyone with repo access can exfiltrate.
**Clause:** [PAS-OPS-006](https://docs.proappstore.online/standard/ops/#pas-ops-006), [PAS-STACK-005](https://docs.proappstore.online/standard/stack/#pas-stack-005).
**Remediate:** delete the secrets; restore the template `deploy.yml`; move third-party keys to `pas secret set`.
**Prove:** `gh secret list` is empty or holds the e2e fixture only; the deploy still succeeds.

## 3. Pushing on red, or weakening a gate

**Detect:** a push to `main` while CI is failing; a test skipped or deleted in the release commit; `pas check` removed from `ci.yml`; the compliance workflow disabled; `--no-verify`.
**Why:** the gates are the only automated statement that the release is safe; a bypass ships an unknown.
**Clause:** [PAS-OPS-004](https://docs.proappstore.online/standard/ops/#pas-ops-004), [PAS-OPS-001](https://docs.proappstore.online/standard/ops/#pas-ops-001).
**Remediate:** fix the failure; restore the gate; re-run.
**Prove:** the last commits on `main` have green CI and compliance runs.

## 4. Rolling back schema by editing history

**Detect:** an applied `migrations.json` entry edited, reordered or deleted "to undo"; `app.db.migrate` run against production; a `DROP` added to revert a column.
**Why:** an edited entry never re-applies; the live schema and the file diverge and the next deploy fails or the app hits "no such column".
**Clause:** [PAS-OPS-008](https://docs.proappstore.online/standard/ops/#pas-ops-008), [PAS-DATA-002](https://docs.proappstore.online/standard/data/#pas-data-002).
**Remediate:** restore the entry; append a corrective additive migration; make the reverted code tolerate the column.
**Prove:** `schema_status` shows every entry applied and none failed.

## 5. Success claimed from unit tests

**Detect:** a release report that says "deployed" after `pnpm test` or a green build; no smoke run for the SHA; "tests pass so production is fine".
**Why:** unit tests prove assertions in a sandbox; only the smoke against the live URL proves the deploy.
**Clause:** [PAS-OPS-010](https://docs.proappstore.online/standard/ops/#pas-ops-010), [PAS-OPS-019](https://docs.proappstore.online/standard/ops/#pas-ops-019).
**Remediate:** `qa_list_runs` for the deploy-triggered run, or `qa_run`; treat the deploy as failed until it passes; list human checks as pending.
**Prove:** the report links a passing smoke run id for the deployed SHA.

## 6. Stale assets served

**Detect:** the live page reports the previous `VITE_COMMIT_SHA`; `app.logs` entries still carry the old `build`; the run log lacks `Deployed apps/<app> from <sha>`; a service worker without `autoUpdate`; runtime caching of `/.pas/*`.
**Why:** the upload did not replace the prefix, or the installed shell is pinned by the service worker; users run old code against the new schema and actions.
**Clause:** [PAS-OPS-020](https://docs.proappstore.online/standard/ops/#pas-ops-020), [PAS-UI-018](https://docs.proappstore.online/standard/ui/#pas-ui-018).
**Remediate:** confirm the upload line for the SHA; re-run the workflow if it is missing; keep the template's service worker config; hard reload the installed app.
**Prove:** a fresh log entry's `build` equals the pushed SHA.

## 7. Blind retry

**Detect:** re-pushing a failed migration without reading `schema_status`; re-running a deploy in a loop; retrying a 422 registration unchanged.
**Why:** a failed migration or manifest is deterministic — the retry fails the same way and the log fills with noise; the failure has to be read first.
**Clause:** [PAS-OPS-008](https://docs.proappstore.online/standard/ops/#pas-ops-008), [PAS-OPS-013](https://docs.proappstore.online/standard/ops/#pas-ops-013).
**Remediate:** read the run log and `schema_status`; fix the cause; retry once; a second identical failure is an incident.
**Prove:** the retry run succeeds, or an incident record exists.

## 8. Missing evidence bundle

**Detect:** a release report without the run URL, SHA, migration/registration/upload lines, smoke id, `schema_status`, `pas check` output, secrets list or served SHA.
**Why:** an audit cannot accept a deploy it cannot reconstruct.
**Clause:** [PAS-OPS-005](https://docs.proappstore.online/standard/ops/#pas-ops-005), [PAS-OPS-020](https://docs.proappstore.online/standard/ops/#pas-ops-020).
**Remediate:** collect every item from the [evidence bundle](decision-tables.md) table; mark the report incomplete until then.
**Prove:** every field present and linked.

## 9. Registered actions drift from the manifest

**Detect:** `discover_tools` lists tools not in the committed `mcp.json`, or misses some; the *Register app tools* step warned about a missing column; a manifest registered by hand.
**Why:** the deploy re-registers the committed manifest on every run; a difference means a step did not run or someone registered outside the path.
**Clause:** [PAS-STACK-008](https://docs.proappstore.online/standard/stack/#pas-stack-008), [PAS-DATA-002](https://docs.proappstore.online/standard/data/#pas-data-002).
**Remediate:** re-run the workflow for the SHA; fix `mcp.json` or append the migration if registration rejected it.
**Prove:** `Registered N app tool(s)` with N equal to the manifest; `discover_tools` matches.
