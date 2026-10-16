# Deployed acceptance gates for the observability epic (#387, #388)

Local and runtime tests prove the contracts. They cannot prove a deployed
environment, so no observability issue is closed on them alone. This page lists
what is proven where, and what still needs production evidence.

## Proven by tests (local and CI)

The synthetic conformance suite
(`packages/runtime-tests/test/backend/e2e-conformance.test.ts`, run in CI's
`runtime-integration` job) covers browser crash, caught React error, action
failure, auth loss, offline, room recovery failure, data-worker 5xx, quota
exhaustion, map mismatch, alert delivery failure and recovery, owner query
isolation, and unavailable components — see `docs/monitoring-runbook.md` →
"Synthetic conformance checks". Each issue's own tests cover its contract in
more depth.

## Needs a deployed environment

| Gate | What closes it | Issues | Status (2026-10-17) |
|---|---|---|---|
| Real source-map upload via CI | an app built with hidden maps deploys through a workflow with the #393 steps; the deploy log shows the verified digest; no `.map` in `pas-apps` | #393, #396 | **open** — no app has opted in yet |
| template-app sync | `node scripts/sync-template-workflow.mjs` by someone with push rights to `proappstore-online/template-app` | #393 | **open** — CI `template-workflow-drift` red |
| Analytics Engine read access | `CF_ANALYTICS_API_TOKEN` on `proappstore-api` reads `pas_app_requests`; the first live burn-rate query runs | #391, #395 | **unverified** |
| Data-worker fleet rollout | `redeploy-data-workers.yml`, then the new settings verified | #390, #394 | **open** — not run |
| Controlled deployed test app | an app published through the admin flow (`/v1/publish`), with owner credentials: a real crash, trace, symbolication and alert delivery read back with timestamp, release SHA and incident reference | #396 (item 2) | **open** |
| Console readback | the same incident in the console Logs workspace | console#7, #396 | **open** — console#7 not delivered |
| Live evaluator and owner reads | owner-session reads of alerts, telemetry health and incidents for a real app | #389–#395 | **open** |
| Owner choices | reliability targets; each `app.alert` destination and responder | #395 | **operator gate** |

#396 acceptance item 2 (a controlled deployed test app) and item 4 (no closure
on local tests while deployed acceptance is unverified) stay open until the rows
above that they depend on are done. Deploys themselves are recorded per commit
on each issue (CI and Deploy Worker run ids, migrations applied).
