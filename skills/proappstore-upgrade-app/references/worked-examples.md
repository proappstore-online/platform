# Worked examples

One per evaluation scenario, in the output template's shape.

## dry-run-report — an app scaffolded in early 2026, heavily customised

Inventory: `engines` missing, `packageManager` absent; `@proappstore/sdk ^1.4.0`;
`initPro({ appId: 'ledger' })` with no `authMode`; `web/src/session.ts` caches
the session in `localStorage`; `deploy.yml` is a hand-edited variant with a
Cloudflare API token secret and no *Register app tools* step; `compliance.yml`
deleted; no `migrations.json` — `app.db.migrate([...])` runs at startup;
`mcp.json` has 9 actions, 3 without `requires_auth`; `list_app_tools` lists 8;
the theme boot reads `fas:theme`; viewport has `user-scalable=no`; PWA plugin
lacks `navigateFallbackDenylist`. Customisations: `web/src/App.tsx` (routing,
12 components), `web/src/ledger/*`, custom `index.html` metas and OG image,
a README with the customer's runbook. Report: every row of the baseline
table with drift, the customisations listed as preserved, the eight stages
with review and human flags, and the unsupported items (the stored token,
the runtime migrate). Nothing edited. Clause:
[PAS-STACK-001](https://docs.proappstore.online/standard/stack/#pas-stack-001), [PAS-STACK-005](https://docs.proappstore.online/standard/stack/#pas-stack-005),
[PAS-AUTH-001](https://docs.proappstore.online/standard/auth/#pas-auth-001), [PAS-DATA-002](https://docs.proappstore.online/standard/data/#pas-data-002),
[PAS-UI-002](https://docs.proappstore.online/standard/ui/#pas-ui-002), [PAS-UI-007](https://docs.proappstore.online/standard/ui/#pas-ui-007),
[PAS-UI-018](https://docs.proappstore.online/standard/ui/#pas-ui-018), [PAS-OPS-006](https://docs.proappstore.online/standard/ops/#pas-ops-006). Unsupported: none.

## toolchain-sdk — stages 1 and 2

Finding: no `engines`, no `packageManager`, SDK `^1.4.0` below the catalogue
requirement. Remediation: stage 1 adds `"engines": { "node": ">=22" }` and
`"packageManager": "pnpm@10.x"` (the catalogue's pnpm line), commits the
lockfile; stage 2 bumps `@proappstore/sdk` to the catalogue range and
changes only the call sites `sdk_reference` shows changed — none here.
Preserved: every product file. Prove: `pnpm install --frozen-lockfile`,
`pnpm typecheck`, `pnpm test`, `pas check` pass; released with
`proappstore-publish-deploy`. Clause:
[PAS-STACK-001](https://docs.proappstore.online/standard/stack/#pas-stack-001), [PAS-STACK-002](https://docs.proappstore.online/standard/stack/#pas-stack-002),
[PAS-OPS-007](https://docs.proappstore.online/standard/ops/#pas-ops-007). Unsupported: none.

## workflows-resync — stage 3

Finding: `deploy.yml` diverged (token secret, missing *Apply D1 migrations*
and *Register app tools*); `compliance.yml` deleted; `ci.yml` lacks
`pas check`. Remediation: after review, replace `deploy.yml` with the
canonical workflow, restore `compliance.yml` and the `ci.yml` gates; the
user deletes the token secret. Preserved: the app's e2e job, re-attached
after the canonical steps. Prove: the next deploy log shows
`Applied migration(s)` (or `already`), `Registered N app tool(s)`,
`Deployed apps/ledger from <sha>`; `gh secret list` clean; CI green. Clause:
[PAS-STACK-005](https://docs.proappstore.online/standard/stack/#pas-stack-005), [PAS-OPS-006](https://docs.proappstore.online/standard/ops/#pas-ops-006),
[PAS-OPS-004](https://docs.proappstore.online/standard/ops/#pas-ops-004). Unsupported: keeping the stored token (interim: keyless workflow).

## platform-cookie-migration — stage 4

Finding: `initPro` without `authMode`; `web/src/session.ts` writes the
session to `localStorage` and adds `Authorization` headers from
`app.auth.token`; the app also runs on `ledger.example.com`. Remediation:
`pas domain` shows the custom domain verified; the diff — `authMode:
'platform-cookie'` on the single `initPro`, `session.ts` deleted, two call
sites switched to `app.actions.call` — is shown and approved; commit.
Preserved: the sign-in screen and profile UI. Prove:
`app.auth.usesPlatformCookie` true; no session in storage; a person signs in
on `ledger.proappstore.online` and `ledger.example.com` (pending). Clause:
[PAS-AUTH-001](https://docs.proappstore.online/standard/auth/#pas-auth-001), [PAS-AUTH-002](https://docs.proappstore.online/standard/auth/#pas-auth-002),
[PAS-AUTH-003](https://docs.proappstore.online/standard/auth/#pas-auth-003), [PAS-AUTH-011](https://docs.proappstore.online/standard/auth/#pas-auth-011),
[PAS-AUTH-020](https://docs.proappstore.online/standard/auth/#pas-auth-020). Unsupported: none.

## data-layer — stage 5

Finding: `app.db.migrate([...])` at startup with 4 statements; no
`migrations.json`; 3 actions without `requires_auth`; `list_app_tools` lists
8 of 9 actions (the deploy never registered the last, because the old
workflow lacked the step). `schema_status` shows no failed rows.
Remediation: `migrations.json` with one entry per already-applied statement
in order (`0001_init` … `0004_ledger_tags`), the runtime call removed,
`requires_auth: true` added to the three actions — each edit shown and
approved; nothing else in `mcp.json` changed. Prove: the deploy reports the
entries as `already`; `schema_status` applied; `list_app_tools` lists 9;
negative tests added for the three actions. Clause:
[PAS-DATA-002](https://docs.proappstore.online/standard/data/#pas-data-002), [PAS-DATA-003](https://docs.proappstore.online/standard/data/#pas-data-003),
[PAS-DATA-004](https://docs.proappstore.online/standard/data/#pas-data-004), [PAS-STACK-008](https://docs.proappstore.online/standard/stack/#pas-stack-008).
Unsupported: a schema cleanup that drops columns (interim: additive only).

## ui-pwa-baseline — stage 6

Finding: `fas:theme` boot key; `user-scalable=no`; PWA plugin without
`navigateFallbackDenylist` and with `registerType: 'prompt'`; no maskable
icon. Remediation: theme key → `stores-theme` with `useTheme` /
`ThemeToggle`; viewport meta without `user-scalable=no`; PWA plugin →
`registerType: 'autoUpdate'`, `navigateFallbackDenylist: [/^\/\.pas\//]`;
maskable icon added. Preserved: title, description, OG image, custom head,
all styles. Prove: `pas check` passes `dark-mode`, `viewport-support`,
`pwa-offline`, `pwa-manifest`, `pwa-maskable-icon`; a person confirms the
installed app updates (pending). Clause:
[PAS-UI-002](https://docs.proappstore.online/standard/ui/#pas-ui-002), [PAS-UI-007](https://docs.proappstore.online/standard/ui/#pas-ui-007),
[PAS-UI-018](https://docs.proappstore.online/standard/ui/#pas-ui-018), [PAS-UI-020](https://docs.proappstore.online/standard/ui/#pas-ui-020),
[PAS-UI-023](https://docs.proappstore.online/standard/ui/#pas-ui-023). Unsupported: none.

## customised-app-preserve — refusing the rewrite

Finding: the user asks to "make it look like the current template". The
app's `App.tsx` carries its routing and 12 components; its `index.html` has
customer metas; its `README.md` is the customer's runbook. Remediation: the
plan lists these as product-owned and preserved; every stage's file list is
limited to template-owned files or shown diffs; the request to replace
`App.tsx` is declined with the ownership table. Prove: after all stages,
`git diff <before>..<after> -- web/src` contains only the `initPro` options
and the deleted `session.ts`. Clause:
[PAS-STACK-001](https://docs.proappstore.online/standard/stack/#pas-stack-001), [PAS-OPS-009](https://docs.proappstore.online/standard/ops/#pas-ops-009).
Unsupported: re-scaffold (interim: staged plan).

## stage-rollback — stage 6 broke the installed app

Finding: after stage 6 the smoke fails on the installed shell (a custom
`workbox` option conflicted with `autoUpdate`). Remediation:
`git revert <stage 6 sha>`, release, smoke passes; stages 1–5 stay in place;
the PWA change is re-planned with the customer's option preserved.
Prove: `deploy_status` shows the revert run green; `qa_list_runs` passed;
served build equals the revert SHA. Clause:
[PAS-OPS-009](https://docs.proappstore.online/standard/ops/#pas-ops-009), [PAS-OPS-010](https://docs.proappstore.online/standard/ops/#pas-ops-010).
Unsupported: none.
