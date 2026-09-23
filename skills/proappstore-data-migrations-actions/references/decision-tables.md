# Decision tables

Each row: the need, what to use, the clause, the docs page, and what not to
use. Manifest keys and SDK surfaces named here exist today; verify methods
with `sdk_reference` before quoting them.

## Stores

| The data is… | Use | Clause | Docs | Do not use |
|---|---|---|---|---|
| Shared between users, relational, queried, exported | **D1** via registered actions (`app.actions.call`) | [PAS-DATA-013](https://docs.proappstore.online/standard/data/#pas-data-013), [PAS-STACK-007](https://docs.proappstore.online/standard/stack/#pas-stack-007) | [app actions security](https://docs.proappstore.online/app-actions-security/) | KV; Firestore, Supabase, Mongo; raw `app.db.*` in user code |
| One user's preferences or small drafts | **`app.kv`** — 100 keys, 64 KB/value, 1 MB/user | [PAS-DATA-013](https://docs.proappstore.online/standard/data/#pas-data-013), [PAS-STACK-009](https://docs.proappstore.online/standard/stack/#pas-stack-009) | [recipe kv-preferences](https://docs.proappstore.online/recipes/) | anything another user must see; relational data |
| A file, image or document | **`app.storage`** — keep the key in D1 | [PAS-DATA-013](https://docs.proappstore.online/standard/data/#pas-data-013), [PAS-STACK-012](https://docs.proappstore.online/standard/stack/#pas-stack-012) | [recipe file-upload](https://docs.proappstore.online/recipes/) | bytes or base64 in D1/KV |
| A number many users bump | **`app.counters`** (atomic) | [PAS-DATA-013](https://docs.proappstore.online/standard/data/#pas-data-013), [PAS-STACK-010](https://docs.proappstore.online/standard/stack/#pas-stack-010) | [SDK overview](https://docs.proappstore.online/sdk-overview/) | read-modify-write in KV/D1 |
| Live, ephemeral, multi-peer | **`app.rooms`** — untrusted payloads, nothing persisted | [PAS-DATA-017](https://docs.proappstore.online/standard/data/#pas-data-017) | [recipe realtime-chat](https://docs.proappstore.online/recipes/) | durable or authoritative state |

## Schema (`migrations.json`)

| Need | Use | Clause | Docs | Do not use |
|---|---|---|---|---|
| Any table | `id TEXT PRIMARY KEY` (from `:__uuid`), `created_at INTEGER NOT NULL` (ms from `:__now`), `updated_at`, an explicit `user_id` / `org_id` / `tenant_id`, indexes on filter columns | [PAS-DATA-001](https://docs.proappstore.online/standard/data/#pas-data-001) | [DATA chapter](https://docs.proappstore.online/standard/data/) | autoincrement ids; ISO strings; ownerless rows |
| Rows shared by a group | a membership table (`org_members(org_id, user_id, role, created_at)`, `UNIQUE(org_id, user_id)`) that every scoped statement joins | [PAS-DATA-007](https://docs.proappstore.online/standard/data/#pas-data-007), [PAS-STACK-011](https://docs.proappstore.online/standard/stack/#pas-stack-011) | [tailored vs ready](https://docs.proappstore.online/tailored-vs-ready/) | a `tenant_id` the client sends as the only filter |
| Adding a column or table | append `{ "name": "000N_<what>", "sql": "ALTER TABLE … ADD COLUMN … DEFAULT …" }` — new name, additive, `NOT NULL` only with a default | [PAS-DATA-002](https://docs.proappstore.online/standard/data/#pas-data-002), [PAS-STACK-008](https://docs.proappstore.online/standard/stack/#pas-stack-008) | [migration repair runbook](https://docs.proappstore.online/migration-repair-runbook/) | editing a deployed entry; `DROP`, `RENAME`, `DELETE`, `UPDATE` in a migration |
| Renaming or removing | expand / contract: add the new column or table, move data through an action, stop reading the old one; drop nothing | [PAS-DATA-002](https://docs.proappstore.online/standard/data/#pas-data-002) | — | a destructive migration |
| Uniqueness and one-shot grants | `UNIQUE` indexes; consumable rows (`used_at`, `revoked_at`) | [PAS-DATA-008](https://docs.proappstore.online/standard/data/#pas-data-008), [PAS-DATA-018](https://docs.proappstore.online/standard/data/#pas-data-018) | — | uniqueness checked in the client |
| Applying the schema | the template deploy's *Apply D1 migrations* step, before the frontend ships and before actions register; `app.db.migrate` only for local iteration | [PAS-STACK-008](https://docs.proappstore.online/standard/stack/#pas-stack-008), [PAS-STACK-005](https://docs.proappstore.online/standard/stack/#pas-stack-005) | [app actions security](https://docs.proappstore.online/app-actions-security/) | runtime DDL; applying on first visit |
| Checking it applied | deploy log `Applied migration(s): […]`; `schema_status` shows the latest attempt applied, none failed | [PAS-DATA-002](https://docs.proappstore.online/standard/data/#pas-data-002) | [migration repair runbook](https://docs.proappstore.online/migration-repair-runbook/) | assuming |

## Actions (`mcp.json`)

| Need | Use | Clause | Docs | Do not use |
|---|---|---|---|---|
| Any user-facing read or write | a `tools[]` entry: `name`, `description`, `operation` (`query` \| `execute` \| `batch`), fixed `sql` (or `statements`), `params`, `requires_auth`, `auth` | [PAS-DATA-003](https://docs.proappstore.online/standard/data/#pas-data-003), [PAS-STACK-007](https://docs.proappstore.online/standard/stack/#pas-stack-007) | [app actions security](https://docs.proappstore.online/app-actions-security/) | `app.db.query` / `execute` / `batch` in user code |
| Inputs | `params: { q: { type: "string" }, limit: { type: "integer", default: 50, max: 100, optional: true } }`; types `string`, `integer`, `number`, `boolean` | [PAS-DATA-005](https://docs.proappstore.online/standard/data/#pas-data-005) | [app actions security](https://docs.proappstore.online/app-actions-security/) | column, table, sort or `LIKE` pattern from input; undeclared `:param` |
| Identity, time, ids | `:__user_id`, `:__now`, `:__uuid` — injected by the executor, never overridable | [PAS-DATA-006](https://docs.proappstore.online/standard/data/#pas-data-006) | [app actions security](https://docs.proappstore.online/app-actions-security/) | `user_id`, `owner_id`, `created_at`, `role` as client params |
| Authorization | `requires_auth: true` explicit on every write and user-scoped read; `auth.app_roles: ["editor"]` minimal; **and** a scoping predicate in every statement | [PAS-DATA-004](https://docs.proappstore.online/standard/data/#pas-data-004), [PAS-DATA-007](https://docs.proappstore.online/standard/data/#pas-data-007), [PAS-AUTH-016](https://docs.proappstore.online/standard/auth/#pas-auth-016) | [authorization model](https://docs.proappstore.online/authorization-model/) | `auth.platform_roles` for app features; role metadata alone |
| Self-owned rows | `WHERE id = :id AND user_id = :__user_id` | [PAS-DATA-007](https://docs.proappstore.online/standard/data/#pas-data-007) | — | `WHERE id = :id` |
| Group-owned rows | `org_id IN (SELECT org_id FROM org_members WHERE user_id = :__user_id AND role IN ('owner','manager'))` or a row-derived `EXISTS` guard | [PAS-DATA-007](https://docs.proappstore.online/standard/data/#pas-data-007) | [app actions security](https://docs.proappstore.online/app-actions-security/) | trusting an `:org_id` param |
| State transitions, ownership | in the statement: `AND status = 'open'`, ownership predicates, `UNIQUE`; the UI reads `meta.changes` | [PAS-DATA-008](https://docs.proappstore.online/standard/data/#pas-data-008), [PAS-DATA-018](https://docs.proappstore.online/standard/data/#pas-data-018) | — | client check then unconditional write |
| Grants (join codes, invites) | `INSERT … SELECT :__user_id, jc.role, jc.org_id FROM join_codes jc WHERE jc.id = :code_id AND jc.used_at IS NULL`, and a statement that consumes the code in the same batch | [PAS-DATA-008](https://docs.proappstore.online/standard/data/#pas-data-008) | [app actions security](https://docs.proappstore.online/app-actions-security/) | `role` or `org_id` copied from a param; a grant row that stays redeemable |
| Multi-step flows | `operation: "batch"`, `statements: [...]` (≤ 25), one transaction; correlated ids as a client-supplied param (`:__uuid` is per occurrence) | [PAS-DATA-009](https://docs.proappstore.online/standard/data/#pas-data-009) | [app actions security](https://docs.proappstore.online/app-actions-security/) | sequential client calls |
| Retries, double clicks | client-supplied id + primary key / `UNIQUE`, or `INSERT OR IGNORE`; guards on current state; `meta.changes` 1 then 0 | [PAS-DATA-018](https://docs.proappstore.online/standard/data/#pas-data-018) | — | assuming success |
| Lists | `LIMIT :limit` with `max`, explicit columns, keyset cursor on `(created_at, id)` | [PAS-DATA-010](https://docs.proappstore.online/standard/data/#pas-data-010) | [recipe data-table](https://docs.proappstore.online/recipes/) | `OFFSET`; unbounded `SELECT *` |
| Public data | `requires_auth: false`, `operation: "query"`, named public columns, literal `LIMIT` ≤ 500, called with `app.actions.callPublic` | [PAS-DATA-011](https://docs.proappstore.online/standard/data/#pas-data-011) | [app actions security](https://docs.proappstore.online/app-actions-security/) | anything derived from a user's or tenant's data |
| Search, export, statistics | the same scoping predicate as the list actions, bounded; `auth.caller_unscoped` with a reason only for aggregates that return no row data | [PAS-DATA-012](https://docs.proappstore.online/standard/data/#pas-data-012) | — | an unscoped export "for admins" |
| Background work | an idempotent, `LIMIT`-bounded, role-gated sweep action run from a privileged session; the missing cron recorded in the README | [PAS-DATA-019](https://docs.proappstore.online/standard/data/#pas-data-019) | — | browser timers, external cron, own Worker |
| Failures | every failed call reaches an error state and `app.logs`; 401 / 403 / 4xx / 5xx distinguished | [PAS-DATA-021](https://docs.proappstore.online/standard/data/#pas-data-021) | [monitoring runbook](https://docs.proappstore.online/monitoring-runbook/) | rendering a failed read as an empty list |
| Caches | in memory for the session; cleared on sign-out | [PAS-DATA-020](https://docs.proappstore.online/standard/data/#pas-data-020) | — | scoped rows in `localStorage` / a service worker |
| Reaching the data plane | only the SDK (`app.actions`, and `app.db` in team tooling) | [PAS-DATA-016](https://docs.proappstore.online/standard/data/#pas-data-016), [PAS-DATA-014](https://docs.proappstore.online/standard/data/#pas-data-014) | — | a `data-<app>` URL; an own Worker |

## Verification and deployment checks

| Check | How | Clause |
|---|---|---|
| Migration applied | deploy step *Apply D1 migrations* lists the name under `applied`; `schema_status` shows no failed rows | [PAS-DATA-002](https://docs.proappstore.online/standard/data/#pas-data-002) |
| Manifest registers | the deploy's *Register app tools* step passes: statements are SELECT/INSERT/UPDATE/DELETE only, no semicolons or DDL, every `:param` declared, ≤ 120 tools | [PAS-DATA-005](https://docs.proappstore.online/standard/data/#pas-data-005) |
| Schema coherence | registration compiles every action against the live schema; a missing table or column fails the deploy naming the tool and column | [PAS-STACK-008](https://docs.proappstore.online/standard/stack/#pas-stack-008) |
| Drift | `discover_tools` lists exactly the committed `mcp.json`; every column an action uses exists in `migrations.json` | [PAS-DATA-002](https://docs.proappstore.online/standard/data/#pas-data-002) |
| Negative tests in CI | per scoped action: as user B against A's ids → no rows / `meta.changes === 0`; positive for A; `member`-only → 403 per role gate; removing a predicate fails CI | [PAS-DATA-022](https://docs.proappstore.online/standard/data/#pas-data-022) |
| Idempotency | each create/transition called twice → `meta.changes` 1 then 0 | [PAS-DATA-018](https://docs.proappstore.online/standard/data/#pas-data-018) |
| Injection | a `q` of `'; DROP TABLE tasks; --` returns nothing and the table remains; a `limit` above `max` is clamped | [PAS-DATA-005](https://docs.proappstore.online/standard/data/#pas-data-005) |
| Team-only tooling | `app.db.*` and `app.db.tenant()` appear only in admin scripts or local development, behind the data worker's team-role gate | [PAS-DATA-003](https://docs.proappstore.online/standard/data/#pas-data-003) |
