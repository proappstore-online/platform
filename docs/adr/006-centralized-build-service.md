# ADR-006: Centralized build service (Cloudflare Containers), no per-repo CI

## Status

Proposed

## Date

2026-06-16

## Context

Today every PAS app repo carries a full GitHub Actions deploy workflow
(`deployWorkflowYaml()` in `packages/admin/src/publish.ts`) that runs
`pnpm install` + `vite build` and uploads `dist/` to the `pas-apps` R2 bucket.
The workflow reaches each repo three ways:

- **vibecode** — `handleAgentDeploy` strips any agent-authored workflow and
  injects the canonical one.
- **CLI** (`pas create`/`pas publish`) — the repo is cloned from `template-app`,
  which carries the canonical workflow; the user `git push`es it.
- **MCP** (`create_app`) — `createRepoFromTemplate` clones `template-app`.

A full CI workflow living in every repo is the **root cause** of a cluster of
problems we have repeatedly fixed by hand this cycle:

- **Drift.** Agents hand-edited workflows (`cache: pnpm` with no committed
  lockfile) that hard-failed CI; ~21 repos carried the landmine. We patched it
  with strip-and-inject, a golden file, a sync script, and a CI drift check —
  machinery whose only job is to keep N copies of a file identical.
- **Multi-org.** The deploy depends on org-level R2 secrets and a workflow that
  assumes `proappstore-online`. A creator who wants their proprietary code in
  their own org/repo is not cleanly supported.
- **Cost.** Private repos (which Pro apps want) burn metered GitHub Actions
  minutes. Public repos leak proprietary source.

This is the "bring your own CI" model. Every serious hosting platform
(Vercel, Netlify, Cloudflare Pages, Render, Railway) instead uses
**centralized build**: the app repo carries no CI, a connected app builds on the
platform's own infra and deploys to the platform's hosting. That is the best
practice for a hosting platform, and it dissolves drift, multi-org, and cost in
one architecture.

ADR-001 already constrains us to Cloudflare-only and explicitly notes that
"Workers' wall-time and request limits cap some compute shapes." A Vite build
(`pnpm install` + bundler, ~60–90s, real filesystem) is exactly such a shape —
it cannot run inside a Worker. The Cloudflare-native primitive that *can* run it
is **Cloudflare Containers**.

## Decision

Build a **centralized build service on Cloudflare Containers**. App repos carry
**no CI workflow**. The platform owns build + deploy end to end:

1. **GitHub App ("PAS Builder")** installed on `proappstore-online` (and, later,
   any creator org). Subscribes to `push` on the default branch. Replaces the
   per-repo deploy workflow. Installation tokens give cross-org repo access
   without org-level secrets — this is also the multi-org enabler.
2. **Build-orchestrator Worker** (`packages/builder`): receives the GitHub App
   webhook, verifies the HMAC signature, resolves repo → app id, and enqueues a
   build job (Cloudflare Queues) carrying `{ repo, sha, appId, installationId }`.
3. **Build Container** (CF Containers, Node 22 + pnpm image): per job, clones the
   repo at the pushed SHA using an installation token, runs
   `pnpm install --no-frozen-lockfile` + `pnpm build` (layout-adaptive:
   `dist/` or `web/dist/`), and uploads the output to `pas-apps` under
   `apps/<appId>/`. Reports status + logs back to the orchestrator.
4. **Build records** in D1 (`builds` table) + surfaced in the console (status,
   logs, duration) — replacing GitHub Actions run visibility.

Per ADR-001, Containers is a Cloudflare product, not a new third-party
dependency, so this **extends** ADR-001's stack (it does not supersede it). It
directly answers the compute-limit caveat ADR-001 recorded.

Once live, per-repo workflows are removed and the drift machinery
(golden file, sync script, CI drift check, strip-and-inject) is decommissioned —
there is nothing left to drift.

## Alternatives Considered

| Alternative | Why Rejected |
|---|---|
| **Keep per-repo workflow + drift guards** (current) | Works, but it is the "bring your own CI" model; it is the root cause of drift/multi-org/cost. The guards make it *safe*, not *right*. |
| **Reusable workflow (thin caller stub)** | A real improvement over copy-paste, but still puts CI in the user's repo and still runs on the user's (metered, for private) Actions. A stepping stone, not the destination. Does not fix multi-org or cost. |
| **CF Pages git integration** | Reintroduces the 100-project Pages cap that Path B was built to escape; contradicts the R2 + host-worker hosting model. |
| **CF Workers Builds** | Designed to deploy a Worker per project; bending it into "build static → shared R2 bucket" reintroduces per-project setup and an awkward fit. |
| **Self-hosted GitHub Actions runners** | Zeroes GitHub minutes while keeping the exact pipeline, but you operate runner infra AND still have a per-repo workflow (drift remains). Untrusted creator code needs ephemeral isolation. A cost lever, not an architecture fix. |
| **Third-party CI (CircleCI, etc.)** | New third-party dependency → would need to justify against ADR-001's single-vendor posture; adds a billing + auth surface. |

## Consequences

**Positive:**
- **No drift, ever.** Repos carry no workflow; there is nothing to copy, rot, or
  keep in sync. The golden file / sync script / CI drift check / strip-and-inject
  all get deleted.
- **Multi-org for free.** A GitHub App installs on any org; installation tokens
  replace org-level R2 secrets. Creators can keep proprietary code in their own
  private repo/org and the platform just builds + hosts it.
- **Lower per-build cost than private Actions.** Container compute for a ~90s
  build is sub-cent and runs on infra we control; it removes the metered
  GitHub-Actions-minutes line for private repos. (Verify against current CF
  Containers pricing before committing capacity.)
- **Full build-environment control** — pin Node/pnpm, cache the pnpm store,
  enforce build limits centrally, evolve the build once for every app.

**Negative:**
- **Real engineering + ops.** A webhook receiver, queue, container image, build
  orchestration, R2 upload, log capture, status surfacing, retries, and
  failure handling — a service we build and operate, not a config change.
  Estimate: multi-week, multi-phase.
- **New infra surface.** Containers + Queues + a GitHub App are new moving parts
  with their own failure modes and security considerations (building untrusted
  creator code → one-shot, network-egress-limited containers).
- **Build observability must be rebuilt.** Today the GitHub Actions UI is the
  build log. We must provide equivalent logs/status in the console.

**Neutral:**
- GitHub Actions is retained as a **fallback during migration**; apps cut over
  incrementally, and the per-repo workflow is removed only after the build
  service is proven on that app.
- The behavioral e2e gate (Playwright) currently in the deploy workflow must
  find a new home (a post-build step in the orchestrator, or a separate job).

## Prerequisites (require account-owner action — cannot be done from code)

1. **Create the "PAS Builder" GitHub App** (org settings → Developer settings):
   `push` webhook + `contents:read`, `metadata:read` repo permissions; install on
   `proappstore-online`. Store the App ID + private key + webhook secret in
   Doppler (`pas/prd`).
2. **Enable Cloudflare Containers** on the account and confirm the plan/limits.
3. **R2 access for the container** — either an S3-API token scoped to `pas-apps`
   (passed to the container) or upload via a service binding back to the
   orchestrator Worker's R2 binding.

## Phased build plan

- **Phase 1 (this change): the build container, locally proven.** Dockerfile +
  build script (`clone → install → build → upload to R2`), layout-adaptive,
  with a local test of the build/upload logic. The riskiest unknown, validated
  first, before any GitHub App or webhook exists.
- **Phase 2:** orchestrator Worker — webhook receiver (signature verify) →
  Queue → invoke the container. Wire the GitHub App.
- **Phase 3:** build records (D1) + console build status/logs.
- **Phase 4:** migrate apps off per-repo CI (stop injecting/seeding; remove
  workflows) one cohort at a time, GitHub Actions as fallback.
- **Phase 5:** decommission the drift machinery (golden, sync script, CI check,
  strip-and-inject) — no longer needed once repos carry no workflow.
