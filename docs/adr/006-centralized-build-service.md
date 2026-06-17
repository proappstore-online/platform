# ADR-006: Build architecture — stay on per-repo GitHub Actions; if centralizing, use Cloudflare's first-party stack (NOT a hand-rolled container pipeline)

## Status

**Deferred** (2026-06-17). A centralized build service was prototyped (Phases
1–3, see below) and then **rejected as the path forward** after researching how
platforms actually build on Cloudflare. The immediate problem it aimed to solve
(per-repo workflow drift) is already solved by other means. This ADR records the
evaluation, the research, and how to resume if/when centralized build is needed.

## Date

2026-06-17

## Context

Every PAS app repo carries a full GitHub Actions deploy workflow
(`deployWorkflowYaml()` in `packages/admin/src/publish.ts`) that runs
`pnpm install` + `vite build` and uploads `dist/` to the `pas-apps` R2 bucket,
served by `proappstore-host` (Path B — R2 + one host Worker, chosen to escape the
100-project CF Pages cap).

A full CI workflow in every repo caused a cluster of problems:
- **Drift** — agents hand-edited workflows (`cache: pnpm` with no committed
  lockfile) that hard-failed CI; ~21 repos carried the landmine.
- **Multi-org** — the deploy assumes the `proappstore-online` org + org-level R2
  secrets; a creator's own-org repo isn't cleanly supported.
- **Cost** — private repos (which Pro apps want) burn metered GitHub Actions
  minutes.

The "best practice for a hosting platform" is **centralized build** (the platform
builds; the app repo carries no CI) — Vercel/Netlify/Pages all do this. We
prototyped that as a hand-rolled service on Cloudflare Containers.

## Decision

**Keep the current per-repo GitHub Actions solution.** Do **not** ship the
hand-rolled container build service. If/when centralized build is genuinely
needed, the target is **Cloudflare's first-party stack**, not a bespoke pipeline.

Reasoning, evidence-based (see Research):

1. **The urgent problem (drift) is already solved** without centralizing — single
   source of truth (`deployWorkflowYaml`) + a committed golden file
   (`packages/admin/src/__fixtures__/canonical-deploy.yml`) + the
   `scripts/sync-template-workflow.mjs` sync script + a CI drift-check job. Plus
   `provisionApp` strip-and-injects the canonical workflow on agent deploys.
2. **Multi-org and cost are not urgent** pre-launch (~25 apps, all in one org).
3. **The hand-rolled container service reinvents Workers Builds.** Cloudflare
   ships a first-party build-on-push CI/CD (Workers Builds) plus static-asset
   serving (Workers Static Assets) plus unlimited multi-tenant Workers (Workers
   for Platforms). Building our own queue→container pipeline duplicates that.

### If we DO centralize later — the target architecture (CF-native)

| Concern | CF-native answer |
|---|---|
| Build on push | **Workers Builds** — connect each app repo; CF builds + deploys on commit. GA. 6,000 build-min/mo (paid) + $0.005/min, 6 concurrent, 20-min timeout, 4 vCPU/8 GB. |
| Serve the built app | **Workers Static Assets** — serve from the Worker directly (no R2-upload step). 100k assets/version, 25 MiB/file (paid/WfP). |
| Many apps / multi-tenant | **Workers for Platforms** — dispatch namespace holds **unlimited** tenant Workers (no per-account script cap); a dispatch Worker routes `<app>.proappstore.online` → the tenant Worker (replaces the host Worker's R2 lookup). |
| Multi-org | Workers Builds connects any GitHub/GitLab repo; no org-level secret sharing. |

This is the documented Cloudflare platform pattern (Workers for Platforms +
Workers Builds + Static Assets).

**Cost is NOT the blocker.** Workers for Platforms is **~$25/mo flat, self-serve**
(no Enterprise contract): 1,000 user Workers included (we have ~25 apps), 20M
requests + 60M CPU-ms/mo included (pre-launch usage is far below this). So at PAS
scale the cost is just the $25/mo base fee on top of the existing $5/mo Workers
Paid. The real cost is the **migration**: moving from Path B (R2 + one host
Worker serving all apps) to workers-per-app under a dispatch namespace — every
app becomes its own Worker with static assets, the host Worker's R2-lookup
routing becomes a dispatch Worker, and build/deploy moves to Workers Builds.
That re-architecture (and the risk of migrating a working system) is why it is
deferred until multi-tenant scale or private-repo Actions cost actually justifies
the lift — not the price.

## Alternatives Considered

| Alternative | Verdict |
|---|---|
| **Per-repo GitHub Actions → R2 + host Worker (current)** | **Chosen (status quo).** Works; drift solved via guards; cost only on private repos at scale. |
| **Reusable workflow (thin caller stub)** | Good drift-killer, ~free, batch-native runners. Still "CI in the repo," doesn't fix multi-org/cost. A valid low-effort improvement if we want to also retire the per-repo workflow file. |
| **Hand-rolled CF Containers build service** (prototyped, Phases 1–3) | **Rejected.** Technically valid — CF Containers *do* support one-shot batch jobs (`container.start({entrypoint, envVars})`, `getState().exitCode`, `onStop()`); the queue→consumer→container pattern is sound. But it **reinvents Workers Builds**, and solves non-urgent problems. |
| **Workers Builds + Static Assets + Workers for Platforms** | **The target if centralizing.** First-party, build-on-push, unlimited tenant Workers. Cost is modest (~$25/mo flat at this scale); the blocker is the Path B → workers-per-app migration → defer until the lift is justified. |
| **CF Pages git integration** | Rejected — reintroduces the 100-project cap Path B escaped. |
| **Off-CF batch (Cloud Run Jobs / CodeBuild)** | Rejected — violates ADR-001 single-vendor (Cloudflare-only). |

## Consequences

**Positive:**
- No new infrastructure to build or operate; the working solution stays.
- The real pain (drift) stays fixed by the lightweight guards.
- The target architecture for "later" is now documented and evidence-based, so
  the decision can be made deliberately rather than re-litigated.

**Negative:**
- Per-repo workflow + private-repo Actions cost remain (acceptable at current
  scale).
- The Phases 1–3 prototype is removed (see Teardown) — sunk effort, but the
  knowledge is captured here.

**Neutral:**
- ADR-001 (Cloudflare-only) is unaffected; all candidate paths stay on CF.

## The prototype that was built (Phases 1–3) and how to resurrect it

Built 2026-06-16/17, then removed. Recoverable from git history:

- **Phase 1** — build container (`packages/builder`): `clone → pnpm install →
  vite build → aws s3 sync` to `pas-apps/apps/<id>/`. Commit `ea7fe1a`.
- **Phase 2** — orchestrator Worker (`packages/build-orchestrator`): GitHub App
  webhook → HMAC verify → repo-scoped installation token → Cloudflare Queue.
  Commits `56ac482`, `d726ebe`. Deployed live at `build.proappstore.online`,
  verified end-to-end (signed webhook → 202 → queued).
- **Phase 3** — build records in D1 (`migrations/0032_builds.sql`) + a `/builds`
  read endpoint. Commit `ad9794a`. Verified end-to-end (record lifecycle +
  real GitHub App token mint).
- **Host wiring** — `build` reserved subdomain + `BUILD` service binding +
  dispatch in `packages/host`. Commit `2899ad3`.
- **Infra provisioned** — `PAS Builder` GitHub App (id 4072875, install 140775460),
  `pas-builds` Queue, `builds` D1 table, `GH_BUILDER_*` Doppler secrets
  (`pas/prd`).

To resurrect: `git revert`/cherry-pick those commits, re-create the queue, re-add
the host `BUILD` binding, re-point the GitHub App webhook. **But prefer the
CF-native target above over reviving this.**

## Teardown (executed after this ADR)

Remove the prototype since it reinvents Workers Builds:
1. Revert host changes (`2899ad3`) + redeploy host (drops the `BUILD` binding).
2. Delete `packages/builder`, `packages/build-orchestrator`,
   `.github/workflows/deploy-build-orchestrator.yml`; add `0033_drop_builds.sql`.
3. Delete the `proappstore-build-orchestrator` Worker + `pas-builds` Queue.
4. Remove `GH_BUILDER_*` from Doppler.
5. Delete (or disable the webhook on) the `PAS Builder` GitHub App.

**Keep** (these were real fixes to the GH-Actions solution, independent of the
experiment): the single-source-of-truth refactor, golden file, sync script + CI
drift-check, `template-seed` workflow removal, and the `tt`/`dog-walking-app`/
`template-app` canonicalization.

## Sources (research, 2026-06-17)

- Workers Builds (CI/CD): https://blog.cloudflare.com/workers-builds-integrated-ci-cd-built-on-the-workers-platform/ ; limits/pricing: https://developers.cloudflare.com/workers/ci-cd/builds/limits-and-pricing/
- Containers batch jobs (`start()`/`getState()`/`onStop()`): https://developers.cloudflare.com/containers/container-class/
- Workers for Platforms (unlimited tenant Workers, dispatch namespaces): https://developers.cloudflare.com/cloudflare-for-platforms/workers-for-platforms/how-workers-for-platforms-works/
- Static asset limits (100k/version): https://developers.cloudflare.com/changelog/2025-09-02-increased-static-asset-limits/
- Reference architecture (programmable platforms): https://developers.cloudflare.com/reference-architecture/diagrams/serverless/programmable-platforms/
