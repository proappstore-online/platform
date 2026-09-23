# Unsupported requirements — say so, give the interim pattern, cite the clause

A requirement here has **no platform primitive today**, or is forbidden by
the standard. Recommend the interim pattern; never a manual workaround on
infrastructure.

| Requirement | Status | Interim pattern that conforms | Cite |
|---|---|---|---|
| Deploying without a push (manual upload, `wrangler`, a "hotfix" on the host) | forbidden | commit the fix and push; the workflow is the deploy | [PAS-STACK-004](https://docs.proappstore.online/standard/stack/#pas-stack-004), [PAS-STACK-005](https://docs.proappstore.online/standard/stack/#pas-stack-005) |
| A staging or preview environment for the app | not offered — one prefix per app | local development with the same SDK; feature flags in the code; small, revertible releases | [PAS-OPS-009](https://docs.proappstore.online/standard/ops/#pas-ops-009) |
| Blue/green or canary releases | not offered | ship small; verify with the smoke; revert fast | [PAS-OPS-009](https://docs.proappstore.online/standard/ops/#pas-ops-009), [PAS-OPS-010](https://docs.proappstore.online/standard/ops/#pas-ops-010) |
| Rolling back a migration (drop the column, restore the old table) | forbidden — schema is forward-only | a new additive migration; reverted code that tolerates the column | [PAS-OPS-008](https://docs.proappstore.online/standard/ops/#pas-ops-008), [PAS-DATA-002](https://docs.proappstore.online/standard/data/#pas-data-002) |
| Restoring data to a point in time | none app-facing | the scoped export/import actions and the written recovery path | [PAS-OPS-014](https://docs.proappstore.online/standard/ops/#pas-ops-014) |
| Storing a Cloudflare, R2 or platform token to "simplify" the workflow | forbidden | the template's OIDC mint inside the run | [PAS-OPS-006](https://docs.proappstore.online/standard/ops/#pas-ops-006) |
| Deploying from a branch other than `main` | not offered — OIDC claims require `main` | merge to `main`; the merge is the release | [PAS-STACK-005](https://docs.proappstore.online/standard/stack/#pas-stack-005) |
| Automated proof that production is healthy for a person's checklist | not offered — the checklist is human | the smoke proves the flows it covers; a person records the checklist | [PAS-OPS-019](https://docs.proappstore.online/standard/ops/#pas-ops-019) |
| Registering `mcp.json` by hand, or partially | not offered | commit the manifest; the deploy replaces it whole | [PAS-STACK-008](https://docs.proappstore.online/standard/stack/#pas-stack-008) |
| Running the smoke against a private or local URL | not offered — QA runs target the live app | the observable runner on the live URL; Playwright parity locally via `qa_flow_playwright` | [PAS-OPS-010](https://docs.proappstore.online/standard/ops/#pas-ops-010) |
| Silencing the deploy's e2e failure to "get it out" | forbidden | fix the flow or the app; the failing step is the acceptance | [PAS-OPS-010](https://docs.proappstore.online/standard/ops/#pas-ops-010) |

When a gap is decisive, say so and stop: it is a **blocker: unsupported
requirement**, not a reason to deploy around the path.
