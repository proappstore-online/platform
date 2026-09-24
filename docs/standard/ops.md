# Testing, deployment, and operations

**Standard version 1.5** · Chapter `OPS` · Part of the [Application Standard](./index.md)

**Scope.** Testing, CI and OIDC deployment, rollback, logging and monitoring, privacy, dependency policy.

Clause IDs in this chapter have the form `PAS-OPS-<NNN>`; see the
[clause ID grammar](./governance.md#clause-id-grammar). Each clause follows the
[clause template](./governance.md#clause-template) and is audited under the
[audit model](./audit-model.md).

## The rule that governs this chapter

**A passing test suite is evidence for exactly what the tests assert — never
for production security.** Unit tests run against mocks; CI runs on a runner;
neither touches the host worker, the cookie mediation, the data worker's role
gates, the platform headers, or the deployed schema. An audit MUST cite tests
only under the clause whose assertion they implement, MUST cite deploy and
smoke evidence for what ran in production, and MUST leave the items only a
person can confirm as `manual-review` until a person confirms them. Every
clause below states its verification class for that reason.

## Verification class per clause

| Clause | Automated | Manual | Human-only |
|---|---|---|---|
| [001](#pas-ops-001) tests exist and run · [002](#pas-ops-002) negative tests · [004](#pas-ops-004) CI gates | CI result | coverage review | — |
| [003](#pas-ops-003) live flows · [010](#pas-ops-010) post-deploy smoke | browser run result | existence of the flows | custom domains, install |
| [005](#pas-ops-005) keyless deploy + evidence · [008](#pas-ops-008) forward-only schema | workflow, migration lint | evidence review | — |
| [006](#pas-ops-006) secrets · [007](#pas-ops-007) dependencies · [009](#pas-ops-009) rollback | *No .env.production*; OIDC exchange | everything else | — |
| [011](#pas-ops-011) log hygiene · [013](#pas-ops-013) rate limits · [018](#pas-ops-018) telemetry | platform redaction, quotas, *No tracking SDKs* | source review | — |
| [012](#pas-ops-012) monitoring · [014](#pas-ops-014) recovery · [015](#pas-ops-015) incident evidence · [016](#pas-ops-016) minimisation · [017](#pas-ops-017) retention and deletion | log pruning | all | — |
| [019](#pas-ops-019) operational checklist · [020](#pas-ops-020) evidence bundle | — | bundle completeness | the checklist |

## What the platform does, and does not, do for you

| Area | Platform provides | The app must add |
|---|---|---|
| Deploy | keyless OIDC workflow: schema → build → R2 → tool registration; health-gated platform deploys; drift guard on the workflow | nothing to the deploy steps; evidence capture ([005](#pas-ops-005)) |
| Tests | QA flows stored in platform D1, run headless after each deploy and every 15 min, observable at `/__qa/`, exportable to Playwright; `pas check` compliance | the flows or `e2e/`; unit and manifest tests; negative tests ([001](#pas-ops-001)–[004](#pas-ops-004)) |
| Secrets | `pas secret` vault + proxy; short-lived R2 credentials; scoped QA keys (30-day) instead of owner tokens | no repo/bundle secrets; e2e token hygiene ([006](#pas-ops-006)) |
| Logs | server-side failed-operation records (unspoofable), client capture via SDK, redaction at ingest, 30-day pruning, owner-only reads | no personal data in what it sends; build stamps; weekly review ([011](#pas-ops-011), [012](#pas-ops-012)) |
| Monitoring | signals and thresholds in the runbook; **no alerting yet** (#107) | the owner looking ([012](#pas-ops-012)) |
| Quotas | per-app and per-user limits on logs, proxy, sign-in, KV, rooms, uploads, actions | graceful 429/202 handling ([013](#pas-ops-013)) |
| Backups | R2 daily backups; D1 restore by platform support only; **no app-facing restore** | export/import actions, soft deletes, a written recovery path ([014](#pas-ops-014)) |
| Privacy | minimal first-party telemetry; cookieless analytics; log pruning; **no server-side account deletion** | minimisation, retention table, deletion action, disclosure ([016](#pas-ops-016)–[018](#pas-ops-018)) |

## Capability pages this chapter builds on

Clauses link to these as *Supporting links*; they describe what the platform
provides and are not restated here.

- [Monitoring runbook](../monitoring-runbook.md)
- [CLI overview](../cli-overview.md)
- [Publishing flow](../publishing-flow.md)
- [Build and deploy](../build-and-deploy.md)
- [Migration repair runbook](../migration-repair-runbook.md)
- [ADR-001 Cloudflare Workers only](../adr/001-cloudflare-workers-only.md), [ADR-007 Durable provisioning](../adr/007-durable-provisioning-workflow.md), [ADR-008 Error observability](../adr/008-error-observability.md)
- QA: `packages/qa-spec` (flow format), the `qa_*` MCP tools, and the observable runner at `https://<app>.proappstore.online/__qa/`

## Clauses

### PAS-OPS-001 — The repository carries typecheck, unit, manifest and end-to-end tests, and CI runs them {#pas-ops-001}

**Severity:** High · **Verification:** Automated (CI) — but see the rule: passing tests are never evidence of production security · **Enforcement:** none (recommended) · **Since:** 1.5

**Rule.** The app MUST have `pnpm typecheck` and `pnpm test` targets that run in CI on every push and pull request, MUST cover its own logic with unit tests, its `mcp.json` with manifest tests ([PAS-DATA-022](./data.md#pas-data-022)), and its main user flows with end-to-end tests that drive the deployed app (platform QA flows or a Playwright `e2e/` suite). A green test run MUST NOT be cited as evidence for any Security clause; it evidences only what the test asserts.

**Applicability.** All apps.

**Rationale.** The scaffold's `ci.yml` runs typecheck only, and its `test` script is another typecheck. An app that never grows a real suite has no regression protection, and an audit that reads "tests pass" as "secure" is the failure mode this chapter exists to prevent: unit tests run against mocks, not against the platform's authorization, cookies, headers or data worker.

**Recommended implementation.** Vitest in `web/` for logic and manifest tests; `e2e/` Playwright specs generated from platform QA flows (`GET …/qa/flows/:id/playwright`) or written directly; both wired into `ci.yml` and the deploy's `e2e` job.

**Conforming example.**

```yaml
# .github/workflows/ci.yml
      - run: pnpm install --frozen-lockfile
      - run: pnpm typecheck
      - run: pnpm test            # vitest: unit + mcp.json manifest tests
```

**Non-conforming example.**

```json
{ "scripts": { "test": "pnpm --filter @my-app/web exec tsc -b" } }   // "tests" that only typecheck
```

**Evidence.** Process: `ci.yml` steps; `package.json` `test` script; test files under `web/src` and `e2e/`; CI history on `main`.

**Remediation.** Add the suites; wire them; keep CI required.

**Tests.** CI runs typecheck, unit/manifest and e2e on the last commit to `main` and is green; the audit cites each test only for the clause it asserts.

**Supporting links.** [Publishing flow — testing](../publishing-flow.md#testing), [PAS-DATA-022](./data.md#pas-data-022), [PAS-OPS-010](#pas-ops-010).

### PAS-OPS-002 — Negative authorization and tenant-isolation tests exist for every scoped action and every role gate {#pas-ops-002}

**Severity:** Critical · **Verification:** Automated (CI) for the assertions; Manual review that every scoped action is covered · **Enforcement:** none (recommended) · **Since:** 1.5

**Rule.** For every action with a scoping predicate or an `auth.app_roles` gate, the suite MUST contain a test that calls it as a user outside the scope or without the role and asserts no rows / no changes / 403. Coverage MUST be complete — an auditor lists each scoped action and its negative test — and MUST be updated in the same change as `mcp.json`.

**Applicability.** Apps with registered actions.

**Rationale.** Registration proves `:__user_id` appears; only a negative test proves the predicate scopes. Positive tests alone pass an action that returns *everyone's* rows.

**Recommended implementation.** Manifest harness: apply `migrations.json` to in-memory SQLite, seed two tenants and two roles, run each statement with `:__user_id` bound per fixture. E2E: a second fixture account attempting the first's ids.

**Conforming example.**

```ts
for (const tool of scopedTools) it(`${tool.name} returns nothing for an outsider`, async () => {
  expect((await run(tool, foreignIds, { userId: OUTSIDER })).rows).toHaveLength(0) })
```

**Non-conforming example.**

```ts
it('list_tasks works', async () => { expect((await run('list_tasks', {}, { userId: OWNER })).rows.length).toBeGreaterThan(0) })   // positive only
```

**Evidence.** Process: a mapping of `mcp.json` tool → negative test (the audit produces it); test files; CI run.

**Remediation.** Write the missing negatives; add a test that fails if a tool has no negative.

**Tests.** Removing any scoping predicate or `app_roles` entry makes CI fail.

**Supporting links.** [PAS-DATA-007](./data.md#pas-data-007), [PAS-DATA-022](./data.md#pas-data-022), [PAS-AUTH-016](./auth.md#pas-auth-016).

### PAS-OPS-003 — Sign-in, sign-out, custom-domain, WebSocket and storage flows are exercised against the deployed app {#pas-ops-003}

**Severity:** High · **Verification:** Automated (browser) for the flows; Human for custom domains and install ([PAS-AUTH-020](./auth.md#pas-auth-020), [PAS-UI-023](./ui.md#pas-ui-023)) · **Enforcement:** none (recommended) · **Since:** 1.5

**Rule.** The app's end-to-end suite MUST cover, on the live URL: sign-in for each provider the app offers, one authenticated read, one write, sign-out, and — where used — a room connection (`app.rooms`) and a storage upload/download. Each custom domain MUST be covered by the same flows, by a person if not automatable. Flows MUST use the SDK's real sign-in path, never a test bypass.

**Applicability.** All hosted apps.

**Rationale.** These paths cross the host worker, cookie mediation, the data worker and Durable Objects; none of them exists in a unit test. Chess Academy's custom-domain and credential-mode failures were only visible by driving the deployed app.

**Recommended implementation.** Author flows as platform QA flows (`qa_save_flow` / `PUT …/qa/flows/:id`) so they run headless after every deploy and on the 15-minute cron, or as Playwright specs with a fixture session (`PAS_E2E_SESSION_TOKEN` today; keyless per #146 when shipped).

**Conforming example.**

```text
flow sign-in-and-create: goto / → click "Sign in with GitHub" → expectVisible label:"Profile menu" → fill label:"Title" "Smoke" → click text:"Add" → expectText "Smoke"
```

**Non-conforming example.**

```text
// e2e sets localStorage['pas:session'] to a fixture token to skip sign-in   ← bypasses the flow under test
```

**Evidence.** Process: flows in platform D1 (`qa_list_flows`) or `e2e/*.spec.ts`; latest run results (`qa_list_runs`, kb `.e2e/summary.json`); custom-domain checklist entries.

**Remediation.** Add the flows; run them after the next deploy; record custom-domain runs.

**Tests.** The latest post-deploy run of each flow passed on the live URL; the custom-domain checklist is complete.

**Supporting links.** [Monitoring runbook — signals](../monitoring-runbook.md#signals-where-failures-show-up), [PAS-OPS-010](#pas-ops-010), [PAS-AUTH-011](./auth.md#pas-auth-011).

### PAS-OPS-004 — CI gates every change: frozen lockfile, typecheck, tests, compliance {#pas-ops-004}

**Severity:** Medium · **Verification:** Automated (CI) · **Enforcement:** automated — `pas check` runs as the scaffold's `prebuild`; the platform re-runs compliance at publish (`412` on a hard failure) · **Since:** 1.5

**Rule.** `ci.yml` MUST run `pnpm install --frozen-lockfile`, `pnpm typecheck`, `pnpm test` and `pas check` on push and pull request; `main` MUST NOT be pushed with a red CI; the compliance workflow MUST stay in place. Optional gates (VCQA score) SHOULD be reviewed, not disabled.

**Applicability.** All apps.

**Rationale.** The deploy runs on every push to `main` with `--no-frozen-lockfile`; CI is the only place a lockfile drift, a type error or a compliance regression is caught *before* it ships.

**Recommended implementation.** Keep the scaffold's `ci.yml` and `compliance.yml`; add `pnpm test` and `npx @proappstore/cli check` steps; protect `main` if the org plan allows.

**Conforming example.**

```yaml
      - run: pnpm install --frozen-lockfile
      - run: pnpm typecheck
      - run: pnpm test
      - run: npx -y @proappstore/cli@latest check
```

**Non-conforming example.**

```yaml
      - run: pnpm install            # lockfile ignored
      # no test, no check
```

**Evidence.** Process: `.github/workflows/ci.yml` and `compliance.yml`; recent runs on `main`.

**Remediation.** Add the steps; fix what they surface.

**Tests.** The last five commits on `main` have green CI and compliance runs.

**Supporting links.** [CLI overview — check](../cli-overview.md#check), [Build and deploy](../build-and-deploy.md), [PAS-UI-022](./ui.md#pas-ui-022).

### PAS-OPS-005 — Deployment is the keyless workflow, and every deploy leaves the required evidence {#pas-ops-005}

**Severity:** High · **Verification:** Automated (workflow) + Manual (evidence review) · **Enforcement:** automated — `deploy.yml` (schema → build → OIDC credentials → R2 → tool registration); `template-workflow-drift` in the platform's CI keeps the scaffold's copy canonical · **Since:** 1.5

**Rule.** The app MUST deploy only through the scaffold's `deploy.yml` on push to `main`, authenticated by GitHub OIDC (no stored infrastructure secrets), and MUST retain for each production deploy: the workflow run URL, the commit SHA, the `Applied migration(s)` line (or `already`), the `Registered N app tool(s)` line, the `Deployed apps/<app> from <sha>` line, and the post-deploy QA/e2e result. An audit MUST NOT accept a deploy without this evidence.

**Applicability.** All hosted apps.

**Rationale.** The workflow's ordering (schema before code before actions) is what keeps the running app coherent; the log lines are the only proof that each step ran. A deploy by any other path is drift ([PAS-STACK-004](./stack.md#pas-stack-004)).

**Recommended implementation.** Never edit the deploy steps; add pre-build steps only. Pass `VITE_COMMIT_SHA` into `initPro({ monitoring: { build } })` so runtime logs carry the deployed SHA.

**Conforming example.**

```text
Applied migration(s): ["0007_tasks_status"]; already: ["0001_init", …]
Registered 41 app tool(s)
Deployed apps/my-app from 3f9c2e1
QA: 3/3 flows passed (trigger: deploy)
```

**Non-conforming example.**

```text
$ aws s3 sync web/dist s3://pas-apps/apps/my-app/ --endpoint-url …   # from a laptop, with a stored key
```

**Evidence.** Process: the run URL and log lines per deploy; `.github/workflows/deploy.yml` matches the canonical generator; `gh secret list` shows no `CLOUDFLARE_*`/`R2_*`.

**Remediation.** Restore the canonical workflow; delete stored infrastructure secrets; re-deploy and capture the evidence.

**Tests.** The last production deploy's evidence bundle is complete ([PAS-OPS-020](#pas-ops-020)).

**Supporting links.** [Build and deploy — current state](../build-and-deploy.md#current-state-what-runs-today), [Publishing flow — key properties](../publishing-flow.md#key-properties), [ADR-007](../adr/007-durable-provisioning-workflow.md), [PAS-STACK-005](./stack.md#pas-stack-005).

### PAS-OPS-006 — Secrets live in the platform vault or GitHub OIDC — never in the repo, the bundle, or long-lived repo secrets {#pas-ops-006}

**Severity:** Critical · **Verification:** Manual · **Enforcement:** automated — compliance check *No .env.production*; the deploy exchanges an OIDC token for short-lived, prefix-scoped R2 credentials · **Since:** 1.5

**Rule.** Third-party credentials MUST be stored with `pas secret set` and used through the proxy ([PAS-STACK-015](./stack.md#pas-stack-015)); `.env*` files MUST be git-ignored; the repository MUST hold no infrastructure token. The only repository secret an app MAY hold today is an e2e fixture session (`PAS_E2E_SESSION_TOKEN`), which MUST be a zero-permission account and MUST be rotated on a schedule until keyless e2e sessions (#146) replace it. Legacy `R2_*` repository secrets fanned out by the platform's reconcile job are inert on the keyless path and SHOULD be removed.

**Applicability.** All apps.

**Rationale.** Everything in the repo is readable by every collaborator and by anything that reads the repo; everything in the bundle is public. The keyless pipeline exists so that a leaked repository cannot deploy or read anything else.

**Recommended implementation.** `pas secret set NAME`; `pas proxy allow …`; `gh secret list` should show only the e2e token, if any.

**Conforming example.**

```text
$ gh secret list
PAS_E2E_SESSION_TOKEN   Updated 2026-09-01     # zero-permission fixture account, rotated quarterly
```

**Non-conforming example.**

```text
$ gh secret list
CLOUDFLARE_API_TOKEN    OPENAI_API_KEY    R2_SECRET_ACCESS_KEY
web/.env.production     (committed)
```

**Evidence.** Configuration: `.gitignore`; `git ls-files | grep -i env`; `gh secret list`; `pas secret list` (names only); bundle grep for key shapes.

**Remediation.** Move keys to `pas secret`; delete repo secrets and rotate the exposed values; add `.env*` to `.gitignore`.

**Tests.** `pas check` passes *No .env.production*; `gh secret list` shows nothing but the documented e2e token.

**Supporting links.** [CLI overview — commands](../cli-overview.md#commands), [PAS-STACK-015](./stack.md#pas-stack-015), [PAS-STACK-005](./stack.md#pas-stack-005).

### PAS-OPS-007 — Dependencies are pinned, audited, and updated on a cadence {#pas-ops-007}

**Severity:** Medium · **Verification:** Manual · **Enforcement:** none (recommended) — the platform configures no Dependabot/Renovate for app repos · **Since:** 1.5

**Rule.** `pnpm-lock.yaml` MUST be committed; the app SHOULD run `pnpm audit --prod` in CI (failing on high/critical) and SHOULD enable Dependabot or Renovate for weekly updates; a dependency with a known critical vulnerability MUST be updated or removed before the next deploy; new dependencies MUST respect [PAS-STACK-024](./stack.md#pas-stack-024) and [PAS-UI-022](./ui.md#pas-ui-022).

**Applicability.** All apps.

**Rationale.** The scaffold ships no vulnerability scanning, so an app that adds none ships whatever its lockfile froze. The bundle is the attack surface a user downloads.

**Recommended implementation.** Add `.github/dependabot.yml` (npm, weekly, `web/`); add `pnpm audit --prod --audit-level=high` to `ci.yml`; triage results in issues.

**Conforming example.**

```yaml
# .github/dependabot.yml
version: 2
updates:
  - package-ecosystem: npm
    directory: "/web"
    schedule: { interval: weekly }
```

**Non-conforming example.**

```text
pnpm-lock.yaml in .gitignore; last dependency update 14 months ago; no audit step
```

**Evidence.** Configuration: lockfile committed; `dependabot.yml`/`renovate.json`; `ci.yml` audit step; open Dependabot PRs.

**Remediation.** Commit the lockfile; add the config and the audit step; update.

**Tests.** `pnpm audit --prod --audit-level=high` exits 0 on `main`.

**Supporting links.** [PAS-STACK-024](./stack.md#pas-stack-024), [PAS-UI-022](./ui.md#pas-ui-022).

### PAS-OPS-008 — Schema changes are forward-only, applied by the deploy, and never rolled back by editing history {#pas-ops-008}

**Severity:** High · **Verification:** Automated (migration lint) + Manual · **Enforcement:** automated — `POST /v1/apps/:id/migrate/oidc` rejects non-additive statements; `_migrations` is idempotent by name; schema coherence blocks registration on missing columns · **Since:** 1.5

**Rule.** Schema MUST change only by appending to `migrations.json` ([PAS-DATA-002](./data.md#pas-data-002)). A bad migration MUST be corrected by a new migration, never by editing or deleting the applied one; a failed migration step fails the deploy and MUST be investigated via `GET /v1/apps/:id/schema-status` (or the `schema_status` MCP tool) before re-pushing. The app MUST NOT run `app.db.migrate` against production as a repair path.

**Applicability.** Apps with a D1 schema.

**Rationale.** There is no schema rollback: the lint forbids `DROP`/`RENAME`, and applied names are skipped forever. The repair runbook exists because editing an applied entry silently does nothing.

**Recommended implementation.** Expand/contract; fix forward with `000N_fix_…`; read `schema-status` after each schema deploy.

**Conforming example.**

```json
{ "name": "0008_tasks_status_default", "sql": "ALTER TABLE tasks ADD COLUMN status2 TEXT NOT NULL DEFAULT 'open'" }
// (then migrate data through an action; stop reading the old column)
```

**Non-conforming example.**

```text
git revert <the migration commit>; git push      # the applied migration stays applied; the actions now reference a column the file no longer declares
```

**Evidence.** Configuration: `migrations.json` history; Runtime: `schema-status` audit rows; deploy logs for the migration step.

**Remediation.** Append the corrective migration; follow the repair runbook.

**Tests.** `schema-status` shows `applied` for the latest entry and no `failed` rows.

**Supporting links.** [Migration repair runbook](../migration-repair-runbook.md), [PAS-DATA-002](./data.md#pas-data-002).

### PAS-OPS-009 — Code rollback is a revert on `main`, verified like any deploy {#pas-ops-009}

**Severity:** Medium · **Verification:** Manual · **Enforcement:** none (recommended) · **Since:** 1.5

**Rule.** To roll back the frontend the app MUST `git revert` (or push a known-good commit) to `main` and let the deploy replace the R2 prefix; it MUST NOT copy old assets into R2 by hand or point the host at anything else. A rollback MUST be verified with the post-deploy smoke ([PAS-OPS-010](#pas-ops-010)) and MUST account for schema: a revert cannot remove a column, so the reverted code MUST still be compatible with the current schema (which additive migrations guarantee if [PAS-OPS-008](#pas-ops-008) was followed).

**Applicability.** All hosted apps.

**Rationale.** `aws s3 sync --delete` on deploy makes `main` the sole source of what is served; anything else is drift the next push erases. Additive-only schema is what makes an old frontend safe to bring back.

**Recommended implementation.** Keep `main` always deployable; tag releases; revert with a commit message citing the incident.

**Conforming example.**

```text
git revert 3f9c2e1 -m "rollback: task list blank after 3f9c2e1 (incident #42)" && git push
→ Deployed apps/my-app from 8b1d0aa; QA 3/3 passed
```

**Non-conforming example.**

```text
aws s3 cp ./old-dist s3://pas-apps/apps/my-app/ --recursive   # bypasses the workflow; erased on next push
```

**Evidence.** Process: the revert commit and its deploy run; smoke result; Runtime: the served build's SHA (`monitoring.build` in logs).

**Remediation.** Revert properly; re-run smoke.

**Tests.** After a rollback the live app serves the reverted SHA and the smoke flows pass.

**Supporting links.** [Build and deploy](../build-and-deploy.md), [PAS-OPS-005](#pas-ops-005).

### PAS-OPS-010 — Every deploy is followed by a smoke test against the live URL {#pas-ops-010}

**Severity:** High · **Verification:** Automated (browser) — the smoke's *result* is evidence; its *existence* is checked manually · **Enforcement:** automated — the deploy can nudge platform QA (`POST …/qa/runs {trigger:"deploy"}` via OIDC) and runs the optional `e2e/` job after upload · **Since:** 1.5

**Rule.** The app MUST have at least one smoke flow that runs automatically after each deploy against `https://<app>.proappstore.online`: load, sign in, one read, one write, sign out. The deploy MUST be treated as failed until the smoke passes, and two consecutive smoke failures MUST be investigated as an incident ([PAS-OPS-015](#pas-ops-015)).

**Applicability.** All hosted apps.

**Rationale.** The deploy workflow proves assets uploaded; only a request to the live app proves the app works — with the real host, cookie mediation, data worker and schema. The runbook's threshold is two consecutive failed post-deploy QA runs.

**Recommended implementation.** Platform QA flows (zero code in the repo; headless after each deploy and every 15 min) or an `e2e/` Playwright directory, which the deploy runs automatically.

**Conforming example.**

```text
qa_save_flow smoke-1: goto / → expectVisible text:"Sign in" → … → expectText "Saved"
deploy.yml → POST /v1/apps/my-app/qa/runs { trigger: "deploy" }  (OIDC)  → qa_list_runs: passed
```

**Non-conforming example.**

```text
deploy green; nobody opens the app; first user reports the blank screen
```

**Evidence.** Process: flows (`qa_list_flows`) or `e2e/`; the last runs (`qa_list_runs`, `.e2e/summary.json`); the deploy log's QA/e2e job.

**Remediation.** Add the smoke flow; wire the trigger.

**Tests.** The latest deploy has a passing smoke run recorded within minutes of upload.

**Supporting links.** [Monitoring runbook — thresholds](../monitoring-runbook.md#thresholds-starting-points-tune-per-app), [PAS-OPS-003](#pas-ops-003).

### PAS-OPS-011 — Logs carry no credentials and no personal data {#pas-ops-011}

**Severity:** Critical · **Verification:** Manual (source review) — platform redaction is defence in depth, not the control · **Enforcement:** automated — the platform's ingest scrubs `Bearer …`, `password/secret/token/api_key/authorization/cookie/client_secret` values, JWTs, e-mail addresses and ≥32-hex strings from message, data and build fields · **Since:** 1.5

**Rule.** The app MUST NOT pass tokens, passwords, cookies, secrets, e-mail addresses, names, message bodies or other personal data to `app.logs` (message or `data`) or to `console.*` in production, and MUST NOT log request or action parameters wholesale. Log identifiers (user id, row id, action name, status, route) only. The platform's redaction MUST NOT be relied on as the reason a field is safe to log.

**Applicability.** All apps.

**Rationale.** App logs are readable by the app's whole team for 30 days and are a support artefact; a logged bearer is a session for the life of the token, a logged e-mail is a personal-data record with its own obligations. The redactor catches shapes, not intent.

**Recommended implementation.** `app.logs.error('save', 'save failed', { id, status })` — never `{ params }`, never `String(user)`. Strip `console.log` from production builds or keep them to identifiers.

**Conforming example.**

```ts
app.logs.warn('invite', 'redeem failed', { inviteId, status: res.status })
```

**Non-conforming example.**

```ts
app.logs.error('auth', `login failed for ${email} with ${password}`)
app.logs.info('action', 'create_task', { params })            // whole payload
```

**Evidence.** Source: `app.logs.*` and `console.*` call sites and their arguments; Runtime: a sample of `GET /v1/apps/:id/logs` entries for personal data.

**Remediation.** Rewrite the calls to identifiers; purge offending rows via support if any shipped.

**Tests.** A grep of log calls shows no `email`, `password`, `token`, `params`, or user-content variables; the last 24 h of live logs contain none.

**Supporting links.** [ADR-008 — error observability](../adr/008-error-observability.md), [Monitoring runbook](../monitoring-runbook.md), [PAS-STACK-021](./stack.md#pas-stack-021).

### PAS-OPS-012 — Runtime monitoring is on, build-stamped, read by the owner, and error states are user-visible {#pas-ops-012}

**Severity:** Medium · **Verification:** Manual · **Enforcement:** none (recommended) — platform alerting (#107) is not built; monitoring is pull · **Since:** 1.5

**Rule.** The app MUST keep `app.logs` auto-capture on, MUST stamp entries with the deployed SHA (`monitoring.build`), and the owner MUST review `GET /v1/apps/:id/logs?level=error` (or the console) after each deploy and on a weekly cadence, applying the runbook thresholds. Every handled failure MUST both reach `app.logs` and render an error state ([PAS-UI-011](./ui.md#pas-ui-011)); the app MUST NOT swallow failures into success paths.

**Applicability.** All apps.

**Rationale.** Until the alerting cron ships, nobody is notified: an app can fail for every user for days if the owner does not look. Server-side failed operations are recorded automatically; client-side throws only reach the platform if capture is on.

**Recommended implementation.** `initPro({ monitoring: { build: { sha: import.meta.env.VITE_COMMIT_SHA } } })`; a weekly owner check; the runbook's triage order (scope → app-or-platform → blast radius → recent change).

**Conforming example.**

```ts
export const app = initPro({ appId: 'my-app', authMode: 'platform-cookie', monitoring: { build: { sha: import.meta.env.VITE_COMMIT_SHA } } })
```

**Non-conforming example.**

```ts
initPro({ appId: 'my-app', monitoring: { auto: false } })    // no capture, no build stamp, no review
```

**Evidence.** Source: `initPro` options; Runtime: recent log entries carry `build.sha`; Process: evidence of owner review (issue, note, or the console's last-viewed).

**Remediation.** Turn capture on; add the build stamp; schedule the review.

**Tests.** Entries in the last 24 h carry the current SHA; the owner can show the last review.

**Supporting links.** [Monitoring runbook — triage](../monitoring-runbook.md#triage-an-app-is-failing), [SDK overview — monitoring](../sdk-overview.md#monitoring), [ADR-008](../adr/008-error-observability.md).

### PAS-OPS-013 — Platform rate limits and quotas are respected: back off, never retry-storm {#pas-ops-013}

**Severity:** Medium · **Verification:** Manual · **Enforcement:** automated — platform limits: app logs 50 000 entries/day and 200/s burst per app (over-budget answers 202 and the SDK backs off 60 s); proxy 10 000 requests/day per app and 1 000 per user; credential sign-in 10 failures/15 min per login; license validation 10/min per caller; KV 1 MB and 100 keys per user; rooms 32 peers/room (no per-app room cap), 100 msg/s, 4 KB; uploads 50 MB; 500 actions/app; 5 secrets and 5 proxy rules per app · **Since:** 1.5

**Rule.** The app MUST handle 429/413/202 responses as terminal for the current attempt — show the state, do not loop — and MUST size its own usage under the platform quotas. It MUST NOT implement blind retry loops around actions, proxy calls or logs, and MUST NOT disable the SDK's cooldown. Where an app legitimately needs more than a quota it MUST file a platform request, not shard around it.

**Applicability.** All apps.

**Rationale.** Quotas exist because the realistic flood is an app in an error loop, not an attacker. A retry loop on a 429 is that loop.

**Recommended implementation.** Surface "try again later" states; use `meta.changes` and idempotent ids instead of retries ([PAS-DATA-018](./data.md#pas-data-018)); batch log calls (the SDK already does).

**Conforming example.**

```ts
try { await app.proxy.fetch(url) } catch (e) { if (String(e).includes('429')) setState({ kind: 'rate-limited' }); else throw e }
```

**Non-conforming example.**

```ts
while (true) { const r = await app.actions.call('sync'); if (r.ok) break }          // storms on every failure
```

**Evidence.** Source: retry loops; error handling for 429/202; Runtime: the app's daily proxy/log counts against the caps.

**Remediation.** Remove loops; add states; request a quota change if needed.

**Tests.** Simulated 429 from the proxy shows the rate-limited state once; log volume stays below the cap on a normal day.

**Supporting links.** [PAS-STACK-015](./stack.md#pas-stack-015), [PAS-DATA-018](./data.md#pas-data-018), [ADR-008 — ingestion limits](../adr/008-error-observability.md).

### PAS-OPS-014 — Recovery is designed for: exportable data, no single copies, and a written recovery path {#pas-ops-014}

**Severity:** High · **Verification:** Manual · **Enforcement:** none (recommended) — there is no app-facing backup or restore; R2 has platform daily backups ([ADR-001](../adr/001-cloudflare-workers-only.md)); D1 restore is a platform-support operation · **Since:** 1.5

**Rule.** Because no self-service backup or point-in-time restore exists for an app's D1 or storage, the app MUST (a) provide a scoped export action for each tenant's or user's data ([PAS-DATA-012](./data.md#pas-data-012)), (b) keep no data whose only copy is outside `app.storage`/D1 (no browser-only persistence of user work), (c) write a recovery section in its README naming what to export, how to re-import, and that D1 restore requires platform support, and (d) rehearse the export/import path once before launch. Destructive actions MUST be recoverable by design (soft delete or an audit row) rather than by restore.

**Applicability.** All apps that hold user data.

**Rationale.** An audit that cannot answer "how do you get the data back" has found an incident waiting. The platform's backups protect the platform; they are not an app feature the owner can invoke.

**Recommended implementation.** `export_my_data` (paginated, scoped) + a matching `import_*` batch action; soft-delete columns; the README section.

**Conforming example.**

```text
README → Recovery: run export_org_data per org (JSON, paginated); re-import with import_org_data (idempotent on id);
D1 point-in-time restore: contact platform support with the app id and timestamp; last rehearsal 2026-09-01.
```

**Non-conforming example.**

```text
Hard DELETEs everywhere; no export action; drafts kept only in localStorage; README says nothing about recovery
```

**Evidence.** Configuration: export/import actions in `mcp.json`; soft-delete columns in `migrations.json`; Documentation: the README recovery section and rehearsal date.

**Remediation.** Add the actions and the section; rehearse.

**Tests.** Export → wipe a test tenant → import restores it; the README section exists and is dated.

**Supporting links.** [ADR-001](../adr/001-cloudflare-workers-only.md), [Migration repair runbook](../migration-repair-runbook.md), [PAS-DATA-012](./data.md#pas-data-012), [PAS-AUTH-019](./auth.md#pas-auth-019).

### PAS-OPS-015 — Incidents are evidenced from platform records, collected inside their retention windows {#pas-ops-015}

**Severity:** Medium · **Verification:** Manual · **Enforcement:** none (recommended) · **Since:** 1.5

**Rule.** When a smoke fails twice, the error-rate threshold is crossed, or a user reports data loss or unauthorised access, the app owner MUST open an incident record within the day that captures: the time window; `GET /v1/apps/:id/logs` entries by category with `build`; the deploy run URLs in the window; `schema-status`; the QA run artifacts (screenshots); affected users by id; and the fix commit. Collection MUST happen within the retention windows — app logs **30 days**, usage **90 days**, analytics **90 days** — after which the evidence is gone.

**Applicability.** All hosted apps.

**Rationale.** Server-side operation logs are unspoofable and complete but pruned daily after 30 days; Cloudflare Worker tails are platform-only and days-scale. Evidence not captured in time cannot be reconstructed.

**Recommended implementation.** An `incidents/` folder or issue label; a template with the fields above; link the fix.

**Conforming example.**

```text
incident-2026-09-24.md: window 09:10–09:40Z · logs: action/close_task 403 ×212 (build 3f9c2e1) · deploy run …/runs/181 · schema-status ok · QA run r_…/failed-step-3.png · users: 14 ids · fix: 8b1d0aa
```

**Non-conforming example.**

```text
"Something broke last month, we pushed a fix"   (no window, no logs, evidence pruned)
```

**Evidence.** Documentation: incident records; Process: their timestamps versus the retention windows.

**Remediation.** Create the template; back-fill what is still within retention.

**Tests.** The most recent incident record contains every field.

**Supporting links.** [Monitoring runbook — triage](../monitoring-runbook.md#triage-an-app-is-failing), [ADR-008](../adr/008-error-observability.md), [PAS-OPS-010](#pas-ops-010).

### PAS-OPS-016 — Only the data the feature needs is collected {#pas-ops-016}

**Severity:** High · **Verification:** Manual · **Enforcement:** none (recommended) · **Since:** 1.5

**Rule.** Each column, KV key, storage object, log field and analytics property MUST be traceable to a feature that reads it. The app MUST NOT collect precise location, device identifiers, contact lists, IP addresses, full user agents, or free-text about other people unless a feature requires it and the README says so; MUST NOT copy platform identity fields (e-mail, login) into its own tables when the platform user id suffices; and apps for children MUST collect nothing beyond what the platform's provisioned accounts already hold.

**Applicability.** All apps that store or send any data.

**Rationale.** Data you do not hold cannot leak, cannot be subpoenaed, and needs no retention policy. The platform's own telemetry is minimal by design (usage: app, user, day, visible seconds; analytics: no IP, no full UA, no full referrer; logs: rotating client id); an app should not add what the platform deliberately left out.

**Recommended implementation.** Review `migrations.json` column by column; use `:__user_id` as the only identity column; keep `props` on analytics events to non-identifying values.

**Conforming example.**

```text
tasks(id, org_id, user_id, title, status, created_at)                — every column read by an action
```

**Non-conforming example.**

```text
users_mirror(user_id, email, full_name, ip_last_seen, device_id, ua)   — nothing reads ip/device/ua; email duplicates the platform
```

**Evidence.** Configuration: `migrations.json` columns versus `mcp.json` reads; analytics `props`; storage paths; Documentation: the README data inventory.

**Remediation.** Drop the unused collection (stop writing; contract later); document what remains.

**Tests.** Every column is referenced by at least one action; the README inventory matches the schema.

**Supporting links.** [ADR-008 — third-party surface: none](../adr/008-error-observability.md), [PAS-OPS-017](#pas-ops-017), [PAS-AUTH-004](./auth.md#pas-auth-004).

### PAS-OPS-017 — Retention and deletion are defined, implemented in the app, and honest about the platform's limits {#pas-ops-017}

**Severity:** High · **Verification:** Manual · **Enforcement:** automated — the platform prunes app logs after 30 days and usage after 90 days · **Since:** 1.5

**Rule.** The README MUST state how long each class of app data is kept and how a user or tenant deletes it. The app MUST provide a deletion action (or batch) that removes the user's or tenant's rows and storage objects, gated and scoped like any write, and MUST NOT present the SDK's `deleteAccount()` as account deletion — it clears the user's KV keys and signs out; it does not delete platform identity or the app's D1 rows. Requests the app cannot fulfil (platform identity, analytics aggregates) MUST be routed to platform support and said so.

**Applicability.** All apps that store user data.

**Rationale.** A privacy promise the code cannot keep is a finding. Today no server-side account deletion exists on the platform; the honest statement is what the app can do, what the platform prunes, and what needs support.

**Recommended implementation.** `delete_my_data` batch: `DELETE … WHERE user_id = :__user_id` per table + storage cleanup via `app.storage.delete`; a README retention table; a support pointer for identity.

**Conforming example.**

```text
README → Data retention: tasks until you delete them or 24 months after last sign-in (sweep: reap_inactive); logs 30 d (platform);
Delete: Settings → "Delete my data" runs delete_my_data (D1 rows + files). Platform account: support@proappstore.online.
```

**Non-conforming example.**

```ts
<button onClick={deleteAccount}>Delete account</button>   // only clears KV + signs out; D1 rows remain
```

**Evidence.** Configuration: deletion action(s) in `mcp.json`; Source: what the delete UI calls; Documentation: the README retention table.

**Remediation.** Add the action and the table; fix the UI's claim.

**Tests.** Running the deletion for a test user leaves no rows or objects for that id; the README describes exactly that.

**Supporting links.** [PAS-OPS-016](#pas-ops-016), [PAS-DATA-009](./data.md#pas-data-009), [PAS-AUTH-019](./auth.md#pas-auth-019).

### PAS-OPS-018 — Telemetry is disclosed and limited to the platform's {#pas-ops-018}

**Severity:** Medium · **Verification:** Manual · **Enforcement:** automated — compliance check *No tracking SDKs* · **Since:** 1.5

**Rule.** The app MUST disclose, in its README or privacy notice, the platform telemetry it participates in — usage heartbeats (`app.usage`, visible seconds per user per day, drives creator payouts), runtime error logs (`app.logs`, with a rotating per-install client id), and cookieless visitor analytics — and any additional telemetry it adds. It MUST NOT add third-party trackers, and MUST NOT disable usage or monitoring telemetry without stating why (disabling usage also removes the app from payout attribution).

**Applicability.** All apps.

**Rationale.** Users can only consent to what is disclosed; the platform's telemetry is minimal and first-party, which is the reason trackers are banned.

**Recommended implementation.** A short *Telemetry* section in the README; leave the SDK defaults on.

**Conforming example.**

```text
README → Telemetry: platform usage heartbeat (visible time), runtime error logs (no personal data), cookieless page analytics. No other telemetry.
```

**Non-conforming example.**

```text
<script src="https://www.googletagmanager.com/gtag/js?id=G-…">   (compliance fail)   + README silent
```

**Evidence.** Documentation: README telemetry section; Source: `initPro` `usage`/`monitoring` options; `pas check` *No tracking SDKs*.

**Remediation.** Write the section; remove trackers; restore defaults.

**Tests.** `pas check` passes; the README section matches the `initPro` options.

**Supporting links.** [PAS-STACK-021](./stack.md#pas-stack-021), [PAS-UI-022](./ui.md#pas-ui-022).

### PAS-OPS-019 — Production is verified by a person: the operational checklist {#pas-ops-019}

**Severity:** High · **Verification:** Human · **Enforcement:** none (recommended) · **Since:** 1.5

**Rule.** Before an audit closes, a person MUST complete the checklist below on the deployed app and record it. An AI auditor records this clause as `manual-review`; it MUST NOT mark it `pass`, and MUST NOT treat any green CI, unit or smoke run as satisfying it.

**Applicability.** All hosted apps.

**Rationale.** Deploy evidence, smoke runs and unit tests prove that specific assertions held; they do not prove that the running system is secure or recoverable. The items below are the ones only a person with the owner's access can confirm.

**Recommended implementation.** Run the list quarterly and after any change to auth, schema, secrets or the deploy workflow.

**Conforming example.**

```text
[ ] Deploy evidence bundle for the last deploy is complete (PAS-OPS-020)
[ ] gh secret list shows no infrastructure tokens; pas secret list matches the README
[ ] Sign-in per provider, sign-out, and (if any) custom domain, rooms, upload/download — on the live URL
[ ] Post-deploy smoke ran and passed; qa_list_runs shows no 2-in-a-row failures
[ ] Owner has reviewed error logs this week; entries carry the current build SHA
[ ] Export → import rehearsal done in the last 6 months; README recovery + retention sections current
[ ] Deletion action run for a test user leaves nothing behind
[ ] pnpm audit --prod clean; Dependabot PRs triaged
[ ] Last incident record (if any) has every field
```

**Non-conforming example.**

```text
AI report: PAS-OPS-019 pass (CI green, 212 tests)      ← not allowed: Human verification
```

**Evidence.** Runtime + Process: the completed checklist with date, operator and links.

**Remediation.** Complete the checklist; file findings per line.

**Tests.** Every line passed or has a linked finding.

**Supporting links.** [Audit model — verification classes](./audit-model.md#verification-classes), [PAS-AUTH-020](./auth.md#pas-auth-020), [PAS-UI-023](./ui.md#pas-ui-023).

### PAS-OPS-020 — An audit is accompanied by the deployment evidence bundle {#pas-ops-020}

**Severity:** Medium · **Verification:** Manual · **Enforcement:** none (recommended) · **Since:** 1.5

**Rule.** The audit report MUST attach, for the deploy under audit: the commit SHA and its CI run; the deploy run URL with the migration, tool-registration and upload lines; the smoke/QA run id and result; `schema-status`; the compliance (`pas check`) output; `gh secret list`; the served build's SHA as reported by `monitoring.build` in a fresh log entry; and the date and operator of the last human checklist ([PAS-OPS-019](#pas-ops-019)). A report without the bundle MUST be marked incomplete.

**Applicability.** All hosted apps.

**Rationale.** These artefacts are what let a second reader reproduce the audit's conclusions and are what an incident review will need; they are cheap to collect at audit time and impossible later ([PAS-OPS-015](#pas-ops-015)).

**Recommended implementation.** A fixed section at the top of the audit report, filled before any clause is evaluated.

**Conforming example.**

```text
Deploy under audit: 3f9c2e1 · CI …/runs/180 ✓ · Deploy …/runs/181 ✓ (migrations: 0007; tools: 41; upload ✓) · QA r_9d1 ✓ · schema-status: ok · pas check: 20/20 · gh secret list: PAS_E2E_SESSION_TOKEN · live build.sha: 3f9c2e1 · checklist: 2026-09-20 by @owner
```

**Non-conforming example.**

```text
"Audited main as of today"   (no SHA, no runs, no build correlation)
```

**Evidence.** Documentation: the bundle section in the audit report.

**Remediation.** Collect and attach.

**Tests.** Every field present and linked.

**Supporting links.** [PAS-OPS-005](#pas-ops-005), [PAS-OPS-010](#pas-ops-010), [Audit model — findings](./audit-model.md#findings).
