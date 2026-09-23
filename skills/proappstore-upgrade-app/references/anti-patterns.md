# Anti-patterns to detect and remediate

Each entry: what to look for, why it is wrong, the clause, the remediation,
and the proof. Findings cite the clause and the file.

## 1. Overwriting product code with the template

**Detect:** an upgrade plan (or a previous attempt) that copies the template's `web/src/App.tsx`, `index.css`, `README.md` or `mcp.json` over the app's; a diff that touches hundreds of product lines "to match the template"; reformatting.
**Why:** the template is a starting shape, not a target; the app's value is its product code and manifest. A broad rewrite destroys customisations and cannot be reviewed.
**Clause:** [PAS-STACK-001](https://docs.proappstore.online/standard/stack/#pas-stack-001), [PAS-OPS-009](https://docs.proappstore.online/standard/ops/#pas-ops-009).
**Remediate:** follow the ownership table: re-sync template-owned files only; product-owned files get a minimal, shown diff after review; one stage per commit.
**Prove:** `git diff --stat` of the stage touches only the listed files; the app's features still pass its tests.

## 2. Legacy bearer sessions on a hosted app

**Detect:** `initPro({ appId })` without `authMode`, or `authMode: 'legacy-bearer'`; `localStorage` / `sessionStorage` code around `pas:session`, `token` or `#pas_session`; `app.auth.token` in requests; `fetch('/v1/auth/…')`.
**Why:** the SDK default is a compatibility setting; hosted apps must use the host-only HttpOnly cookie, and any copied session is readable by page scripts.
**Clause:** [PAS-AUTH-001](https://docs.proappstore.online/standard/auth/#pas-auth-001), [PAS-AUTH-002](https://docs.proappstore.online/standard/auth/#pas-auth-002), [PAS-AUTH-003](https://docs.proappstore.online/standard/auth/#pas-auth-003).
**Remediate:** stage 4 — add `authMode: 'platform-cookie'` to the single `initPro`; delete the storage and token code; verify custom domains with `pas domain`; a person signs in on every hostname.
**Prove:** `app.auth.usesPlatformCookie === true`; no session in storage after sign-in; `/.pas/auth/me` returns the user on each hostname.

## 3. Drifted or credentialed deploy workflow

**Detect:** `deploy.yml` differs from the canonical workflow; a step missing (no *Apply D1 migrations*, no *Register app tools*); `secrets.CLOUDFLARE_API_TOKEN`, R2 keys or a platform token; a manual dispatch trigger that deploys from branches; `wrangler` steps.
**Why:** the platform's deploy is keyless and applies schema before code; a variant skips steps and a stored token is a standing credential.
**Clause:** [PAS-STACK-005](https://docs.proappstore.online/standard/stack/#pas-stack-005), [PAS-OPS-006](https://docs.proappstore.online/standard/ops/#pas-ops-006), [PAS-OPS-005](https://docs.proappstore.online/standard/ops/#pas-ops-005).
**Remediate:** stage 3 — replace `deploy.yml` with the canonical workflow after review; the user deletes the secrets; keep any e2e job the app added only if it runs after the canonical steps.
**Prove:** the next deploy log has `Applied migration(s)`, `Registered N app tool(s)`, `Deployed apps/<app> from <sha>`; `gh secret list` is clean.

## 4. Missing or weakened gates

**Detect:** no `ci.yml`; `compliance.yml` deleted or `if: false`; CI without `pnpm install --frozen-lockfile`, `pnpm typecheck`, `pnpm test` or `pas check`; `@proappstore/cli` too old to run `pas check`.
**Why:** an upgrade with no gates cannot show it kept the app working.
**Clause:** [PAS-OPS-004](https://docs.proappstore.online/standard/ops/#pas-ops-004), [PAS-OPS-001](https://docs.proappstore.online/standard/ops/#pas-ops-001).
**Remediate:** stage 8 (or 3) — restore the template's `ci.yml` and `compliance.yml`; add the gates; bump the CLI.
**Prove:** CI runs all four gates on the stage commit and is green.

## 5. Old UI/PWA baseline

**Detect:** `localStorage.getItem('fas:theme')` or another key in the boot script; a hand-rolled theme toggle; `user-scalable=no` or `maximum-scale` in the viewport meta; a PWA plugin without `registerType: 'autoUpdate'` or `navigateFallbackDenylist: [/^\/\.pas\//]`; runtime caching of `/.pas/*`; missing maskable icon; `pas check` failing `dark-mode`, `viewport-support`, `pwa-offline`, `pwa-manifest`, `pwa-maskable-icon`.
**Why:** the theme preference is shared across stores under one key; blocked zoom is an accessibility failure; a service worker caching `/.pas/*` serves one user's data to another and pins stale shells.
**Clause:** [PAS-UI-002](https://docs.proappstore.online/standard/ui/#pas-ui-002), [PAS-UI-007](https://docs.proappstore.online/standard/ui/#pas-ui-007), [PAS-UI-018](https://docs.proappstore.online/standard/ui/#pas-ui-018), [PAS-UI-020](https://docs.proappstore.online/standard/ui/#pas-ui-020), [PAS-UI-023](https://docs.proappstore.online/standard/ui/#pas-ui-023).
**Remediate:** stage 6 — fix the key (`stores-theme`), use `useTheme` / `ThemeToggle`, fix the viewport meta, restore the PWA settings, add the icons; leave the title, description and custom head alone.
**Prove:** the listed `pas check` checks pass; a person confirms the installed app updates and zooms.

## 6. Unpinned toolchain, stale SDK

**Detect:** no `engines.node` or below 22; `packageManager` missing; `pnpm-lock.yaml` absent; `@proappstore/sdk` below the catalogue requirement; `pnpm audit --prod` with high/critical findings.
**Why:** the deploy workflow and the SDK's platform-cookie, actions and monitoring surfaces assume the baseline; an old SDK lacks them.
**Clause:** [PAS-STACK-001](https://docs.proappstore.online/standard/stack/#pas-stack-001), [PAS-OPS-007](https://docs.proappstore.online/standard/ops/#pas-ops-007), [PAS-STACK-002](https://docs.proappstore.online/standard/stack/#pas-stack-002).
**Remediate:** stages 1 and 2 — pin engines and packageManager; commit the lockfile; bump the SDK range; adjust only the call sites `sdk_reference` shows changed.
**Prove:** `pnpm install --frozen-lockfile` and `pnpm typecheck` pass; the audit is clean.

## 7. Legacy data access

**Detect:** `app.db.migrate([...])` in app code; no `migrations.json`; `app.db.query` / `execute` in user paths; actions without explicit `requires_auth`; `list_app_tools` differing from `mcp.json`.
**Why:** schema must be applied by the deploy before actions register; raw SQL is team-only; an implicit `requires_auth` is a default the reviewer cannot see.
**Clause:** [PAS-DATA-002](https://docs.proappstore.online/standard/data/#pas-data-002), [PAS-DATA-003](https://docs.proappstore.online/standard/data/#pas-data-003), [PAS-DATA-004](https://docs.proappstore.online/standard/data/#pas-data-004).
**Remediate:** stage 5 — write `migrations.json` from the statements the app already ran (names in order, additive), remove the runtime call, make `requires_auth` explicit, move user-path SQL into actions; every edit shown for review.
**Prove:** `schema_status` shows the entries applied (or `already`); `list_app_tools` equals the file; negative tests pass.

## 8. Big-bang upgrade

**Detect:** one commit that bumps dependencies, replaces workflows, changes `initPro` and rewrites the PWA config together; "upgrade everything" without stages.
**Why:** a failed smoke cannot be attributed, and the revert takes the good changes with the bad.
**Clause:** [PAS-OPS-009](https://docs.proappstore.online/standard/ops/#pas-ops-009), [PAS-OPS-010](https://docs.proappstore.online/standard/ops/#pas-ops-010).
**Remediate:** split into the staged plan; one commit per stage; release and smoke each.
**Prove:** each stage has its own deploy run and smoke result; a stage revert leaves the others in place.

## 9. Template placeholders and boilerplate

**Detect:** `APPNAME` or template README text still present; `pas check` failing `no-placeholders`; a `CLAUDE.md` that is the platform boilerplate (`claude-md-slim`).
**Why:** placeholders leak into the manifest, the compliance workflow's package filter and the store listing.
**Clause:** [PAS-STACK-001](https://docs.proappstore.online/standard/stack/#pas-stack-001).
**Remediate:** replace the placeholders with the app id; trim `CLAUDE.md` to the app's own guidance — a reviewed, product-owned edit.
**Prove:** `pas check` passes `no-placeholders` and `claude-md-slim`.
