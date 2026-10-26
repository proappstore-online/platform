---
description: "Review deployed observability acceptance gates and distinguish local contract tests from evidence in a live environment."
---

# Deployed acceptance gates for the observability epic (#387, #388)

Local and runtime tests prove the contracts. They cannot prove a deployed
environment, so the evidence for each gate below is kept apart from the tests.
This page lists what is proven where, and what still needs production evidence.

## Proven by tests (local and CI)

The synthetic conformance suite
(`packages/runtime-tests/test/backend/e2e-conformance.test.ts`, run in CI's
`runtime-integration` job) covers browser crash, caught React error, action
failure, auth loss, offline, room recovery failure, data-worker 5xx, quota
exhaustion, map mismatch, alert delivery failure and recovery, owner query
isolation, an evaluator outage, and unavailable components — see
`docs/monitoring-runbook.md` → "Synthetic conformance checks". Each issue's own
tests cover its contract in more depth.

## Needs a deployed environment

Status as of 2026-10-20, from read-only checks of production (D1, Analytics
Engine, the Cloudflare Workers API and public HTTP). Owner-session reads are not
among them: no operator holds an app owner's session.

| Gate | What closes it | Issues | Status (2026-10-20) |
|---|---|---|---|
| Real source-map upload via CI | an app built with hidden maps deploys through a workflow with the #393 steps; the deploy log shows the verified digest; no map served | #393, #396 | **done** — `chess-academy` has 25 active releases (2026-10-18 → 2026-10-20) uploaded keyless by CI; its map paths, including the live bundle's, are 404 on both origins; the platform symbolicator resolves two real releases to the exact original line. Templates now opt in by default |
| template-app sync | template-app's `deploy.yml` equals the canonical generator | #393, #425 | **done** — template-app `652d9ff`, `8246dbf`; CI `template-workflow-drift` green |
| Analytics Engine read access | `CF_ANALYTICS_API_TOKEN` on `proappstore-api` reads `pas_app_requests`; the burn-rate query runs | #391, #395 | **done** — token present; the evaluator's exact query ran against `pas_app_requests` (HTTP 200, expected column types) |
| Data-worker fleet rollout | `redeploy-data-workers.yml`, then the new settings verified | #390, #394 | **open** — 5 of 45 `pas-data-*` workers carry the #394 settings; 40 (including `chess-academy`) predate it. Their failures read `unknown`, counted as platform 5xx. Needs the fleet run, an operator decision |
| Controlled deployed test app | an app published through the admin flow (`/v1/publish`), with owner credentials: a real crash, trace, symbolication and alert delivery read back with timestamp, release SHA and incident reference | #396 | **open** — no dedicated test app is published; owner credentials are needed for the readback |
| Console readback | the same incident in the console Logs workspace | console#7, #396 | **open** — console#7 not delivered |
| Live evaluator | the scheduled evaluator runs and stamps health in production | #389, #391 | **done** — `telemetry_health.evaluator` OK every tick, never failed; the cursor advances with no recorded gap |
| Owner reads | owner-session reads of alerts, telemetry health, incidents and symbolicated logs for a real app | #389–#395 | **open** — owner credentials |
| Owner choices | reliability targets; each `app.alert` destination and responder | #395 | **operator gate** — no objectives and no `app.alert` webhook are configured in production |

Rows marked done record what was read and when on their issues. A real
production incident (a crash, a data-worker 5xx, a fired reliability incident)
has not been observed for any of them; the conformance suite and each issue's
tests are what prove that path.
