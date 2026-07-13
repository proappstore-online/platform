# PAS Platform Tools Consolidation Plan

Date: 2026-06-30

## Goal

Consolidate PAS-owned platform tools into `platform/` where they share the same deploy lifecycle, API surface, credentials, or platform data model.

Do not consolidate app repos. Apps remain separate repositories under `apps/` or their own external orgs.

## Current Shape

Canonical platform monorepo:

- `platform/`
  - `packages/admin`
  - `packages/backend`
  - `packages/cli`
  - `packages/compliance`
  - `packages/data-worker`
  - `packages/host`
  - `packages/kb-host`
  - `packages/mcp`
  - `packages/mcp-registry`
  - `packages/sdk`
  - `packages/agent-teams`
  - `packages/build-core`

Separate repos that should stay separate:

- `proappstore/` storefront repo
- `templates/template-app/` template repo
- `apps/*` app repos

Already consolidated or replaced:

- GitHub `proappstore-online/admin` is archived
- GitHub `proappstore-online/host` is archived
- GitHub `proappstore-online/mcp` is archived
- Their active implementations now live under `platform/packages/*`

## Non-Goals

- Do not move apps into `platform/`.
- Do not merge `proappstore/` into `platform/` unless the storefront deploy lifecycle is intentionally changed.
- Do not merge `templates/template-app/` into `platform/` unless template publishing becomes platform-owned runtime behavior.
- Do not restructure `platform/` just to match another store.
- Do not vendor shared code from another store as an npm dependency.

## Consolidation Rules

Move a repo/tool into `platform/` only when at least one condition is true:

- It is a privileged platform service.
- It directly owns PAS platform credentials, provisioning, billing, analytics, domains, storage, or auth.
- It shares types or contracts with `backend`, `sdk`, `cli`, or `compliance`.
- It must be tested together with platform packages.
- It is no longer useful as a separately deployed product.

Keep it separate when:

- It has an independent deploy lifecycle.
- It is a creator/customer-facing app.
- It is a scaffold/template artifact copied into new projects.
- It is a storefront/static marketing surface.
- It belongs to another org, such as `carsads-online` or `wellness-online`.

## Candidate Review

### Keep Consolidated

`admin`, `host`, and `mcp` should remain consolidated in `platform/`.

Actions:

- Confirm archived GitHub repo descriptions point to `proappstore-online/platform`.
- Confirm README files in `platform/packages/admin`, `platform/packages/host`, and `platform/packages/mcp` explain that they are canonical.
- Confirm no production deploy still targets the archived repos.

### Review For Possible Consolidation

`apps/console`

- Current remote: `proappstore-online/console`
- Keep separate if it is a marketplace app or independently deployed console.
- Move into `platform/packages/console` only if it is an internal platform control-plane UI tightly coupled to `backend`.

Decision required:

- Is `console` a platform admin/control-plane tool or a published app?

`apps/dashboard`

- Current remote: `proappstore-online/dashboard`
- Keep separate if it is a creator/customer app dashboard.
- Move into `platform/packages/dashboard` only if it is a platform operations UI.

Decision required:

- Is `dashboard` part of PAS platform operations or an app/product surface?

### Keep Separate

`proappstore/`

- Separate storefront repo is consistent with the documented store layout.
- It has a distinct deploy and content lifecycle.

`templates/template-app/`

- Separate template repo is acceptable because templates are copied/scaffolded.
- Keep separate unless template generation becomes a platform package concern.

`apps/*`

- Apps stay separate by policy.
- This includes `carsads` and `wellness`, even though they live in external orgs.

## Cleanup Work

### 1. Document Canonical Ownership

Add or update documentation so the current ownership is obvious:

- `platform/README.md`: list platform-owned packages and note archived repo replacements.
- `platform/packages/admin/README.md`: canonical replacement for archived `admin`.
- `platform/packages/host/README.md`: canonical replacement for archived `host`.
- `platform/packages/mcp/README.md`: canonical replacement for archived `mcp`.
- `proappstore/README.md` if missing: clarify storefront stays separate.

Acceptance criteria:

- A new contributor can tell which repo is canonical for each PAS platform tool.
- Archived repos are not mistaken for active code.

### 2. Reconcile GitHub Repo Metadata

For archived repos:

- `admin`
- `host`
- `mcp`

Update GitHub descriptions/homepage fields to point at `platform/packages/*`.

Acceptance criteria:

- Archived repos clearly say they are superseded.
- No active issue tracker or deployment instruction points users to archived repos.

### 3. Decide Console/Dashboard Ownership

Classify:

- `console`
- `dashboard`

Possible outcomes:

- `platform-owned`: create follow-up migration plan into `platform/packages/<name>`.
- `app-owned`: leave as separate app repos and document them as app surfaces.

Acceptance criteria:

- Each repo has an explicit owner category.
- No migration starts until ownership is decided.

### 4. Registry And Local Inventory Cleanup

Do not consolidate apps, but make the inventory accurate.

Current mismatches:

- Local source not in storefront registry: `coffeerating`, `console`, `dashboard`, `wellness`
- Registry entry without local source clone: `clean-up`, `dog-walking-app`, `studio`, `timetrack`, `tt`
- External org app repos: `carsads-online/carsads`, `wellness-online/wellness`

Actions:

- Document which apps are intentionally external.
- Clone missing app repos only if local development needs them.
- Remove stale registry entries only if those apps are no longer published.
- Add missing registry entries only if those apps should be publicly listed.

Acceptance criteria:

- Registry contents match intended public storefront listings.
- Local checkout gaps are documented and not confused with consolidation gaps.

### 5. Validate Deploy Targets

Check deploy configuration for:

- `platform/packages/admin`
- `platform/packages/host`
- `platform/packages/mcp`
- `platform/packages/backend`
- `proappstore`
- `console`
- `dashboard`

Acceptance criteria:

- Platform services deploy from `platform/`.
- Storefront deploys from `proappstore/`.
- App-like surfaces deploy from their own repos unless explicitly migrated.

## Proposed Sequence

1. Documentation pass
   - Update canonical ownership docs.
   - Add archived-repo replacement notes.

2. Metadata pass
   - Update GitHub descriptions for archived platform repos.
   - Confirm archived flags remain set.

3. Ownership decision
   - Decide `console` and `dashboard`.
   - If either is platform-owned, write a separate migration plan before moving code.

4. Inventory pass
   - Reconcile registry vs local clones.
   - Document external app ownership.

5. Verification pass
   - Run platform tests.
   - Confirm deploy workflows reference canonical repos.
   - Confirm no app repos were moved.

## Risks

- Accidentally moving app/product UI into `platform/` increases coupling and slows app delivery.
- Leaving platform-owned UIs outside `platform/` can duplicate auth, SDK, and backend contracts.
- Registry cleanup can accidentally unpublish valid apps if source availability is confused with listing intent.
- Archived repo metadata can drift and make old repos look active again.

## Recommendation

Do a documentation and metadata cleanup first. Do not move code yet.

Only consider code migration for `console` and `dashboard`, and only after classifying them as platform-owned operational tools rather than apps.
