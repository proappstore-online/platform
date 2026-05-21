# @proappstore/agent-teams

Linear-for-AI-agents inside PAS. PO drives a backlog; BA / Dev / QA agents
execute against it; output ships to the PAS marketplace.

**Status:** v0.1 scaffolding. Not deployed.

## Design

Source of truth:

```
~/.gstack/projects/serge-ivo-stores-workspace/serge-ivo-main-design-20260521-181709.md
```

The doc has been through `/office-hours` + 2 spec-review rounds +
`/plan-eng-review` + `/codex consult`. Read it before changing the data
model or interface contracts.

## Architecture (one-pager)

```
Browser ──WebSocket──► ProjectDO (hibernation)
                       │
                       ├─ backlog (tickets, transitions, message log)
                       ├─ role configs (per-project runtime+model per role)
                       ├─ cost ledger
                       │
                       └─ AgentRuntime adapter
                            ├─ CFNativeRuntime  (Claude Agent SDK in Worker)
                            └─ OpenAIResponsesRuntime  (Hosted loop)
                       │
                       └─ Spine tools (file.*, bash, browse.*, git.*, pas.*)
                            ├─ CF Containers for bash
                            ├─ Browse Worker (CF Browser Rendering)
                            ├─ PAS admin Worker for git.openPR / pas.publish
                            └─ PAS key vault for BYO API keys
```

## Sequencing

| Stage | Weeks | Goal |
|---|---|---|
| 0 | 1-3 | Static-HTML PAS host port (mirror FWS faithfully), data model in DO, auth |
| 1 | 4-5 | BA role on CFNative only, ticket inbox→awaiting-approval, WebSocket+hibernation |
| 2 | 6-8 | Dev + QA roles, first ticket inbox→done for a static-output app |
| 2.5 | wk 9 | ChatKit multi-instance spike (1 day) |
| 3 | 9-11 | OpenAI Responses adapter, spineTools/vendorTools split validation |
| 4 | 12-13 | Friend beta |

**v1 limitation:** Dev agent restricted to static-output apps. Full PAS
SDK runtime (kv, rooms, db, proxy, subscription) deferred to v1.1.

## v0.1 Layout

```
agent-teams/
├── package.json     ← private Worker package
├── tsconfig.json    ← extends pas/platform/tsconfig.base.json
├── wrangler.toml    ← scaffolded; not deployed
├── README.md
└── src/
    ├── index.ts     ← Hono Worker entry + ProjectDO stub
    └── types.ts     ← canonical schema (§Data Model from the doc)
```

## Build

```bash
pnpm typecheck   # tsc --noEmit
pnpm build       # esbuild bundle to dist/worker.js
```

Deploy (when ready) goes via GitHub Actions per the `ci-cd-canonical` memory
— no laptop deploys.

## Don't forget

- BYO keys non-negotiable. Keys live in PAS key vault, decrypted JIT in the
  adapter, never logged, never returned to client.
- Heartbeats emit during model streaming AND tool runs (prevents stuck-ticket
  false positives on slow model responses).
- v1 Dev agent must not emit code using SDK primitives beyond `auth`.
  BA spec enforces; QA verifies.
