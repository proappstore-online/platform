# ProAppStore — platform

The PAS control plane: Cloudflare Workers, the SDK, the CLI, and the D1 registry behind
`proappstore.online`. Product strategy is in `STRATEGY.md`; architecture and subsystem docs are in
`docs/` (published with VitePress).

## Delivery mode

**Straight to `main`. No branches, no pull requests.** Declared 2026-08-16.

This applies to the whole `proappstore-online` org, `platform` and the per-app repos alike. Push to
`main` and the change deploys.

Two consequences worth internalising before your first commit:

- **Each worker has its own path-filtered deploy workflow** (`.github/workflows/deploy-*.yml`). If
  your diff does not match a workflow's `paths:`, nothing deploys — a change can be merged, green,
  and inert. Check which workflow your paths trigger.
- **`deploy-backend.yml` applies D1 migrations to the live database before deploying**
  (`pnpm exec wrangler d1 migrations apply pas --remote`). There is no staging step in that path. A
  migration you push has run in production by the time you read the log.

Never release from local: no `wrangler deploy`, no `npm publish`. `publish.yml` publishes the npm
packages and commits the version bumps back.

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
node scripts/sync-template-workflow.mjs --check    # template-app deploy workflow drift
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
- **`pas-dev`** — implements issues by number and commits them to `main`. Refuses untracked work.

The handoff between them is the `_Files:_` footer on an issue: `pas-dev` partitions parallel work
from it.
