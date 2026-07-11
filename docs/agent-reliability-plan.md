# Agent Reliability Plan

Status: **live** — agents are serving real users. Every fix must be backward-compatible (no migration-gated features that break unmigrated DOs).

## The failure modes (observed in production)

| # | Failure | Root cause | Current fix | Remaining gap |
|---|---------|-----------|-------------|---------------|
| 1 | **Timeout** — "run exceeded 10 min" | Large tasks (i18n: 14 locale files) take >10 min | Configurable timeout (1-60m), error feedback on retry | Agent restarts from scratch on retry, re-reads everything |
| 2 | **Context overflow** — "Anthropic rejected: prompt too long" | Tool results (file reads/writes) balloon the conversation | `trimConversation()` at 150k tokens, Dev prudence rules | Silent trim — model doesn't know content was removed |
| 3 | **Stuck loop** — agent retries same failing approach | No error feedback to next run | Error stored as ticket message, surfaced in Dev prompt | Works for timeout/API errors; doesn't cover "agent chose a bad approach" |
| 4 | **Stale UI** — button shows Pause when agent is dead | No `agent-run-ended` event, staleness timer is 20s | Filed as issue #11 | Not yet implemented |
| 5 | **Deploy race** — concurrent pushes cause non-fast-forward | Multiple tickets deploying simultaneously | Retry with sync on conflict | Mostly fixed; rare edge case remains with 3+ concurrent deploys |
| 6 | **Deploy stuck forever** — tickets park in needs-input, never recover | Infra failure (missing R2 secrets / E2E fixture hang / no deploy.yml) → `infraFail` → 30-min idle auto-pause → waits for manual Play; the stuck message also mis-guessed the cause | **Self-healing recovery** (2026-07-06): bounded auto-retry against current state + backoff, honest diagnostic, escalate only when exhausted | LLM triage advisor (infra-vs-code) not yet built — see §"Deploy reliability & self-healing" |

## Plan: three phases

### Phase 1: Run checkpointing (highest impact, medium effort)

**Problem:** When a run times out or fails, the agent starts completely fresh. It re-reads every file it already read, re-generates code it already wrote. A 10-min run that was 80% done throws away all progress and does the same 80% again.

**Solution:** Checkpoint the agent's progress within a run using a lightweight `_AGENT_PLAN.md` file.

1. **At the start of each Dev run**, inject an instruction: "Before writing any code, create `_AGENT_PLAN.md` listing every file you plan to create/modify and its purpose. Check off items as you complete them."

2. **On retry**, the agent sees `_AGENT_PLAN.md` in its file list (already persisted by `saveFiles`). The prompt says: "You have a plan from a previous run. Read it. Skip completed items. Continue from where you left off."

3. **Files already written** are visible in the existing file list. Combined with the plan, the agent knows: "I already wrote 8 of 14 locale files — continue from `el.json`."

**Implementation:**
- `prompts.ts`: Add plan-file instruction to Dev prompt
- `prompts.ts`: On retry (iterations > 0 OR prior system error), add "resume from plan" instruction
- `spine.ts`: No changes — `_AGENT_PLAN.md` is just a regular file the agent writes
- **No backend changes needed.** This is purely a prompt-level convention.

**Files to change:** `prompts.ts` only.

### Phase 2: Pre-flight estimation + auto-split (medium impact, medium effort)

**Problem:** The BA creates tickets that are too large for one Dev run. "Add i18n with 10 languages" becomes one ticket that requires 14 file writes, exceeding the timeout.

**Solution:** The BA estimates the work size and auto-splits large tickets.

1. **BA prompt update:** After producing the spec, estimate the number of files to create/modify. If >8 files, split into sub-tickets (e.g. "Add i18n framework + English" and "Add Chinese, Vietnamese, Arabic translations").

2. **Dev prompt update:** If the file list shows >30 source files, the Dev should work in passes: critical files first, then secondary files on the next iteration.

3. **Ticket iteration budget:** Instead of a hard 5-iteration cap, give feedback at iteration 3: "You've used 3 of 5 iterations. Focus on getting the core working — polish can be a follow-up ticket."

**Implementation:**
- `prompts.ts`: BA ticket-splitting heuristic
- `prompts.ts`: Dev multi-pass awareness
- `ticket-machine.ts`: Soft warning at iteration 3 (message, not hard stop)

### Phase 3: Smarter conversation management (medium impact, higher effort)

**Problem:** Even with trimming, the conversation within a single run can be inefficient. The agent reads 20 files (each becomes a tool_result in the conversation), then writes files, then the tool results from 3 turns ago are trimmed but the damage (wasted tokens) is already done.

**Solution:** Smarter tool result handling in the runtime.

1. **Streaming file reads:** Instead of returning full file content as tool_result, return a summary for files >2KB: first 50 lines + "... (truncated, 847 lines total)". The agent can re-read specific sections if needed.

2. **Write confirmation instead of echo:** `batch_write_files` currently returns the full content of written files as confirmation. Change to: "Wrote 5 files: src/a.tsx (142 lines), src/b.tsx (89 lines), ..." — the agent knows its own output.

3. **Context budget in the tool schemas:** Add a `_context_note` to tool descriptions: "You have ~150k tokens of context. Each file read uses ~{filesize/4} tokens. Be selective."

**Implementation:**
- `spine.ts`: Truncate `read_file` results for files >2KB (keep first 80 lines + size note)
- `spine.ts`: Change `batch_write_files` result from echo to summary
- `tool-schemas.ts`: Add context budget note to read_file/batch_write_files descriptions

### Phase 4: Observability + self-healing (lower priority, ongoing)

1. **`agent-run-ended` event** (issue #11): Emit when a run finishes (success or error). Console clears the working indicator immediately.

2. **Cost guard per-ticket:** If a single ticket has spent >$5, warn the user before starting another Dev iteration. The agent is probably stuck.

3. **Token counter in the runtime:** Track cumulative tokens within the run. If approaching 80% of model context, inject a system message: "Context budget warning: you've used 160k of 200k tokens. Finish your current task and stop reading files."

4. **Dead-run detection:** If no heartbeat for 60s during an active run, the watchdog should mark the ticket as needs-input rather than waiting for the full timeout.

## Implementation priority

| Phase | Impact | Effort | Status |
|-------|--------|--------|--------|
| 1 — Run checkpointing | High | Low (prompt only) | **SHIPPED** |
| 2 — BA auto-split | Medium | Low (prompt only) | **SHIPPED** |
| 3 — Smarter tool results | Medium | Medium (spine changes) | **SHIPPED** |
| 4 — Observability | Low-Med | Medium (runtime + console) | Partial (issue #11 open) |

## Architecture debt (from 2026-06-06 review)

| File | Lines | Issue | Priority |
|------|-------|-------|----------|
| project-do.ts | 1,713 | God file — 0 tests, 19 imports, mixed concerns | P1 |
| AppAgents.tsx | 1,182 | Still large after WS extraction — mixed state/UI/polling | P2 |
| po-chat.ts | 381 | Mixed prompt construction + orchestration + JSON parsing | P3 |
| openai-responses.ts | 301 | Stream/pricing/tools mixed (unlike cf-native which is split) | P3 |

### Refactoring plan for project-do.ts

Split into focused modules with dependency injection:
1. `project-do.ts` — DO class shell, init, HTTP dispatch (thin router)
2. `project-orchestrator.ts` — watchdog, auto-advance, play/pause, dispatch
3. `ticket-workflow.ts` — transition, fail, blockForInput, applyAgentOutcome
4. `project-docs-manager.ts` — project docs building, publishing, share links
5. `github-sync.ts` — syncFromGitHub, file persistence
6. Each module gets a `deps` interface → unit-testable without SqlStorage

## What's already shipped (done)

- [x] Configurable run timeout (1-60 min, board UI)
- [x] Context trimming at 150k tokens (auto, transparent)
- [x] Actual API error messages (not "Invalid request")
- [x] Run checkpointing via `_AGENT_PLAN.md` (Dev writes plan, resumes on retry)
- [x] BA auto-split (scope guard: >8 files = split into sub-tickets)
- [x] `read_file` truncation (>300 lines auto-truncated, offset/limit for ranges)
- [x] `search_files` → `read_file` workflow (line numbers enable targeted reads)
- [x] In-run context budget warning at 120k tokens (model told to wrap up)
- [x] Tool schema hints (batch_write_files preferred, read_file context cost)
- [x] Error feedback to retry runs (stored as ticket message, injected into prompt)
- [x] Dev prudence instructions (read less, batch writes, don't re-read)
- [x] Model/runtime selector on board header
- [x] Elapsed timer on active tickets
- [x] Resilient `max_run_minutes` read (survives unmigrated DOs)

---

# Deploy reliability & self-healing (2026-07-06 session)

A multi-day debugging cycle (interns app + a fresh `aipa-console`) exposed that
**deploy-stage** failures — not agent-run failures — were silently stranding tickets.
This section documents every finding and the plan, so the next person (or agent)
doesn't repeat the chase.

## Findings

### 1. Why tickets got stuck (root causes, in order)
1. **E2E fixture `networkidle` hang (platform bug).** The injected Playwright fixture
   (`packages/admin/src/e2e-harness.ts`) waited on `waitForLoadState('networkidle')`
   with no timeout. Apps are **PWAs** — the service worker precaches assets, so the
   network never goes idle → Playwright's 45s test timeout fires "while setting up app"
   → the `e2e` job fails → **Deploy to R2 red** → ticket bounced. Reproduced locally:
   old fixture times out at 45s, fixed fixture passes in ~1s.
2. **Missing per-repo R2 secrets (infra gap).** See §Secrets below — private app repos
   can't inherit org secrets on the free plan, and nothing set them per-repo, so the
   "Upload to R2" step got an empty `AWS_ACCESS_KEY_ID` → `Invalid endpoint:
   https://.r2.cloudflarestorage.com`.
3. **Provisioning race early on** — the first commits had no `deploy.yml` yet → no CI run.
4. **Misleading diagnostic.** The stuck message asserted "the admin GitHub token must
   have the `workflow` scope" — pure speculation, **wrong**, and it masked #1 and #2 for
   days. (`deploy-stage.ts` — now an honest message.)
5. **Human-gated recovery.** `infraFail` parked the ticket in `needs-input`; the DO
   auto-paused after 30 min idle (`project-do.ts autoAdvance`) → tickets sat until a
   human hit Play, even after the blocker was fixed out-of-band. This is the anti-pattern
   2026 durable-execution guidance says to eliminate.

### 2. Secrets architecture (the hard constraint)
- Store GitHub orgs are on the **free plan**; **app repos are private**. On free,
  **org-level Actions secrets do NOT reach private repos** (needs Team/Enterprise).
  So deploy creds (`R2_*`) **must be repo-level** on each app repo — the per-repo copies
  are the *required* mechanism, not drift.
- **Infra repos are public** (`platform`, `proappstore`) → they *can* read org secrets.
  This is why the fix (below) works: a workflow in the public `platform` repo reads the
  org-level R2 "hub" secret and fans it out to the private app repos.
- The org `R2_*` secret already held a valid value (set directly via `gh secret set --org`
  long ago) — private repos just couldn't inherit it.

### 3. Secrets tooling: OFF Doppler → SOPS
`~/dev/secrets` migrated from Doppler to **SOPS** (age-encrypted `secrets.enc.yaml`;
map = `inventory.yaml`, names only; master age key in Bitwarden + `~/.config/sops/age/`).
**No auto-sync** — push to each `consumers:` entry by hand (`sops -d --extract … | gh
secret set …`); **rotate-on-touch**. Never reference Doppler.

### 4. Identity / MCP
The proappstore MCP OAuth signed in as a **Google** account (`google:…`) distinct from
the **GitHub owner** (`gh:2824906`, `serge-ivo`) that owns the apps → "you don't own app"
errors. Added the **`whoami`** MCP tool so the authenticated identity is explicit.

### 5. Coordination architecture (best-practice review)
- Coordination is a **deterministic Durable Object** (tick/watchdog in `project-do.ts`),
  **not** an LLM. PO/BA/Dev/QA are workers; the DO orchestrates. This matches 2026 best
  practice (deterministic control flow + LLM judgment).
- The **PO is intake-only** — tools are `['list_files','read_file','search_files',
  'remember','create_ticket']` (`agents-catalog.ts`). It cannot see the board or act on
  other agents' tickets. **Do NOT make the PO a coordinator** — that moves orchestration
  into an LLM (anti-pattern). An LLM's right role in recovery is *diagnosis/advisor*, not
  dispatch.

## Shipped this session

- [x] **whoami** MCP tool (`packages/mcp/src/index.ts`)
- [x] CI-unblock: data-worker APP_ID authz tests + `template-seed` skip-when-absent
- [x] **E2E fixture**: wait for `#root` mount, not `networkidle` (`e2e-harness.ts` + interns repo)
- [x] `template-app` flagged `is_template=true`; `scaffold_app` 404 → actionable error
- [x] **`reconcile-app-secrets` workflow** — fans org R2 "hub" secret out to private app
      repos; admin `provisionApp` + `pas publish` dispatch it; hourly cron backstops
- [x] **Honest deploy-stuck diagnostic** — dropped the false "workflow scope" guess
- [x] **Self-healing deploy recovery** — bounded auto-retry (`MAX_DEPLOY_ATTEMPTS=3`) +
      backoff (2m, 5m), escalate when exhausted; `tickets.deploy_attempts` column; Play
      resets the budget (`deploy-stage.ts` + `project-do.ts reconcileStuck`)
- [x] Docs: `inventory.yaml` R2 → repo-level + SOPS; session memory

## Remaining implementation plan

| # | Item | Why | Where | Effort |
|---|------|-----|-------|--------|
| D1 | **Verify end-to-end** — resume interns, watch a ticket build → deploy → done + self-heal | Confirms the whole pipeline post-fix | MCP `set_project_running` or dashboard Play | trivial |
| D2 | **Guarantee the E2E harness exists** (or skip gracefully) | `aipa-console` had no `e2e/` dir → the `e2e` job hard-errors (`working directory '.../e2e': No such file or directory`) | provisioning always injects `e2eHarnessFiles`, **or** `deploy.yml` e2e job no-ops when `e2e/` absent | S |
| D3 | **LLM triage advisor for stuck tickets** | The deterministic self-heal blind-retries; an advisor can classify infra-vs-code and propose the fix (retry / notify / back-to-Dev), which the state machine executes — LLM proposes, machine disposes | new `triageStuck()` step gated behind self-heal exhaustion; read-only diagnosis → structured action | M |
| D4 | **Doppler → SOPS doc cleanup** | `pas/CLAUDE.md` (and maybe `stores/CLAUDE.md`) still say "Doppler is source of truth" | those `CLAUDE.md` files | S |
| D5 | **`project-do.ts` refactor** (pre-existing P1 debt) | Now larger after `reconcileStuck`; still 0 storage tests → self-heal is untestable in-repo | split per the "Refactoring plan" above + a DO storage test harness | L |

**Priority:** D1 now (validation) → D2 (prevents a whole class of born-broken apps) →
D4 (cheap, avoids repeating the Doppler chase) → D3 (polish) → D5 (debt, unlocks tests).

---

## Session 2 update (2026-07-06/07) — incident + deploy-churn deep dive

### PRODUCTION INCIDENT: profile gate locked out 62 interns
Tickets #3/#4/#7 gated the dashboard on a NEW `profile_completed_at` column that is null
for every pre-existing member → **62 of 72 interns force-locked** onto the profile form
(real user reports). It shipped **green** because QA writes only mocked-SDK vitest tests
and the E2E smoke checks "#root mounts" — no feature test. **A green deploy is not a working
feature.** Mitigated by backfilling `profile_completed_at`; the code fix was ticketed to the
agents (#9). Guardrails added so it can't recur:
- **BA prompt** — EXISTING-DATA GUARD: a spec that adds a gate/required field/new column
  MUST say how existing rows are handled and must not force-gate onboarded users.
- **QA prompt** — must add a test for the existing-record case (new field null), not just
  the happy path.

### Deploy churn root cause (why tickets sat in `deploying` forever)
The deploys **succeeded**, but the platform couldn't match the green run to the ticket:
1. **`deployResult` looked up the run in the 20 most-recent runs** → under churn the
   ticket's run fell out of the window → "no CI run" → re-push → worse. **Fixed:** query
   GitHub `?head_sha=<full-sha>` so the run is found regardless of recency.
2. **N tickets share ONE working tree** yet each full-deploys it → competing commits +
   `deploy.yml cancel-in-progress` cancels the losers. **Fixed:** `mark-siblings-done`
   (issue #29) — one green deploy completes the other in-flight/parked tickets; plus
   deploy **serialization** (one deploy at a time per project).

### Closed follow-up
- **#29 — batch/debounce deploys**: mark-siblings-done is the chosen cheap fix. A green
  deploy of the shared tree completes sibling `deploying` / deploy-infra parked tickets,
  so queued tickets do not redundantly full-deploy the same accumulated files.

### Also shipped this session
- [x] **`deployResult` finds the run by `?head_sha`** (was a 20-run recent window)
- [x] **#30 deploy grader treats Platform Compliance as advisory** — `deployResult` grades
      only the canonical deploy gate (`Deploy to R2` / `deploy.yml`), so a report-only
      compliance failure cannot strand a ticket whose deploy actually shipped.
- [x] **mark-siblings-done** — one green deploy completes sibling tickets sharing the tree
- [x] **Deploy serialization** — one deploy at a time per project (`runPendingAgents`)
- [x] **MCP connection-auth for loop tools** — `set_project_running`/`chat_agent`/etc. use
      the authenticated connection identity (optional `token`), so an owner session drives
      the whole loop over MCP with no pasted token
- [x] **`whoami` MCP tool** — surfaces the authenticated PAS identity (caught a Google-vs-
      GitHub account mismatch that blocked owner-scoped tools)
- [x] **Host CORS on `/.vcqa/`** — the console Code Health panel fetches the report
      cross-origin; the host served it without CORS → "Failed to fetch" platform-wide
- [x] **BA/QA existing-data guardrails** (see incident above)
- [x] Reconcile app secrets, inline-tree push (blob rate-limit), build-core deploy
      path-filters — see the git log

### Meta-lesson (do not forget)
"**Green deploy ≠ working feature.**" Verify the actual user flow (load it as the affected
user), not just HTTP 200 + a green CI run. The QA gate does not test features — that gap
(D-items + #30) is the throughline behind "ships green but broken" and "stuck deploying".
