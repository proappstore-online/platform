# @proappstore/runtime-tests

Cloudflare-runtime integration tests (#129, #23). The fast unit suite (`pnpm test`
at the root) runs in Node with D1, KV and `fetch` mocked; this package runs the
platform's Workers **inside workerd** with real bindings, so the things mocks
cannot prove get proved:

| Project | Main | Real bindings | What it proves |
|---|---|---|---|
| `backend` | `packages/backend/src/index.ts` | D1 with the **root `migrations/`** applied, R2, the `Room` Durable Object, `SELF` (bound to itself), `QA_WORKER` (stub worker) | migration shape on a real D1; every table and column the hot paths need; request/response of `/health`, CORS, 404; session happy path and 401s; owner-gated tool registration writing `app_tools.source = 'code'`; the outbound data-worker URL (`#153`) via `fetchMock`; app-role gating from D1 at action time; log ingestion, storage and the daily quota (202) on real tables; a WebSocket into the Room DO through the route and by name |
| `data-worker` | `packages/data-worker/src/index.ts` | D1 (empty; the worker migrates it), `API` service binding to a stub platform API | `/migrate` idempotency, `/execute`, `/query`, atomic `/batch` rollback, `/validate` schema coherence naming a missing column; 401 / 403 fail-closed session paths resolved over the service binding; the internal-token bypass |
| `agent-teams` | `packages/agent-teams/src/index.ts` | the SQLite-backed `ProjectDO`, D1 with the root migrations (`agent_projects`, `team_members`), R2, `ADMIN` (a stub answering the repo-pull handshake), `PAS_BACKEND` + `KB` (echo workers) | project create → D1 index → DO init → owner-only read; team-member access with the role the router looks up in D1 and the #79 role gate; trust-header stripping; 401 / internal-token paths; a hibernation-safe WebSocket receiving a DO broadcast; `POST /sync` pulling the tree from admin over the binding with the internal token; **DO schema migrations on real SQLite storage** — an object created by an older deploy gains every additive column on its next request (`runInDurableObject`) |
| `host` | `packages/host/src/index.ts` | R2 (`APPS`), D1 with the root migrations **and** `packages/host/migrations`, five echo service bindings, an echo `outboundService` | reserved-subdomain dispatch to the right binding with `X-PAS-App` stripped for the API (#80); www redirect; the `data-*` and Pages proxies building the right upstream URL; serving an app from R2 behind a `routes` row with security headers, ETag/304, HEAD, SPA fallback, blocked source maps, 404/405; listing metadata injected from D1; mediated self-registration to the API binding |
| `admin` | `packages/admin/src/index.ts` | D1 with the root migrations, the `PROVISION_WORKFLOW` Workflows binding bound to `ProvisionWorkflow` | `/v1/auth/me` on a backend-minted session; publish-app 401/400; the #83 guards on real tables — ownership 403s (claimed by another creator, unresolvable creator) and the per-caller rate limit writing `provision_attempts` and answering 429 + `Retry-After`; a Workflow instance created with a CF-generated id (#24) and polled by id |
| `config` | Node | — | each Worker's `wrangler.toml` (backend, agent-teams, host, admin) declares every binding, var or deploy-synced secret its `Env` requires and exports every Durable Object class it binds; the backend points D1 at the root migrations, whose numbers are ascending and not reused; a cron exists for `scheduled`; the suite's compatibility date is not newer than production's |

```bash
pnpm test:runtime                               # from the repo root
pnpm --filter @proappstore/runtime-tests test   # same
pnpm --filter @proappstore/runtime-tests test:backend
pnpm --filter @proappstore/runtime-tests test:data-worker
pnpm --filter @proappstore/runtime-tests test:agent-teams
pnpm --filter @proappstore/runtime-tests test:host
pnpm --filter @proappstore/runtime-tests test:admin
```

`pretest` builds the data worker and the backend's embedded bundle
(`packages/backend/scripts/embed-data-worker.mjs`), which the backend imports.
No request leaves workerd: `fetchMock.disableNetConnect()` is on, and anything
the backend fetches (the data worker's `/validate`, `/query`) is intercepted per
test. Storage is not isolated per test for the backend and agent-teams projects
(a SQLite-backed Durable Object's files cannot be snapshotted by the pool), for
the admin project (the pool refuses isolated storage with Workflows) and for the
host (its edge-cache `waitUntil` tees deadlock the pool's teardown), so every
file resets the tables and objects it writes in `beforeEach`, and the
agent-teams tests use a fresh slug per test because a Durable Object outlives it.

The suite already paid for itself: running the host under workerd surfaced an
uncaught `Cannot cache response to non-GET request` in `waitUntil` on every
HEAD request (fixed in the same change).

The compatibility date is the newest the bundled workerd supports
(`config/shared.ts`); production runs a later one, which the `config` project
checks is not older than the suite's. Bump both together with
`@cloudflare/vitest-pool-workers`.

CI runs this in its own `runtime-integration` job, and `deploy-backend.yml` runs
it before applying migrations to production.
