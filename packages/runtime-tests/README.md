# @proappstore/runtime-tests

Cloudflare-runtime integration tests (#129). The fast unit suite (`pnpm test` at
the root) runs in Node with D1, KV and `fetch` mocked; this package runs the
platform's two most critical Workers **inside workerd** with real bindings, so
the things mocks cannot prove get proved:

| Project | Main | Real bindings | What it proves |
|---|---|---|---|
| `backend` | `packages/backend/src/index.ts` | D1 with the **root `migrations/`** applied, R2, the `Room` Durable Object, `SELF` (bound to itself), `QA_WORKER` (stub worker) | migration shape on a real D1; every table and column the hot paths need; request/response of `/health`, CORS, 404; session happy path and 401s; owner-gated tool registration writing `app_tools.source = 'code'`; the outbound data-worker URL (`#153`) via `fetchMock`; app-role gating from D1 at action time; log ingestion, storage and the daily quota (202) on real tables; a WebSocket into the Room DO through the route and by name |
| `data-worker` | `packages/data-worker/src/index.ts` | D1 (empty; the worker migrates it), `API` service binding to a stub platform API | `/migrate` idempotency, `/execute`, `/query`, atomic `/batch` rollback, `/validate` schema coherence naming a missing column; 401 / 403 fail-closed session paths resolved over the service binding; the internal-token bypass |
| `config` | Node | — | `wrangler.toml` declares every binding `Env` requires, points D1 at the root migrations, the migration numbers are ascending and not reused, a cron exists for `scheduled`, and the suite's compatibility date is not newer than production's |

```bash
pnpm test:runtime                               # from the repo root
pnpm --filter @proappstore/runtime-tests test   # same
pnpm --filter @proappstore/runtime-tests test:backend
pnpm --filter @proappstore/runtime-tests test:data-worker
```

`pretest` builds the data worker and the backend's embedded bundle
(`packages/backend/scripts/embed-data-worker.mjs`), which the backend imports.
No request leaves workerd: `fetchMock.disableNetConnect()` is on, and anything
the backend fetches (the data worker's `/validate`, `/query`) is intercepted per
test. Storage is not isolated per test for the backend project (the Durable
Object's SQLite files cannot be snapshotted by the pool), so every file resets
the tables it writes in `beforeEach`.

The compatibility date is the newest the bundled workerd supports
(`config/shared.ts`); production runs a later one, which the `config` project
checks is not older than the suite's. Bump both together with
`@cloudflare/vitest-pool-workers`.

CI runs this in its own `runtime-integration` job, and `deploy-backend.yml` runs
it before applying migrations to production.
