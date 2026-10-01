# ProAppStore — platform

The PAS control plane: Cloudflare Workers, the SDK, the CLI, and the D1 registry behind
`proappstore.online`. Product strategy is in `STRATEGY.md`; architecture and subsystem docs are in
`docs/` (published with VitePress).

## Delivery mode

**Every development change goes through a pull request against `main`. Never push to `main`.**
Changed 2026-09-16 (previously straight-to-main, declared 2026-08-16). Applies to development
changes made by people and agents across the `proappstore-online` org — `platform` and every
platform-maintained repo (storefront, console, dashboard, templates).

- Branch, push, open a PR that says `Refs #<n>`, and let review reach it. The issue is closed only
  after the merged change has been verified in production (see `pas-dev: verify #<n>`), never by a
  closing keyword on merge.
- **Review is human until a PAS reviewer agent exists.** There is no reviewer agent in
  `.claude/agents/` and no `Ready To Merge` label on this repo yet; until both exist, a person reads
  the diff. Approval is always human.
- **Merging** is done by a human, or by a gated merger once one is configured for this org. Never
  by the agent that opened the PR.
- **Never force-push a branch under review** — reviewers pin findings to a SHA. Address review with
  new commits on top.
- **Merging to `main` deploys.** Each worker has its own path-filtered deploy workflow
  (`.github/workflows/deploy-*.yml`); if your diff does not match a workflow's `paths:`,
  nothing deploys — a change can be merged, green, and inert.
- **`deploy-backend.yml` applies D1 migrations to the live database before deploying**
  (`pnpm exec wrangler d1 migrations apply pas --remote`). There is no staging step. A
  migration you merge has run in production by the time you read the log.

Never release from local: no `wrangler deploy`, no `npm publish`.

**What the rule does not cover:**

- **`publish.yml` is the one automated exception in this repo.** After publishing the npm packages
  it commits `chore: auto-bump published versions [skip ci]` and pushes it to `main` as
  `github-actions[bot]` (`contents: write`). If branch protection or a ruleset is enabled on `main`,
  that workflow needs an explicit bypass, or the bump push fails after the packages are already on
  npm.
- **Product automation is product behaviour, not development.** MCP `write_file` /
  `batch_write_files` / `delete_file` commit to a creator's app repo on `main`, and the
  creator-facing guidance (the `proappstore-publish-deploy` skill, `docs/standard/`, the template's
  `deploy.yml`) tells creators to deploy by pushing to their app's `main`. That is how a published
  app ships; this rule does not change it.

## This is not one repo

`pnpm-workspace.yaml` globs `packages/*` and nothing else. The rest of PAS lives beside it:

| Path | What it is |
|---|---|
| `platform/packages/*` | Workers and libraries — `backend` (the `proappstore-api` worker), `host`, `kb-host`, `mcp`, `mcp-registry`, `admin`, `agent-teams`, `data-worker`, `qa-worker`, `build-core`, `compliance`, `qa-spec`, `sdk`, `cli` |
| `../proappstore/` | The storefront static site (plain HTML + `build.js`) |
| `../apps/<slug>/` | **One org repo per published app**, cloned locally. `console` = creator console, `dashboard` = subscriber dashboard; the rest are real apps |
| `../templates/` | App scaffolds |

A defect "in the console" is a commit in `proappstore-online/console`, not here. Check which repo an
issue belongs to before you start.

## Verification bar

Run from this directory before committing. Keep this list equal to the gates in
`.github/workflows/ci.yml`:

```
pnpm install --frozen-lockfile
pnpm -r --filter './packages/*' build
bash scripts/check-design-system.sh .              # banned CSS aliases, html.dark, theme storage key
pnpm -r typecheck
pnpm test                                          # vitest, from the workspace root
pnpm test:coverage                                 # same suite + V8 coverage floors (what CI's check job runs) + gaps report
pnpm test:runtime                                  # workerd + real D1: backend + data worker (packages/runtime-tests)
node scripts/sync-template-workflow.mjs --check    # template-app deploy workflow drift
node scripts/build-skills-manifest.mjs --check     # skill bundles valid + skills/index.json up to date (CI skills-gate)
```

`quality.yml` additionally runs `npx @vibecodeqa/cli --ci` with a score gate on push and PR.

## Constraints that are easy to violate by accident

- **`docs/adr/` is binding.** An ADR is a constraint, not a suggestion; supersede it rather than
  working around it.
- **Never `gh repo create`.** Org-level repo creation is disabled; apps are provisioned through the
  admin Worker's `/v1/publish`. A repo with no registry entry is drift, and its symptom is
  Cloudflare error 1014 on the custom domain.
- **Worker env vars are optional in `packages/backend/src/types.ts`.** A missing secret does not fail
  the build — it fails at runtime, usually as a 503. `packages/backend/src/routes/auth.ts:322` is the
  canonical example: it gates a provider on the client id alone, so a missing *secret* still
  redirects to the provider and fails later in the callback.
- **Migrations are sequential and numbers are never reused.** `migrations/` (root) and
  `packages/host/migrations/` are separate sequences — do not mix them.
- **Secrets are SOPS-encrypted in `~/dev/ops`, with no auto-sync.** Every `consumers:` entry is
  pushed by hand. See `~/dev/ops/AGENTS.md`.
- **No cross-store npm dependencies.** Shared code is vendored per store, by design. See
  `~/dev/stores/CLAUDE.md`.

## Agents

`.claude/agents/` defines the two agents for this codebase:

- **`pas-ba`** — turns an observation into a dev-ready GitHub issue grounded in `file:line` evidence
  and live production state. Writes issues; never code.
- **`pas-dev`** — implements issues by number and delivers them as pull requests against `main`
  (`Refs #<n>`); its run ends at an open PR with green checks. `pas-dev: verify #<n>` checks a
  merged change in production and only then closes the issue. Refuses untracked work.

The handoff between them is the `_Files:_` footer on an issue: `pas-dev` partitions parallel work
from it.
