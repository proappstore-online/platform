# @proappstore/agent-teams

A team of AI agents that builds and maintains a PAS app. A founder chats with a
**PO**; the PO turns intent into tickets; **BA → Dev → QA** execute them
autonomously and ship code to the app's GitHub repo. One Durable Object per
project holds the backlog, the working tree, memory, and the live connection.

**Status:** live. Deployed via GitHub Actions (`deploy-agent-teams.yml`) to
`agents.proappstore.online`. Console UI: `console.proappstore.online` (the per-app
**Agents** tab).

> The original design doc (gstack, May 2026) is historical — this README reflects
> what's shipped. Trust the code + this file over the doc for contracts.

## The agents

| Agent | Runs | Does |
|---|---|---|
| **PO** (Product Owner) | the **chat** panel | Talks to the founder. Answers questions by reading the actual code (read-only tools) and project memory; records decisions (`remember`); turns requests into tickets. Does not write app code. |
| **BA** (Business Analyst) | per ticket | Turns a ticket into a spec with acceptance criteria; rejects vague tickets. |
| **Dev** (Developer) | per ticket | Implements the spec with the PAS SDK; writes files (`batch_write_files`), deploys (`provision_app`). |
| **QA** | per ticket | Verifies the spec against the real code; PASS → done, FAIL → back to Dev. |

**Ticket lifecycle:** `inbox → ba-refining → awaiting-approval → ready →
dev-active → qa-active → (qa-failed → dev-active …) → done`. `needs-input` when an
agent is blocked (answer in chat or press Play to retry). Dev↔QA loop caps at 5
iterations.

## Architecture

```
Browser ──WS (hibernation) + poll fallback──► ProjectDO (one per project)
                                              │  SQLite: tickets, messages, chat,
                                              │  role_configs, project_memory,
                                              │  project_files (working-tree CACHE),
                                              │  activity_log, cost_ledger
                                              │
                                              ├─ AgentRuntime adapter
                                              │   ├─ CFNativeRuntime (Anthropic Messages, streamed)
                                              │   └─ OpenAIResponsesRuntime (OpenAI Responses)
                                              ├─ spine file tools (read/write/search/...)
                                              └─ ADMIN service binding
                                                   ├─ /api/agent-deploy  (repo create + push)
                                                   └─ /api/repo-pull     (sync FROM GitHub)
BYO API keys ◄─ PAS backend key vault (/keys/resolve, INTERNAL_TOKEN)
```

### GitHub is the source of truth
`project_files` in the DO is a **cache**, not a second authority. Before every run
and PO chat, `syncFromGitHub()` checks GitHub's latest commit SHA against the
last-synced SHA and **pulls only when GitHub moved** (so unpushed mid-ticket work
isn't clobbered). Dev's writes push back via `provision_app` as one commit.
Manual refresh: `POST /v1/projects/:slug/sync` (console: "Sync GitHub").

### Identity & memory (OpenClaw-adapted)
- **Persona ("soul")** per role — directive/boundaries/vibe, prepended to the
  system prompt each run. Seeded defaults; editable (`role_configs.persona`).
- **Project memory** (`project_memory`) — durable decisions/facts, upserted by
  key. The PO writes via the `remember` tool; injected as ground truth into the PO
  chat **and** every BA/Dev/QA run.

### Runtime (both adapters run our own loop, BYO key)
Streamed Anthropic calls (no 524s), transient retry, truncation recovery,
per-role `max_tokens`, and prompt caching. Details + the
managed-agents-vs-BYO rationale: `docs/agent-teams-runtime-and-billing.md`.

## Safeguards

| Guard | Where |
|---|---|
| Monthly **cost cap** per project (default $50, auto-pause + fail) | `storeMessage`/`autoAdvance` |
| **Rate limit**: 20 chat msgs/min/project; **25 projects/account** | DO / create route |
| **File caps**: 512KB/file, 300 files, 12MB tree | `spine.ts` |
| Run caps: 25 iters/run, wall-clock timeout, idle auto-pause | runtime / `autoAdvance` |

## Observability
Everything is written to `activity_log` (survives refresh). Tool calls record
their **output** in `meta` — the console makes each tool row clickable to inspect
exactly what `list_files`/`search_files`/`read_file` returned. Clearable:
`DELETE /chat/history`, `DELETE /activity`.

## API surface (`/v1/projects/:slug/...`, FAS bearer auth)

| Method | Path | Purpose |
|---|---|---|
| POST | `/v1/projects` | create (seeds team + first ticket); per-account quota |
| GET | `/v1/projects/:slug` | project state |
| POST | `.../play` · `.../pause` | run control |
| POST/GET/DELETE | `.../chat` · `.../chat/history` | PO chat |
| GET/POST | `.../tickets`; GET/PATCH/DELETE `.../tickets/:id` | backlog |
| GET/POST | `.../tickets/:id/messages` | ticket conversation |
| GET/PUT | `.../roles` | per-role model / max_tokens / persona |
| GET/POST/DELETE | `.../memory` | project memory |
| GET | `.../files` · `.../files/content?path=` | working-tree preview |
| POST | `.../sync` | pull latest from GitHub |
| GET/DELETE | `.../activity` | audit trail |
| GET (WS) | `.../ws?token=` | live updates (hibernation) |

## Build / deploy

```bash
pnpm build        # tsc --noEmit && esbuild → dist/worker.js
pnpm -w test      # vitest (from repo root): runtimes, spine, prompts, memory, …
```

Deploy via GitHub Actions only (no laptop deploys). Secrets/bindings:
`INTERNAL_TOKEN` (shared with backend + admin), `FAS_API_BASE`, `PROJECT` (DO),
`DB` (D1), `AGENT_STORAGE` (R2), `ADMIN` (service binding).

## Known production gaps
Tracked as issues in `proappstore-online/platform`. Notable: PAS Path B hosting
(escape the CF Pages cap), a build/lint gate before deploy, tool-dispatch
ownership scoping (#5), operator observability, account deletion.
