# Build & Deploy — current state vs future state

How a PAS app gets from a git push to a live URL, what we watch, and where this
goes if we ever centralize. Decision record: [ADR-006](./adr/006-centralized-build-service.md).

## Current state (what runs today)

**Per-repo GitHub Actions → R2 → one host Worker (Path B).**

1. **App repo** carries `.github/workflows/deploy.yml` (the canonical workflow).
   On push to `main` it runs `pnpm install --no-frozen-lockfile` + `vite build`
   (layout-adaptive: `dist/` or `web/dist/`) and `aws s3 sync`s the output to the
   `pas-apps` R2 bucket under `apps/<app>/`.
2. **`proappstore-host`** (one Worker, route `*.proappstore.online/*`) serves every
   app from R2 by subdomain, and dispatches reserved subdomains (`api`, `admin`,
   `agents`, `mcp`, `kb`, `docs`) to sibling Workers via service bindings.
3. **Where the workflow comes from:**
   - **Vibecode** (agent-teams): `provisionApp` strips any agent-authored
     workflow and injects the canonical `deployWorkflowYaml()` — the platform
     owns CI on this path.
   - **CLI / MCP**: the repo is cloned from `template-app`, which carries the
     canonical workflow.

### Drift guards (the thing we're watching)

A full workflow in every repo can drift (the `cache: pnpm`-without-lockfile
landmine that broke ~21 repos). It's contained, not eliminated, by:
- **One source of truth** — `deployWorkflowYaml()` in `packages/admin/src/publish.ts`.
- **Golden file** — `packages/admin/src/__fixtures__/canonical-deploy.yml`, pinned
  byte-for-byte to the generator by a unit test.
- **Sync script** — `scripts/sync-template-workflow.mjs` pushes the golden to
  `template-app`; `--check` mode detects drift.
- **CI drift job** — `template-workflow-drift` in `.github/workflows/ci.yml` fails
  if `template-app` diverges from the generator.

**What we're watching:** how often workflow drift still surfaces despite these
guards (e.g. agents inventing new workflow variants, lockfile breakage on new
apps, per-repo edits). If it keeps recurring — or once private-repo Actions cost
or multi-org demand bites — that's the signal to migrate (below).

### Known limitations of the current state
- A CI workflow lives in every repo (the root cause of drift).
- Private repos burn metered GitHub Actions minutes.
- Multi-org (a creator's own-org repo) isn't cleanly supported (org-level R2
  secrets + `proappstore-online` assumptions).

## Future state (if/when we centralize)

**Cloudflare's first-party stack — NOT a hand-rolled build pipeline.**

| Concern | Target |
|---|---|
| Build on push | **Workers Builds** (native CI/CD; GA). 6,000 build-min/mo + $0.005/min, 6 concurrent, 20-min timeout. |
| Serve the app | **Workers Static Assets** (serve from the Worker; no R2-upload step). 100k assets/version. |
| Many apps / multi-tenant | **Workers for Platforms** — dispatch namespace, **unlimited** tenant Workers; a dispatch Worker routes `<app>.proappstore.online` → the tenant Worker (replaces host's R2 lookup). |
| Multi-org | Workers Builds connects any GitHub/GitLab repo; no org-secret sharing. |

This eliminates the per-repo workflow entirely (no drift possible), removes the
GitHub Actions cost, and supports multi-org — the three current limitations, gone.

### Cost (not the blocker)
~**$25/mo flat** for Workers for Platforms at this scale (1,000 Workers / 20M
requests / 60M CPU-ms included; we have ~25 apps and ~zero pre-launch traffic),
on top of the existing $5/mo Workers Paid.

### The actual blocker: migration
This is a real re-architecture from Path B: every app becomes its own Worker with
static assets, the host Worker's R2-lookup routing becomes a dispatch Worker, and
build/deploy moves to Workers Builds. Migrating a working system carries effort
and risk that isn't justified until the limitations above actually hurt.

## Trigger conditions — when to revisit
Migrate to the future state when **any** of these becomes real:
- Workflow drift keeps surfacing despite the guards (operational toil).
- Private-repo GitHub Actions minutes become a meaningful cost.
- A creator needs their proprietary app in **their own org/repo** (multi-org).
- App count grows enough that per-repo CI maintenance is a burden.

Until then: **keep the current state, keep the guards, watch the drift.**

## History
A centralized build service was prototyped on Cloudflare Containers (Phases 1–3,
2026-06-16/17) and removed after research showed it reinvented Workers Builds.
Full details + how to resurrect: [ADR-006](./adr/006-centralized-build-service.md).
