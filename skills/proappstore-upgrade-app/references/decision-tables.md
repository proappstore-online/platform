# Decision tables

Baseline values come from the platform, not from memory: the template
catalogue (`list_templates`), the canonical deploy workflow, the SDK, and the
current standard. Verify before quoting.

## File ownership — what may be re-synced, what is only advised on

| Path | Owner | Upgrade may | Never |
|---|---|---|---|
| `.github/workflows/deploy.yml` | template (canonical; kept byte-equal to the platform's generator) | replace with the canonical workflow after review | keep a hand-edited variant, add secrets |
| `.github/workflows/ci.yml`, `.github/workflows/compliance.yml` | template | restore or re-sync after review | delete a gate |
| `package.json` (root): `engines`, `packageManager`, `pnpm-workspace.yaml`, `tsconfig*.json`, `.gitignore`, `LICENSE` | template | bump / restore | change the app's name or scripts the product relies on |
| `web/vite.config.ts` PWA block (`registerType`, `navigateFallbackDenylist`, `globPatterns`) | template | restore the baseline settings | drop the customer's aliases, plugins or defines |
| `web/index.html`: theme boot script, viewport meta, PWA metas | template | fix the theme key, the viewport, the metas | touch the title, description, OG image, custom head |
| `web/package.json` | shared | bump `@proappstore/sdk`, framework versions | remove a dependency the product uses |
| `web/src/**` (App, components, hooks, styles) | **product** | propose a minimal diff (e.g. the `initPro` options, a storage line removed) | replace with the template's `App.tsx`; reformat; restructure |
| `mcp.json`, `migrations.json` | **product** | propose additive edits (`requires_auth` made explicit, a migration appended) | rewrite statements; edit an applied migration; delete an action |
| `README.md`, `CLAUDE.md`, `web/public/**` | **product** | suggest sections | overwrite |

## Baseline comparison

| Area | Current value from | Baseline from | Drift when | Clause |
|---|---|---|---|---|
| Node, pnpm, TypeScript project | root `package.json` `engines` / `packageManager`, `pnpm-lock.yaml` | catalogue `requires` (`node >=22`, `pnpm 10.x`) | engines missing or older; packageManager unpinned; lockfile missing | [PAS-STACK-001](https://docs.proappstore.online/standard/stack/#pas-stack-001), [PAS-OPS-007](https://docs.proappstore.online/standard/ops/#pas-ops-007) |
| SDK | `web/package.json` `@proappstore/sdk` | catalogue `requires` (`sdk >=1.16.0`) and `sdk_reference` | range below the requirement; SDK calls to removed or renamed surfaces | [PAS-STACK-002](https://docs.proappstore.online/standard/stack/#pas-stack-002) |
| CLI | `@proappstore/cli` in dev dependencies or global | catalogue `requires` (`cli >=2.6.0`) | below; `pas check` unavailable in CI | [PAS-OPS-004](https://docs.proappstore.online/standard/ops/#pas-ops-004) |
| Template revision | `app_info` provenance (`template_rev`), or the scaffold's shape | catalogue reviewed commit | older revision, or the *known deviations* not yet fixed | [PAS-STACK-001](https://docs.proappstore.online/standard/stack/#pas-stack-001) |
| Deploy workflow | `.github/workflows/deploy.yml` | the canonical workflow (*Build* → *Apply D1 migrations* → *Mint deploy credentials* → *Upload to R2* → *Register app tools* → *Run E2E against the live app*) | any step missing; stored tokens; a different trigger | [PAS-STACK-005](https://docs.proappstore.online/standard/stack/#pas-stack-005), [PAS-OPS-005](https://docs.proappstore.online/standard/ops/#pas-ops-005) |
| CI and compliance workflows | `ci.yml`, `compliance.yml` | the template's: frozen lockfile, typecheck, tests, `pas check`; the compliance checks | missing, disabled, or a gate removed | [PAS-OPS-004](https://docs.proappstore.online/standard/ops/#pas-ops-004), [PAS-OPS-001](https://docs.proappstore.online/standard/ops/#pas-ops-001) |
| Repository secrets | `gh secret list` | none (an e2e fixture session at most) | any Cloudflare, R2 or platform token | [PAS-OPS-006](https://docs.proappstore.online/standard/ops/#pas-ops-006) |
| Session mode | the `initPro` call | `authMode: 'platform-cookie'` on hosted apps | omitted (defaults to `legacy-bearer`) or explicit `legacy-bearer`; session code in storage; `app.auth.token` use | [PAS-AUTH-001](https://docs.proappstore.online/standard/auth/#pas-auth-001), [PAS-AUTH-002](https://docs.proappstore.online/standard/auth/#pas-auth-002), [PAS-STACK-003](https://docs.proappstore.online/standard/stack/#pas-stack-003) |
| Custom domains | `app_info` hostnames | registered and verified with `pas domain` | a hostname the app special-cases | [PAS-AUTH-011](https://docs.proappstore.online/standard/auth/#pas-auth-011) |
| Schema | `migrations.json`; `schema_status` | additive entries applied by the deploy | `app.db.migrate` at runtime; no file; edited entries; failed rows | [PAS-DATA-002](https://docs.proappstore.online/standard/data/#pas-data-002), [PAS-STACK-008](https://docs.proappstore.online/standard/stack/#pas-stack-008) |
| Registered actions | `mcp.json`; `list_app_tools` | every user-facing read/write an action with explicit `requires_auth`, declared params, scoping | `app.db.*` in user paths; `requires_auth` missing; drift between file and server | [PAS-DATA-003](https://docs.proappstore.online/standard/data/#pas-data-003), [PAS-DATA-004](https://docs.proappstore.online/standard/data/#pas-data-004) |
| Theme | `web/index.html` boot script; `useTheme` / `ThemeToggle` use | `localStorage['stores-theme']` and `data-theme` | `fas:theme` or another key; a hand-rolled toggle | [PAS-UI-002](https://docs.proappstore.online/standard/ui/#pas-ui-002) |
| Viewport and zoom | `web/index.html` viewport meta | no `user-scalable=no`, no `maximum-scale` | either present | [PAS-UI-007](https://docs.proappstore.online/standard/ui/#pas-ui-007), [PAS-UI-008](https://docs.proappstore.online/standard/ui/#pas-ui-008) |
| Service worker | `web/vite.config.ts` PWA plugin | `registerType: 'autoUpdate'`, `navigateFallbackDenylist: [/^\/\.pas\//]`, precache build output only | runtime caching of `/.pas/*` or data; no autoUpdate | [PAS-UI-018](https://docs.proappstore.online/standard/ui/#pas-ui-018) |
| Installability | manifest, icons, install metas | the template's manifest and `pwa-manifest` / `pwa-maskable-icon` checks | missing icons or metas | [PAS-UI-020](https://docs.proappstore.online/standard/ui/#pas-ui-020) |
| Design tokens and shell | `web/src` styles; `ProShell` or `@proappstore/sdk/ui` | canonical tokens and brand fonts; `brand-tokens`, `brand-fonts`, `no-brand-overrides` checks | overrides of `--accent` etc.; a foreign UI kit | [PAS-UI-001](https://docs.proappstore.online/standard/ui/#pas-ui-001), [PAS-STACK-022](https://docs.proappstore.online/standard/stack/#pas-stack-022) |
| Placeholders | `pas check` `no-placeholders` | none | `APPNAME` or template text left | [PAS-STACK-001](https://docs.proappstore.online/standard/stack/#pas-stack-001) |
| MCP tools | `mcp.json` descriptions; `list_app_tools` | every action described for agents; the same manifest serves the app and MCP | actions without descriptions; a second agent API | [PAS-STACK-023](https://docs.proappstore.online/standard/stack/#pas-stack-023) |
| Tests | `pnpm typecheck`, `pnpm test`, e2e / QA flows | typecheck + unit + manifest negative tests + a smoke flow in CI | missing suites; no negative tests; no smoke | [PAS-OPS-001](https://docs.proappstore.online/standard/ops/#pas-ops-001), [PAS-OPS-002](https://docs.proappstore.online/standard/ops/#pas-ops-002), [PAS-OPS-010](https://docs.proappstore.online/standard/ops/#pas-ops-010) |
| Monitoring | `initPro` `monitoring` options | auto-capture on, build-stamped with `VITE_COMMIT_SHA` | disabled; no build stamp | [PAS-OPS-012](https://docs.proappstore.online/standard/ops/#pas-ops-012) |
| Standard version | the app's last audit / README | the current version (`1.6`) and its [changelog](https://docs.proappstore.online/standard/changelog/) | clauses added since the last audit not yet reviewed | [PAS-OPS-020](https://docs.proappstore.online/standard/ops/#pas-ops-020) |

## Staged plan — order, scope, proof, rollback

| # | Stage | Touches | Preserves | Proof | Rollback |
|---|---|---|---|---|---|
| 1 | Toolchain | root `package.json` engines / packageManager, `pnpm-lock.yaml`, `tsconfig*.json` | scripts, workspace layout | `pnpm install --frozen-lockfile`, `pnpm typecheck` | revert |
| 2 | SDK and CLI | `web/package.json` ranges; call sites only where `sdk_reference` shows a changed surface | all product code otherwise | typecheck, tests, `pas check` | revert |
| 3 | Workflows | `deploy.yml` → canonical; `ci.yml`, `compliance.yml` restored; secrets removed by the user | nothing product-owned | a green deploy with the three log lines; `gh secret list` clean | revert (the previous workflow still deploys) |
| 4 | Platform-cookie | the `initPro` options; removal of storage / token / `/v1/auth` code; custom domains verified | the rest of the auth UI | sign-in per hostname (human), `app.auth.usesPlatformCookie`, no session in storage | revert; sessions re-establish on next sign-in |
| 5 | Data layer | `migrations.json` created from the live schema or appended; `mcp.json` `requires_auth` explicit; runtime `app.db.migrate` removed | statements and action names | `schema_status` applied; `list_app_tools` equals the file; negative tests | revert code; schema is additive and stays |
| 6 | UI / PWA | theme key, viewport, PWA plugin settings, manifest and icons | title, description, custom head, styles | `pas check` `dark-mode`, `viewport-support`, `pwa-offline`, `pwa-manifest`; a person on the installed app | revert |
| 7 | MCP tools | `mcp.json` descriptions and params (additive) | SQL | `list_app_tools` shows the descriptions | revert |
| 8 | Tests | `ci.yml` gates, negative tests, a smoke flow | existing tests | CI green; `qa_list_runs` passing | revert |

Each stage is one commit, released with `proappstore-publish-deploy`, and
independent of the others. Stage 4 needs the app's hostnames registered
first ([PAS-AUTH-011](https://docs.proappstore.online/standard/auth/#pas-auth-011)); stage 5 needs
`schema_status` clean.

## Dry-run report versus bounded implementation

| Mode | Default | Writes | Output | Stops for |
|---|---|---|---|---|
| Dry-run report | yes | nothing | inventory, comparison, staged plan, risks | — |
| Bounded implementation | on explicit choice of one stage | that stage's files only; product-owned files by shown, minimal diff | the stage commit + updated report | any destructive or broad change; any product-owned diff |
