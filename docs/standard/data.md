# Data, actions, and Workers

**Standard version 1.5** · Chapter `DATA` · Part of the [Application Standard](./index.md)

**Scope.** D1 schema and migrations, registered actions, per-user/project/tenant row scoping, KV, counters, storage, rooms and Durable Objects, Workers and service bindings.

Clause IDs in this chapter have the form `PAS-DATA-<NNN>`; see the
[clause ID grammar](./governance.md#clause-id-grammar). Each clause follows the
[clause template](./governance.md#clause-template) and is audited under the
[audit model](./audit-model.md). The [STACK chapter](./stack.md) decides *that*
the app uses actions, `migrations.json` and the platform stores; this chapter
says how, and how an auditor proves it.

## The architecture these clauses assume

An app ships static assets to R2. The platform provisions one D1 database and
one `data-<app>.proappstore.online` Worker per app from its own bundle. The app
declares its schema in `migrations.json` (additive-only, applied by the deploy
before anything else) and its server-side behaviour in `mcp.json` as
registered SQL actions. The platform executor authenticates the caller,
enforces the manifest's role metadata, injects `:__user_id` / `:__now` /
`:__uuid`, binds parameters positionally, and forwards prepared SQL to the
app's data worker over the trusted internal path. Raw SQL (`app.db.*`) is
gated to the app's team by role. Platform workers talk to each other over
service bindings, never plain same-zone `fetch`. There is no app-owned Worker,
no trusted app-code execution surface, and no scheduled execution for static
apps yet; the clauses say what to do meanwhile. Details:
[architecture](../architecture.md), [app actions security](../app-actions-security.md),
[MCP app tools](../mcp-app-tools.md).

## Choosing a store

| The data is… | Store | Authorization | Limits that matter | Do not use for | Clause |
|---|---|---|---|---|---|
| Shared between users, relational, queried, exported | **D1** via registered actions | Manifest roles + SQL scoping on `:__user_id` | Rows read per query; 500 actions/app; 25 statements/batch | Files, blobs, per-user preferences | [007](#pas-data-007), [010](#pas-data-010) |
| One user's preferences or small drafts | **KV** (`app.kv`) | Per user, automatic | 100 keys, 64 KB/value, 1 MB/user | Anything another user must see; anything relational | [013](#pas-data-013) |
| A file, image or document | **Storage** (`app.storage`, R2) | Per user; public URL only via `uploadPublic` | Object size; keep the key in D1 | Bytes in D1/KV | [013](#pas-data-013) |
| A number many users bump | **Counters** (`app.counters`) | Any signed-in user increments; anyone reads | Atomic; not per user | Anything needing a join or history | [013](#pas-data-013) |
| Live, ephemeral, multi-peer | **Rooms** (`app.rooms`, Durable Object) | Session identity on `from`; payload untrusted | 32 peers/room (no per-app room cap, no LRU), 100 msg/s, 4 KB/msg, 24 h idle | Durable or authoritative state | [017](#pas-data-017) |

## Auditing `mcp.json` and `migrations.json`

An AI auditor works through the two files in this order and records one result
per action and per table. Every step cites its clause.

1. **Parse `migrations.json`.** For each `CREATE TABLE`: text primary key, `created_at`, an owner/tenant column, indexes on filter columns → [001](#pas-data-001). Every entry additive, none edited since it was deployed (`git log -p`) → [002](#pas-data-002).
2. **Parse `mcp.json`.** For each tool: `requires_auth` explicit and correct; `auth.app_roles` minimal; no `auth.platform_roles` on app features → [004](#pas-data-004). Every `:param` declared and typed, `max` on limits → [005](#pas-data-005). No `user_id`/`created_at`/`role` params standing in for the caller → [006](#pas-data-006).
3. **Read every predicate.** Each statement of an authenticated tool restricts rows by `:__user_id` directly or through a membership sub-query; a client-supplied tenant id is never the only filter; `:__user_id` is not used tautologically → [007](#pas-data-007). Transitions and grants are guarded in SQL → [008](#pas-data-008).
4. **Check the exemptions.** Every `caller_unscoped` returns an aggregate or shared catalogue, with a specific reason; search/export/stats are scoped → [012](#pas-data-012). Every public tool names its columns and has a literal `LIMIT ≤ 500` → [011](#pas-data-011).
5. **Check shape.** Multi-step flows are `batch` → [009](#pas-data-009). Lists have a bounded `LIMIT` and explicit columns → [010](#pas-data-010). Creates are idempotent under retry → [018](#pas-data-018).
6. **Check the code.** No `app.db.*` in user paths, no direct data-worker URLs, no app-owned Worker → [003](#pas-data-003), [014](#pas-data-014), [016](#pas-data-016). Failures surface → [021](#pas-data-021). Caches die with the session → [020](#pas-data-020).
7. **Check the tests.** A cross-tenant negative test exists per scoped action → [022](#pas-data-022).

## Recommendation, enforcement, capability

| Statement | Kind |
|---|---|
| Migration lint (additive-only, `NOT NULL` needs `DEFAULT`), `_migrations` idempotency by name, schema coherence at registration, manifest validation (explicit auth, declared params, no DDL/semicolons, `WHERE` on writes, `:__user_id` or `caller_unscoped`, public-tool constraints, 500 tools, 25 statements), data-worker role gates, batch transactions, room caps | Automated enforcement by the platform — the clause names the mechanism |
| Schema conventions, scoping idioms, idempotency, pagination, caching, failure handling, negative tests, service bindings, no app-owned Workers | Recommended conformity (`MUST`/`SHOULD`) |
| KV, counters, storage, rooms, batch actions, public queries, tenant helpers | Optional capabilities — absent use is never a finding |

## Capability pages this chapter builds on

Clauses link to these as *Supporting links*; they describe what the platform
provides and are not restated here.

- [Architecture](../architecture.md)
- [App actions and data access security](../app-actions-security.md)
- [MCP app tools](../mcp-app-tools.md)
- [Migration repair runbook](../migration-repair-runbook.md)
- [SDK overview](../sdk-overview.md)
- [Recipes](../recipes.md)
- [Authorization model](../authorization-model.md)
- [ADR-005 D1 per fork](../adr/005-d1-per-fork.md)

## Clauses

### PAS-DATA-001 — Tables have stable text ids, millisecond timestamps, an explicit owner or tenant column, and indexes on what they filter by {#pas-data-001}

**Severity:** Medium · **Verification:** Manual · **Enforcement:** none (recommended) · **Since:** 1.3

**Rule.** Every app table MUST have a `TEXT PRIMARY KEY` populated with `:__uuid` (or a client-supplied uuid when ids must correlate across a batch), `created_at INTEGER NOT NULL` in milliseconds from `:__now`, and — for any row that belongs to someone — an explicit `user_id`, `org_id` or `tenant_id` column. Tables SHOULD have `updated_at`, SHOULD declare `FOREIGN KEY` relationships, and MUST index the columns their actions filter and order by.

**Applicability.** Apps with a D1 schema.

**Rationale.** Integer autoincrement ids are guessable and collide across batches; wall-clock strings sort wrongly; a row with no owner column cannot be scoped ([PAS-DATA-007](#pas-data-007)). D1 enforces declared foreign keys, so a dangling reference fails at write time instead of leaking later. Un-indexed scoping columns turn every list action into a scan.

**Recommended implementation.** Model each table in `migrations.json` with the columns above; add `CREATE INDEX` on `(tenant_id, created_at)` style pairs; keep `PRAGMA` out (migrations reject it), so order inserts parent-before-child.

**Conforming example.**

```sql
CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY, org_id TEXT NOT NULL, user_id TEXT NOT NULL,
  title TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'open',
  created_at INTEGER NOT NULL, updated_at INTEGER,
  FOREIGN KEY (org_id) REFERENCES orgs(id));
CREATE INDEX IF NOT EXISTS idx_tasks_org_created ON tasks (org_id, created_at);
```

**Non-conforming example.**

```sql
CREATE TABLE tasks (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT, created TEXT);   -- guessable id, no owner, text date, no index
```

**Evidence.** Configuration: `migrations.json` — each `CREATE TABLE` (id type, owner column, timestamps, FKs) and the `CREATE INDEX` set against the `WHERE`/`ORDER BY` columns in `mcp.json`.

**Remediation.** Add a new-named additive migration that adds the missing columns (nullable or defaulted) and indexes; backfill with an `INSERT`/action, never with `UPDATE` in a migration (rejected).

**Tests.** Every table referenced in `mcp.json` has a text PK, `created_at`, and an owner/tenant column; every `WHERE tenant_id = … ORDER BY created_at` has a matching index (`EXPLAIN QUERY PLAN` via `app.db.query` as a team developer shows no `SCAN`).

**Supporting links.** [MCP app tools — magic placeholders](../mcp-app-tools.md#magic-placeholders), [Migration repair runbook](../migration-repair-runbook.md), [PAS-STACK-008](./stack.md#pas-stack-008).

### PAS-DATA-002 — Schema changes are additive, named, ordered, never edited, and applied by the deploy {#pas-data-002}

**Severity:** High · **Verification:** Manual · **Enforcement:** automated — platform `POST /v1/apps/:id/migrate/oidc` lints every statement (allowed: `CREATE TABLE/INDEX/VIEW/TRIGGER`, `ALTER TABLE … ADD`, `INSERT INTO`; rejected: `DROP`, `DELETE`, `UPDATE`, `RENAME`, `PRAGMA`, `ATTACH`, `DETACH`, `VACUUM`, `REINDEX`, `REPLACE`, and `ADD COLUMN … NOT NULL` without a non-null `DEFAULT`); the data worker tracks applied names in `_migrations` · **Since:** 1.3

**Rule.** `migrations.json` MUST be the only schema source: entries are appended with a new name, never edited once deployed, and contain only additive statements. Renames and removals MUST be done expand/contract (add the new column or table, migrate data through an action, stop reading the old one; drop nothing). The app MUST NOT run DDL at runtime from browser code except `app.db.migrate` mirroring the same file in local development.

**Applicability.** Apps with a D1 schema.

**Rationale.** Migrations are idempotent **by name**: editing an already-applied entry is silently skipped, which is how an action came to reference a column that was never added. The deploy applies the file before actions register and before the frontend uploads, and the schema-coherence check then compiles every action against the live schema — so the file is the contract the rest of the deploy relies on.

**Recommended implementation.** Number entries (`0001_init`, `0002_tasks_status`); to fix a mistake, add `0003_…`. Check `GET /v1/apps/:id/schema-status` (or the `schema_status` MCP tool) after a deploy that touched schema.

**Conforming example.**

```json
{ "migrations": [
  { "name": "0001_init", "sql": "CREATE TABLE IF NOT EXISTS tasks (id TEXT PRIMARY KEY, org_id TEXT NOT NULL, title TEXT NOT NULL, created_at INTEGER NOT NULL)" },
  { "name": "0002_tasks_status", "sql": "ALTER TABLE tasks ADD COLUMN status TEXT NOT NULL DEFAULT 'open'" }
] }
```

**Non-conforming example.**

```json
{ "migrations": [
  { "name": "0001_init", "sql": "CREATE TABLE IF NOT EXISTS tasks (id TEXT PRIMARY KEY, org_id TEXT NOT NULL, title TEXT NOT NULL, status TEXT, created_at INTEGER NOT NULL)" }
] }
// 0001_init was already applied without `status` — editing it does nothing; the deploy's coherence check fails naming the action and column
```

**Evidence.** Configuration: `migrations.json` history in `git log -p`; any edited entry; forbidden statements; Runtime: `schema-status` audit rows with `status: failed`.

**Remediation.** Restore the applied entry to its deployed text; add a new-named migration with the intended change; push and confirm `Applied migration(s)` in the deploy log.

**Tests.** The deploy's *Apply D1 migrations* step lists the new name under `applied`; `schema-status` shows no failed rows; the coherence step registers every tool.

**Supporting links.** [App actions security — low-level raw SQL](../app-actions-security.md#low-level-raw-sql), [Migration repair runbook](../migration-repair-runbook.md), [PAS-STACK-008](./stack.md#pas-stack-008).

### PAS-DATA-003 — User-facing reads and writes are registered actions; raw SQL is a team tool {#pas-data-003}

**Severity:** High · **Verification:** Manual · **Enforcement:** automated — the data worker gates `/query`, `/execute`, `/batch` to team `developer`+ and `/migrate` to team `owner`; end users receive 403 · **Since:** 1.3

**Rule.** Every data path an end user can reach MUST be an action in `mcp.json` invoked with `app.actions.call` (or `callPublic` for public queries). `app.db.query` / `execute` / `batch` / `tables` MUST appear only in team-only tooling (admin scripts, local development) and never in a code path rendered for ordinary users.

**Applicability.** Apps that store app data.

**Rationale.** Raw SQL is authorised by team role, so any end-user path built on it fails with 403 the moment a non-team user signs in — the post-lockdown failure that drove nine apps to convert. Actions are authorised by manifest metadata plus their own SQL and run through the platform executor with the platform internal token, for any signed-in user.

**Recommended implementation.** One action per operation, named for the operation (`list_tasks`, `create_task`, `close_task`); call it from the UI. Keep `app.db.*` behind a team-role check if it exists at all.

**Conforming example.**

```ts
const { rows } = await app.actions.call<{ rows: Task[] }>('list_tasks', { org_id, limit: 50 })
```

**Non-conforming example.**

```ts
const { rows } = await app.db.query('SELECT * FROM tasks WHERE org_id = ?', [orgId])   // 403 for every non-team user
```

**Evidence.** Source: `grep -rn "app\.db\.\(query\|execute\|batch\|tables\)" web/src` — each hit outside a team-only surface is a `fail`; `mcp.json` present and committed (`git cat-file -e HEAD:mcp.json`).

**Remediation.** Write the action, replace the call, verify as a non-team account. Check `mcp.json` is not git-ignored — a gitignored manifest registers zero tools on a green deploy.

**Tests.** A second account that is not on the app's team can perform every user-facing operation on the live app; no 403s from the data plane in `app.logs`.

**Supporting links.** [App actions security — recommended path](../app-actions-security.md#recommended-path), [Architecture — worker-to-worker pattern](../architecture.md#worker-to-worker-pattern), [PAS-STACK-007](./stack.md#pas-stack-007).

### PAS-DATA-004 — Every action declares its authorization explicitly and minimally {#pas-data-004}

**Severity:** High · **Verification:** Manual · **Enforcement:** automated — registration requires explicit `requires_auth`; public tools may not declare roles or `auth.required: true`; `auth.required: false` is refused on authenticated tools · **Since:** 1.3

**Rule.** Each tool MUST set `requires_auth` explicitly (`true` for every write and every user-scoped read), MUST list the narrowest `auth.app_roles` that may perform it when a role is needed, and MUST NOT use `auth.platform_roles` to gate ordinary app features. Role metadata is an early gate; the SQL still scopes ([PAS-DATA-007](#pas-data-007)).

**Applicability.** Apps with registered actions.

**Rationale.** An action without explicit auth is rejected at registration precisely because the two defaults are both wrong: silently public leaks, silently private surprises. Platform roles (`creator`, `admin`) describe standing with the store, not permission inside an app ([PAS-AUTH-013](./auth.md#pas-auth-013)).

**Recommended implementation.** Per tool: `"requires_auth": true`, optional `"auth": { "app_roles": ["coach"] }`. Reserve `requires_auth: false` for [PAS-DATA-011](#pas-data-011).

**Conforming example.**

```json
{ "name": "close_task", "operation": "execute", "requires_auth": true, "auth": { "app_roles": ["manager"] },
  "sql": "UPDATE tasks SET status = 'closed', updated_at = :__now WHERE id = :id AND org_id IN (SELECT org_id FROM org_members WHERE user_id = :__user_id AND role = 'manager')",
  "params": { "id": { "type": "string" } } }
```

**Non-conforming example.**

```json
{ "name": "close_task", "operation": "execute", "auth": { "platform_roles": ["creator"] }, "sql": "UPDATE tasks SET status = 'closed' WHERE id = :id", "params": { "id": { "type": "string" } } }
```

**Evidence.** Configuration: every tool's `requires_auth`, `auth.app_roles`, `auth.platform_roles` in `mcp.json`.

**Remediation.** Set `requires_auth`; replace platform-role gates with app roles; tighten role lists.

**Tests.** Registration succeeds; a `member`-only account gets 403 from each role-gated action. **Cross-tenant negative test:** with a second account that is not a member of the tenant, call the action with the first tenant's ids; expect no rows (query) or `meta.changes === 0` (execute/batch).

**Supporting links.** [App actions security — auth rules](../app-actions-security.md#auth-rules), [MCP app tools — roles and permissions](../mcp-app-tools.md#roles-and-permissions), [PAS-AUTH-016](./auth.md#pas-auth-016).

### PAS-DATA-005 — All inputs are declared, typed, bounded parameters; SQL text is never built from input {#pas-data-005}

**Severity:** Critical · **Verification:** Manual · **Enforcement:** automated — registration rejects undeclared `:params`, semicolons and DDL; the executor binds every `:name` positionally and validates types, `optional`, `default`, `max` · **Since:** 1.3

**Rule.** Every value an action takes MUST be a declared `params` entry with a `type` (`string`, `integer`, `number`, `boolean`), and integers used as limits MUST carry `max`. Column names, table names, sort orders and `LIKE` patterns MUST NOT be assembled from input — the SQL is a fixed string in the manifest. Raw `app.db.*` calls, where they exist, MUST use positional `?` with a params array.

**Applicability.** Apps with registered actions or raw SQL tooling.

**Rationale.** The manifest SQL is parsed once at registration; binding is positional, so there is no injection surface *unless* the app reintroduces one by choosing which SQL to run from user input, or by concatenating in a raw call.

**Recommended implementation.** Fixed SQL per action; for sortable lists, one action per sort order or a `CASE` on a bound enum value; for search, `LIKE :pattern` with the wildcard added in SQL (`'%' || :q || '%'`).

**Conforming example.**

```json
{ "name": "search_tasks", "operation": "query", "requires_auth": true,
  "sql": "SELECT id, title FROM tasks WHERE org_id IN (SELECT org_id FROM org_members WHERE user_id = :__user_id) AND title LIKE '%' || :q || '%' ORDER BY created_at DESC LIMIT :limit",
  "params": { "q": { "type": "string" }, "limit": { "type": "integer", "optional": true, "default": 20, "max": 100 } } }
```

**Non-conforming example.**

```ts
await app.db.query(`SELECT * FROM tasks WHERE title LIKE '%${q}%' ORDER BY ${sortColumn}`)   // string-built SQL
```

**Evidence.** Configuration: `params` declarations (type, max on limits); Source: template literals or concatenation feeding `app.db.*`; any code that selects an action name from user input to vary SQL.

**Remediation.** Declare the params; fix the SQL; split sort variants into actions or a bound `CASE`.

**Tests.** Registration passes; a `limit` above `max` is clamped to `max` by the executor; a `q` of `'; DROP TABLE tasks; --` returns an empty result and the table still exists.

**Supporting links.** [MCP app tools — validation rules](../mcp-app-tools.md#validation-rules-enforced-at-register-time), [MCP app tools — manifest](../mcp-app-tools.md#the-mcpjson-manifest).

### PAS-DATA-006 — Identity, time and new ids come from the server, never from the client {#pas-data-006}

**Severity:** Critical · **Verification:** Manual · **Enforcement:** automated — the executor injects `:__user_id`, `:__now`, `:__uuid`; the manifest cannot declare them as params; a client value for them is ignored · **Since:** 1.3

**Rule.** Actions MUST take the caller's identity from `:__user_id`, timestamps from `:__now`, and new primary keys from `:__uuid`. They MUST NOT accept a `user_id`, `owner_id`, `created_at` or trust-bearing id as a client parameter, and MUST NOT copy a client-supplied role or grant into a row ([PAS-DATA-008](#pas-data-008)).

**Applicability.** Apps with registered actions.

**Rationale.** A `:user_id` parameter is the caller telling the server who they are. `:__user_id` is the server telling the SQL who the caller is. The first is impersonation by construction; the platform's registration lint rejects statements that lack `:__user_id`, but it cannot tell that a `:user_id` param was the intended scope.

**Recommended implementation.** Use magic placeholders everywhere identity or time appears. When an action legitimately targets *another* user (a manager removing a member), the target is a param and the *caller* is still `:__user_id` in the guard.

**Conforming example.**

```sql
INSERT INTO tasks (id, org_id, user_id, title, created_at) VALUES (:__uuid, :org_id, :__user_id, :title, :__now)
```

**Non-conforming example.**

```sql
INSERT INTO tasks (id, org_id, user_id, title, created_at) VALUES (:id, :org_id, :user_id, :title, :created_at)   -- caller names themself
```

**Evidence.** Configuration: `params` named `user_id`, `owner_id`, `author_id`, `created_at`, `role` on authenticated tools; SQL using them in `VALUES` or `WHERE` as the caller.

**Remediation.** Replace with the magic placeholder; keep target ids as params only where the guard still uses `:__user_id`.

**Tests.** Calling `create_task` with a forged `user_id` param is rejected as undeclared, or ignored, and the row carries the caller's id. **Cross-tenant negative test:** with a second account that is not a member of the tenant, call the action with the first tenant's ids; expect no rows (query) or `meta.changes === 0` (execute/batch).

**Supporting links.** [App actions security — request flow](../app-actions-security.md#request-flow), [MCP app tools — magic placeholders](../mcp-app-tools.md#magic-placeholders).

### PAS-DATA-007 — Every statement scopes rows to the caller, the project, the organisation or the tenant in SQL {#pas-data-007}

**Severity:** Critical · **Verification:** Manual · **Enforcement:** automated — registration rejects any statement of an authenticated tool that does not reference `:__user_id`, unless the tool declares `auth.caller_unscoped` with a reason · **Since:** 1.3

**Rule.** Every statement of an authenticated action — reads included — MUST restrict rows to what the caller may see or change, using one of: self-scoping (`user_id = :__user_id`), a membership sub-query (`org_id IN (SELECT org_id FROM org_members WHERE user_id = :__user_id …)`), or a row-derived guard (`EXISTS (… WHERE m.user_id = :__user_id AND m.org_id = t.org_id)`). A client-supplied `org_id`/`tenant_id`/`project_id` MUST NOT be the only filter.

**Applicability.** Apps with registered actions. Tailored (single-customer) forks MAY record `not-applicable` for tenant scoping with the fork as evidence; user scoping still applies.

**Rationale.** Any signed-in platform user can POST any app's authenticated action. The SQL is therefore the only thing between one tenant's rows and another's. Registration proves `:__user_id` is *referenced*; only reading the predicate proves it *scopes*.

**Recommended implementation.** Pick the idiom per table. Use `app.db.tenant(id)` helpers only in team tooling (they auto-append `tenant_id = ?` but take the tenant from the caller of the helper, not from the session).

**Conforming example.**

```sql
SELECT t.id, t.title FROM tasks t WHERE t.org_id = :org_id
   AND EXISTS (SELECT 1 FROM org_members m WHERE m.org_id = t.org_id AND m.user_id = :__user_id)
 ORDER BY t.created_at DESC LIMIT :limit
```

**Non-conforming example.**

```sql
SELECT t.id, t.title FROM tasks t WHERE t.org_id = :org_id ORDER BY t.created_at DESC LIMIT :limit   -- org chosen by the client
-- passes the lint if :__user_id appears elsewhere, e.g. `AND :__user_id IS NOT NULL` — still unscoped
```

**Evidence.** Configuration: each statement's `WHERE` clause in `mcp.json`; every `caller_unscoped` reason ([PAS-DATA-012](#pas-data-012)); tautological uses of `:__user_id`.

**Remediation.** Rewrite the predicate with the membership table; add the membership table to `migrations.json` if it does not exist.

**Tests.** **Cross-tenant negative test:** with a second account that is not a member of the tenant, call the action with the first tenant's ids; expect no rows (query) or `meta.changes === 0` (execute/batch). Repeat for every action; a reviewer records the pair (action, negative test) in the audit.

**Supporting links.** [App actions security — guard idioms](../app-actions-security.md#guard-idioms-the-sql-is-the-security-boundary), [PAS-STACK-011](./stack.md#pas-stack-011), [PAS-AUTH-016](./auth.md#pas-auth-016).

### PAS-DATA-008 — Write invariants live in the statement, and grants are derived from server rows {#pas-data-008}

**Severity:** High · **Verification:** Manual · **Enforcement:** none (recommended) · **Since:** 1.3

**Rule.** State transitions, uniqueness and ownership MUST be enforced inside the statement (`AND status = 'open'`, `UNIQUE` indexes, ownership predicates) rather than by a client-side check followed by an unconditional write. Privileges MUST be derived from a server row (`INSERT … SELECT … FROM join_codes`), never copied from a client parameter, and one-shot grants MUST be consumable so they cannot be replayed.

**Applicability.** Apps with writes.

**Rationale.** A check in the browser is advice to an honest client. An `UPDATE … WHERE id = :id` after a client-side `if (task.status === 'open')` closes a task that was already closed by someone else — or one the caller never owned. A join-code redemption that copies `:role` from the client is self-service admin.

**Recommended implementation.** Guard every `UPDATE`/`DELETE` on the current state and the caller; use `UNIQUE` constraints for "only one of"; read `meta.changes` to learn whether the guard passed ([PAS-DATA-018](#pas-data-018)); revoke by deleting the grant row.

**Conforming example.**

```sql
UPDATE tasks SET status = 'closed', updated_at = :__now
 WHERE id = :id AND status = 'open'
   AND org_id IN (SELECT org_id FROM org_members WHERE user_id = :__user_id AND role IN ('manager','owner'))
```

**Non-conforming example.**

```sql
UPDATE tasks SET status = :status WHERE id = :id                       -- any state, any caller
INSERT INTO org_members (org_id, user_id, role) VALUES (:org_id, :__user_id, :role)   -- role named by the client
```

**Evidence.** Configuration: `UPDATE`/`DELETE` predicates; `INSERT` statements whose `role`/`plan`/`tier` columns come from params; presence of a revocation action for each grant.

**Remediation.** Move the check into the predicate; derive grants with `INSERT … SELECT`; add the revocation action; add `UNIQUE` indexes via a new migration.

**Tests.** Closing an already-closed task returns `meta.changes === 0`; redeeming a code twice does not create a second membership. **Cross-tenant negative test:** with a second account that is not a member of the tenant, call the action with the first tenant's ids; expect no rows (query) or `meta.changes === 0` (execute/batch).

**Supporting links.** [App actions security — guard idioms](../app-actions-security.md#guard-idioms-the-sql-is-the-security-boundary), [PAS-AUTH-019](./auth.md#pas-auth-019).

### PAS-DATA-009 — Multi-statement changes are one atomic batch action {#pas-data-009}

**Severity:** High · **Verification:** Manual · **Enforcement:** automated — `batch` tools (≤ 25 statements) run in one D1 transaction on the data worker; each member is validated as a write · **Since:** 1.3

**Rule.** A flow whose statements must all succeed or all fail — create a parent and its first membership, move a record and write its audit row, cascade a delete — MUST be a single `operation: "batch"` action. Sequential single actions from the client MAY be used only when every step is independently idempotent and safe to observe alone.

**Applicability.** Apps with multi-step writes.

**Rationale.** A network drop between two client calls leaves the parent without its owner or the delete without its audit row. The batch executes in one transaction; a mid-sequence failure rolls everything back.

**Recommended implementation.** Declare `statements` sharing one `params` pool. `:__user_id`/`:__now` resolve identically across statements; `:__uuid` is per occurrence, so pass a client-generated uuid as a param when ids must correlate.

**Conforming example.**

```json
{ "name": "create_org", "operation": "batch", "requires_auth": true,
  "statements": [
    "INSERT INTO orgs (id, name, owner_id, created_at) VALUES (:id, :name, :__user_id, :__now)",
    "INSERT INTO org_members (org_id, user_id, role, created_at) VALUES (:id, :__user_id, 'owner', :__now)"
  ], "params": { "id": { "type": "string" }, "name": { "type": "string" } } }
```

**Non-conforming example.**

```ts
await app.actions.call('create_org', { id, name })
await app.actions.call('add_owner', { org_id: id })      // second call may never happen
```

**Evidence.** Configuration: pairs of `execute` actions the UI always calls together; `statements` arrays; Source: consecutive `actions.call` sequences without idempotency.

**Remediation.** Merge into a batch action; pass correlating ids as params.

**Tests.** Forcing the second statement to fail (e.g. a `UNIQUE` violation) leaves no parent row. **Cross-tenant negative test:** with a second account that is not a member of the tenant, call the action with the first tenant's ids; expect no rows (query) or `meta.changes === 0` (execute/batch).

**Supporting links.** [App actions security — batch tools](../app-actions-security.md#batch-tools-atomic-multi-statement-actions), [MCP app tools — manifest](../mcp-app-tools.md#the-mcpjson-manifest).

### PAS-DATA-010 — List reads are bounded and paginated by cursor {#pas-data-010}

**Severity:** Medium · **Verification:** Manual · **Enforcement:** none (recommended) · **Since:** 1.3

**Rule.** Every action that returns multiple rows MUST include a `LIMIT` bound by a declared integer param with `max` (or a literal for public tools), SHOULD select explicit columns, and SHOULD paginate with a keyset cursor on `(created_at, id)` rather than `OFFSET`. Unbounded `SELECT *` is not permitted in a user-facing action.

**Applicability.** Apps with list actions.

**Rationale.** D1 bills and times out on rows read; an unbounded list is a denial-of-service against the app's own quota, and `OFFSET` re-reads every skipped row. Explicit columns keep private fields ([PAS-DATA-012](#pas-data-012)) out of responses by construction.

**Recommended implementation.** `LIMIT :limit` with `{ "type": "integer", "optional": true, "default": 50, "max": 200 }`; cursor params `before_created_at` / `before_id`; the UI's data table passes the last row's values.

**Conforming example.**

```sql
SELECT id, title, status, created_at FROM tasks
 WHERE org_id IN (SELECT org_id FROM org_members WHERE user_id = :__user_id)
   AND (:before IS NULL OR created_at < :before)
 ORDER BY created_at DESC LIMIT :limit
```

**Non-conforming example.**

```sql
SELECT * FROM tasks WHERE org_id IN (SELECT org_id FROM org_members WHERE user_id = :__user_id)   -- no LIMIT, every column
```

**Evidence.** Configuration: `LIMIT` and its param's `max` on every `query` tool; `SELECT *`; `OFFSET`.

**Remediation.** Add `LIMIT :limit` with `max`; list columns; convert offset paging to a cursor.

**Tests.** Every `query` tool has a bounded `LIMIT`; a request for 10,000 rows is capped at `max`.

**Supporting links.** [Recipes — data table with pagination](../recipes.md#data-crud), [MCP app tools — manifest](../mcp-app-tools.md#the-mcpjson-manifest).

### PAS-DATA-011 — Public queries are deliberate, read-only, column-explicit and capped {#pas-data-011}

**Severity:** High · **Verification:** Manual · **Enforcement:** automated — registration constrains `requires_auth: false` to `query` tools with no `:__user_id`, no roles, and a literal `LIMIT ≤ 500`; the executor re-validates at call time · **Since:** 1.3

**Rule.** A tool MAY be public (`requires_auth: false`) only for data that is intentionally visible to anyone on the internet. It MUST be a `query`, MUST select only public columns by name, MUST carry a literal `LIMIT` of 500 or less, and MUST be called with `app.actions.callPublic`. Anything derived from a user's own data, or from a tenant, MUST NOT be public.

**Applicability.** Apps with any unauthenticated read.

**Rationale.** Public tools are reachable by anyone who learns the app id and tool name (action names are enumerable). A `SELECT *` on a table with an email column publishes the emails.

**Recommended implementation.** Name the columns; keep public tables separate from private ones where practical; document why each public tool is public in its `description`.

**Conforming example.**

```json
{ "name": "list_public_events", "description": "Upcoming public events — no personal data", "operation": "query", "requires_auth": false,
  "sql": "SELECT id, title, starts_at FROM events WHERE visibility = 'public' AND starts_at > :__now ORDER BY starts_at LIMIT 100", "params": {} }
```

**Non-conforming example.**

```json
{ "name": "list_events", "operation": "query", "requires_auth": false, "sql": "SELECT * FROM events LIMIT 500", "params": {} }
```

**Evidence.** Configuration: every `requires_auth: false` tool — columns, `WHERE` on a visibility flag, literal `LIMIT`; Source: `callPublic` usage.

**Remediation.** Name the columns; add a visibility predicate; or make the tool authenticated and scoped.

**Tests.** Calling each public tool without a session returns only the listed columns; no email, token, or per-user field appears.

**Supporting links.** [App actions security — auth rules](../app-actions-security.md#auth-rules), [MCP app tools — manifest](../mcp-app-tools.md#the-mcpjson-manifest), [PAS-STACK-011](./stack.md#pas-stack-011).

### PAS-DATA-012 — Exports, search and statistics are scoped like everything else; `caller_unscoped` is for aggregates only {#pas-data-012}

**Severity:** High · **Verification:** Manual · **Enforcement:** automated — registration requires a non-empty `auth.caller_unscoped.reason` on any authenticated statement without `:__user_id` · **Since:** 1.3

**Rule.** Search, export and statistics actions MUST apply the same scoping predicate as the list actions over the same tables, MUST be bounded ([PAS-DATA-010](#pas-data-010)), and MUST NOT return private columns of other users. `auth.caller_unscoped` MAY be declared only for statements that return an aggregate or a shared catalogue with no per-user or per-tenant row data, and its `reason` MUST say which.

**Applicability.** Apps with search, export, reporting or dashboard actions.

**Rationale.** These are where scoping is forgotten: a `COUNT(*)` over all tenants leaks tenancy sizes, a CSV export walks every row, a search over `users` returns strangers. `caller_unscoped` exists for `count_platform_admins`-style bootstraps and public catalogues, not as a way past the lint.

**Recommended implementation.** Write `search_*`, `export_*`, `stats_*` with the membership predicate; export in pages; put aggregates over the caller's own scope unless the reason is a genuine shared catalogue.

**Conforming example.**

```json
{ "name": "stats_my_org", "operation": "query", "requires_auth": true,
  "sql": "SELECT status, COUNT(*) AS n FROM tasks WHERE org_id IN (SELECT org_id FROM org_members WHERE user_id = :__user_id) GROUP BY status LIMIT 50", "params": {} }
```

**Non-conforming example.**

```json
{ "name": "stats_all", "operation": "query", "requires_auth": true, "auth": { "caller_unscoped": { "reason": "dashboard" } },
  "sql": "SELECT org_id, COUNT(*) AS n FROM tasks GROUP BY org_id LIMIT 500", "params": {} }     // per-tenant rows, vague reason
```

**Evidence.** Configuration: every `caller_unscoped` reason and the shape of its statement (aggregate vs rows); `search_*`/`export_*`/`stats_*` predicates.

**Remediation.** Scope the statement or reduce it to a caller-scoped aggregate; rewrite vague reasons; remove the exemption.

**Tests.** Each `caller_unscoped` statement returns no row that names a user or tenant. **Cross-tenant negative test:** with a second account that is not a member of the tenant, call the action with the first tenant's ids; expect no rows (query) or `meta.changes === 0` (execute/batch).

**Supporting links.** [MCP app tools — validation rules](../mcp-app-tools.md#validation-rules-enforced-at-register-time), [PAS-AUTH-019](./auth.md#pas-auth-019).

### PAS-DATA-013 — Each kind of data goes to the store built for it {#pas-data-013}

**Severity:** Medium · **Verification:** Manual · **Enforcement:** none (recommended) · **Since:** 1.3

**Rule.** The app MUST place data according to the [store decision table](#choosing-a-store): relational and shared records in D1 via actions; per-user preferences in `app.kv`; files in `app.storage`; concurrent tallies in `app.counters`; ephemeral fan-out in `app.rooms`. It MUST NOT store files or large blobs in D1 or KV, relational or shared data in KV, or counts as KV/D1 read-modify-write.

**Applicability.** All apps.

**Rationale.** Each store has a shape and a limit (KV 100 keys / 64 KB per value / 1 MB per user; D1 rows read per query; rooms 4 KB per message, nothing persisted). Data in the wrong store hits the limit or the wrong authorization model.

**Recommended implementation.** Use the table. When in doubt: is it shared between users? → D1 action. Is it a file? → storage. Is it a number many users bump? → counters.

**Conforming example.**

```ts
await app.kv.set('prefs', { theme: 'dark' })                         // per-user, small
const { key } = await app.storage.upload(`docs/${id}.pdf`, file, 'application/pdf')
await app.actions.call('attach_doc', { task_id, key })               // the reference lives in D1
await app.counters.increment(`views:${task_id}`)
```

**Non-conforming example.**

```ts
await app.kv.set('all-tasks', tasks)                                 // shared data in a per-user store
await app.actions.call('save_pdf', { data: base64 })                 // file in D1
```

**Evidence.** Source: what each `kv.set`, `storage.upload`, `counters.increment` and action stores; `migrations.json` for `BLOB`/base64 `TEXT` columns.

**Remediation.** Move each item to its store; keep references (keys, ids) in D1.

**Tests.** No KV value exceeds 64 KB or holds another user's data; no D1 column holds file bytes; counters are not read-modify-write.

**Supporting links.** [SDK overview — surfaces](../sdk-overview.md#surfaces), [PAS-STACK-009](./stack.md#pas-stack-009), [PAS-STACK-010](./stack.md#pas-stack-010), [PAS-STACK-012](./stack.md#pas-stack-012).

### PAS-DATA-014 — Apps ship static assets; server-side logic is registered SQL actions on the platform-provisioned data worker {#pas-data-014}

**Severity:** High · **Verification:** Manual · **Enforcement:** none (recommended) · **Since:** 1.3

**Rule.** An app MUST NOT deploy, bundle or depend on a Worker of its own. Its server-side behaviour is the set of registered SQL actions executed by the platform against the `data-<app>.proappstore.online` worker the platform provisions. Logic that cannot be expressed as bounded SQL (a chess-engine verification, an external call inside a transaction) MUST NOT be faked by trusting a client's claim; the audit records it as `manual-review` and the app files a platform issue.

**Applicability.** All apps.

**Rationale.** The platform runs one Worker per app for data, provisioned and rebuilt by the platform (the bundle comes from `packages/data-worker`, not from the app). There is no trusted app-code execution surface today (#148) and no Pro cron yet (#123). An app-deployed Worker is outside the registry, unreachable by mediation, and drift by definition ([PAS-STACK-004](./stack.md#pas-stack-004)).

**Recommended implementation.** Express rules as SQL predicates ([PAS-DATA-008](#pas-data-008)); split multi-step logic into batch actions; for what SQL cannot do, keep the client's result *advisory* (display, not authority) until a platform execution path exists.

**Conforming example.**

```json
{ "name": "claim_result", "operation": "execute", "requires_auth": true,
  "sql": "UPDATE games SET claimed_result = :result, claimed_by = :__user_id, claimed_at = :__now WHERE id = :id AND status = 'active' AND (white_id = :__user_id OR black_id = :__user_id)",
  "params": { "id": { "type": "string" }, "result": { "type": "string" } } }
// the claim is recorded as a claim; a coach confirms — the client is not the authority
```

**Non-conforming example.**

```text
app/worker/src/index.ts      + wrangler.toml with [[d1_databases]]   ← an app-owned Worker
"deploy": "wrangler deploy"
```

**Evidence.** Configuration: `wrangler.toml`, `wrangler` dependency, Worker source directories in the app repo; Source: client-computed verdicts written as authoritative state.

**Remediation.** Delete the Worker; move rules into action SQL; mark client verdicts as claims pending confirmation; file the gap against the platform.

**Tests.** The repo has no Worker; every server-side behaviour maps to an `mcp.json` action.

**Supporting links.** [Architecture — worker-to-worker pattern](../architecture.md#worker-to-worker-pattern), [MCP app tools — limits and roadmap](../mcp-app-tools.md#limits-roadmap), [PAS-STACK-004](./stack.md#pas-stack-004).

### PAS-DATA-015 — Worker-to-worker calls on a platform zone use service bindings {#pas-data-015}

**Severity:** Critical · **Verification:** Manual · **Enforcement:** none (recommended) · **Since:** 1.3

**Rule.** Any Worker code an app team runs on `proappstore.online` (today: contributions to platform workers; later: Pro custom Workers) MUST reach another Worker on the same zone through a `[[services]]` binding (`env.NAME.fetch`), including its own route-mapped hostname. It MUST NOT `fetch()` a route-mapped hostname such as `api.proappstore.online` from inside a Worker. Workers custom domains (`data-<app>` hostnames) and Pages origins are the only same-zone targets reachable by plain `fetch`.

**Applicability.** Worker code operated by the app team on a platform zone. For a static app with no Worker, record `not-applicable`.

**Rationale.** Cloudflare does not route a Worker's subrequest to another Worker whose hostname is a *route* on the same zone; the request silently goes to the origin and fails. On 2026-07-10 that took every app's data plane down: the data worker's authorization call to the API never arrived and the fail-closed check returned 403 to everyone.

**Recommended implementation.** Declare the binding in `wrangler.toml` and call `env.API.fetch(new Request('https://api.proappstore.online/…'))`. For self-re-entry use a `SELF` binding.

**Conforming example.**

```text
[[services]]
binding = "API"
service = "proappstore-api"
# env.API.fetch("https://api.proappstore.online/v1/apps", { headers })
```

**Non-conforming example.**

```ts
const res = await fetch('https://api.proappstore.online/v1/apps', { headers })   // same-zone route: silently misrouted
```

**Evidence.** Configuration: `wrangler.toml` `[[services]]`; Source: `fetch(` to `*.proappstore.online` hostnames that are routes (`api`, `admin`, `mcp`, `agents`, `kb`, `docs`).

**Remediation.** Add the binding; replace the fetch; redeploy; verify the call arrives (tail the target worker).

**Tests.** A tail of the target worker shows the request; the caller no longer gets a fail-closed 403/522.

**Supporting links.** [Architecture — same-zone subrequests](../architecture.md#same-zone-subrequests-service-bindings-are-mandatory).

### PAS-DATA-016 — The data worker is reached only through the SDK, per app, with no shared secrets in the app {#pas-data-016}

**Severity:** Critical · **Verification:** Manual · **Enforcement:** automated — the data worker accepts raw SQL only from team roles and prepared SQL only with the platform `INTERNAL_TOKEN`; each app has its own D1 and its own worker · **Since:** 1.3

**Rule.** The app MUST reach its data plane only through the SDK (`app.actions`, `app.db`) — never by constructing `data-<app>.proappstore.online`, `/.pas/data/*` or a `workers.dev` URL itself, and never with an `X-Internal-Token`. It MUST NOT attempt to read another app's data worker or D1. A data-plane 401 or 5xx MUST be handled as a data error ([PAS-AUTH-006](./auth.md#pas-auth-006)).

**Applicability.** Apps with a D1 database.

**Rationale.** The internal token proves "a platform worker is calling", not which app or user; a copy in an app is a platform-wide credential leak. One D1 per app is the tenancy boundary between apps; the executor routes to the app's own worker by app id, and nothing in the SDK addresses another app.

**Recommended implementation.** Nothing to build: use the SDK. Treat the data worker's hostname as an implementation detail.

**Conforming example.**

```ts
const { rows } = await app.actions.call('list_tasks', { limit: 50 })
```

**Non-conforming example.**

```ts
await fetch('https://data-other-app.proappstore.online/query', { headers: { 'X-Internal-Token': TOKEN }, body })
```

**Evidence.** Source: `grep -rn "data-.*proappstore.online\|/.pas/data\|workers.dev\|X-Internal-Token" web/src`.

**Remediation.** Remove the direct calls and any token; use the SDK.

**Tests.** Greps return nothing; the app works with no knowledge of its data worker's hostname.

**Supporting links.** [Architecture — database](../architecture.md#database), [Authorization model — trust boundaries](../authorization-model.md#trust-boundaries-that-are-not-roles), [App actions security — low-level raw SQL](../app-actions-security.md#low-level-raw-sql).

### PAS-DATA-017 — Rooms carry ephemeral, untrusted fan-out; durable state goes through actions {#pas-data-017}

**Severity:** High · **Verification:** Manual · **Enforcement:** automated — the room Durable Object enforces 32 peers/room (a 33rd join is closed with code 4429 `room_full`; there is no per-app room cap and no LRU), 100 msg/s/peer, 4 KB/message, and clears the storage of a room only after 24 h with no peers — a room with live peers is never evicted · **Since:** 1.3

**Rule.** `app.rooms` MUST be used only for presence, cursors, chat-light, signalling and low-state multiplayer. Anything that must survive a reload, be seen by a user who was not connected, or be authoritative MUST be written through a registered action; a room message MUST be treated as untrusted input from its `from` peer and MUST NOT be used to grant, score or settle anything without an action guard.

**Applicability.** Apps using `app.rooms`.

**Rationale.** Rooms are Durable-Object fan-out with no persistence and no server-side validation of message content. A peer can send any payload; the only trustworthy field is `from`, which the platform sets from the session. Server-authoritative game state needs the Pro rooms capability, which static apps do not yet have.

**Recommended implementation.** Send small deltas; on receive, validate shape and ignore anything outside the peer's authority; persist outcomes with a batch action guarded by `:__user_id`; reconnect on `onConnectionState('closed')`.

**Conforming example.**

```ts
room.onMessage<Move>((m) => { if (isMove(m.data) && m.from.uid === opponentId) applyLocally(m.data) })
await app.actions.call('record_move', { game_id, san })                 // authoritative write, guarded in SQL
```

**Non-conforming example.**

```ts
room.onMessage((m) => { if (m.data.type === 'you_won') setWinner(m.data.winner) })   // trusts the payload
room.send({ type: 'set_admin', uid: me })                                                 // authority over a socket
```

**Evidence.** Source: `onMessage` handlers — validation and what they mutate; whether outcomes are also written via actions; `send` payload sizes.

**Remediation.** Add validation; move authority to actions; drop payloads that carry grants.

**Tests.** A crafted message from a second peer (devtools) cannot change persisted state; the corresponding action rejects it. **Cross-tenant negative test:** with a second account that is not a member of the tenant, call the action with the first tenant's ids; expect no rows (query) or `meta.changes === 0` (execute/batch).

**Supporting links.** [SDK overview — surfaces](../sdk-overview.md#surfaces), [PAS-STACK-013](./stack.md#pas-stack-013).

### PAS-DATA-018 — Writes are idempotent under retry {#pas-data-018}

**Severity:** High · **Verification:** Manual · **Enforcement:** none (recommended) · **Since:** 1.3

**Rule.** Every write action that a client may repeat — after a timeout, a reload, a double click — MUST be safe to run twice: inserts use a client-supplied id with a `UNIQUE`/primary-key constraint (or `INSERT OR IGNORE`), state changes guard on the current state, and the UI reads `meta.changes` rather than assuming success. The app MUST NOT implement blind client-side retries of non-idempotent actions.

**Applicability.** Apps with writes.

**Rationale.** The SDK does not retry; the network does. A `create_order` with `:__uuid` executed twice creates two orders; an `increment_balance` executed twice pays twice. Idempotency is a property of the statement, not of the client.

**Recommended implementation.** Generate the id on the client (`crypto.randomUUID()`) and pass it as a param; use `INSERT OR IGNORE` or a `UNIQUE` index; guard transitions on state; disable the button until the call resolves.

**Conforming example.**

```json
{ "name": "create_order", "operation": "execute", "requires_auth": true,
  "sql": "INSERT OR IGNORE INTO orders (id, user_id, total, created_at) VALUES (:id, :__user_id, :total, :__now)",
  "params": { "id": { "type": "string" }, "total": { "type": "integer" } } }
```

**Non-conforming example.**

```json
{ "name": "create_order", "operation": "execute", "requires_auth": true,
  "sql": "INSERT INTO orders (id, user_id, total, created_at) VALUES (:__uuid, :__user_id, :total, :__now)",
  "params": { "total": { "type": "integer" } } }   // every retry is a new order
```

**Evidence.** Configuration: `INSERT` statements using `:__uuid` for rows a user creates deliberately; `UPDATE` without state guards; Source: retry loops around `actions.call`.

**Remediation.** Switch to client ids with constraints; add state guards; remove blind retries.

**Tests.** Calling each create/transition action twice with the same params yields one row / one transition (`meta.changes` 1 then 0).

**Supporting links.** [App actions security — batch tools](../app-actions-security.md#batch-tools-atomic-multi-statement-actions), [PAS-DATA-008](#pas-data-008).

### PAS-DATA-019 — Background work is an idempotent, bounded, privileged action — and the absence of cron is recorded, not hidden {#pas-data-019}

**Severity:** Medium · **Verification:** Manual · **Enforcement:** none (recommended) · **Since:** 1.3

**Rule.** Periodic maintenance (reaping stale rows, closing expired items, recomputing summaries) MUST be implemented as a registered action that is idempotent, bounded by `LIMIT`, scoped, gated to a privileged app role, and safe to run concurrently; it MAY be triggered from a privileged client session. The app MUST NOT rely on a browser timer, a third-party scheduler, or an app-owned Worker as a substitute for scheduled execution, and MUST document that the sweep is client-triggered until Pro cron exists.

**Applicability.** Apps with time-based state.

**Rationale.** There is no scheduled execution for static apps yet (#123). A sweep that runs when a coach opens the page is the honest interim; a `setInterval` in a background tab is not a scheduler, and an external cron hitting the app needs a credential the app must not hold.

**Recommended implementation.** `reap_stale_games`: `UPDATE … WHERE status = 'active' AND updated_at < :__now - :idle_ms AND org_id IN (…caller's orgs…) LIMIT`-bounded via a sub-select; call it from the staff view on load; log what it changed.

**Conforming example.**

```json
{ "name": "reap_stale_games", "operation": "execute", "requires_auth": true, "auth": { "app_roles": ["coach"] },
  "sql": "UPDATE games SET status = 'abandoned', updated_at = :__now WHERE id IN (SELECT id FROM games WHERE status = 'active' AND updated_at < :__now - 900000 AND org_id IN (SELECT org_id FROM org_members WHERE user_id = :__user_id AND role = 'coach') LIMIT 100)",
  "params": {} }
```

**Non-conforming example.**

```ts
setInterval(() => app.actions.call('reap_stale_games'), 60_000)     // a tab is not a scheduler
// or: an external cron service calling a public action that mutates
```

**Evidence.** Configuration: sweep actions — guards, `LIMIT`, role; Source: timers or external triggers; README noting the interim.

**Remediation.** Rewrite the sweep as above; remove timers/external triggers; document.

**Tests.** Running the sweep twice in a row changes rows only once; a `member` cannot call it; the README states how it is triggered.

**Supporting links.** [MCP app tools — limits and roadmap](../mcp-app-tools.md#limits-roadmap), [PAS-DATA-018](#pas-data-018), [PAS-AUTH-019](./auth.md#pas-auth-019).

### PAS-DATA-020 — Caches never outlive authorization {#pas-data-020}

**Severity:** Medium · **Verification:** Manual · **Enforcement:** none (recommended) · **Since:** 1.3

**Rule.** The app MAY cache action results in memory for the current session and SHOULD revalidate on focus and after its own writes. It MUST NOT persist scoped rows in `localStorage`, IndexedDB, Cache Storage or a service worker beyond the session, MUST clear all cached data on sign-out and on `onChange(null)`, and MUST NOT serve one user's cached rows to another account on the same device.

**Applicability.** Apps that cache data.

**Rationale.** A cache is a copy of rows that were authorised at fetch time; authorisation can be revoked, and the device can change hands. Chess Academy's stale PWA shell showed how long a cached artefact can outlive the session that produced it.

**Recommended implementation.** Keep caches in component or store state keyed by `user.id`; use `app.counters` for hot aggregates instead of caching computed counts; let the SDK's `Clear-Site-Data` on logout do its job by not caching outside the session.

**Conforming example.**

```ts
const cache = useRef(new Map<string, Task[]>())
app.auth.onChange((u) => { if (!u) cache.current.clear() })
```

**Non-conforming example.**

```ts
localStorage.setItem(`tasks:${orgId}`, JSON.stringify(rows))     // survives sign-out and account switch
```

**Evidence.** Source: persistent storage writes of action results; service-worker runtime caching rules for `/.pas/*`; cache invalidation on `onChange(null)`.

**Remediation.** Move caches to memory; exclude `/.pas/*` from service-worker caching; clear on sign-out.

**Tests.** After sign-out and sign-in as a second account on the same browser, no first-account rows are visible; `/.pas/*` responses are never served from Cache Storage.

**Supporting links.** [PAS-AUTH-007](./auth.md#pas-auth-007), [PAS-STACK-009](./stack.md#pas-stack-009), [UI chapter](./ui.md).

### PAS-DATA-021 — Data failures are surfaced and logged, never swallowed into an empty result {#pas-data-021}

**Severity:** Medium · **Verification:** Manual · **Enforcement:** none (recommended) · **Since:** 1.3

**Rule.** Every `actions.call`, `db.*`, `kv`, `storage` and `rooms` failure MUST reach an explicit error state in the UI and `app.logs`. The app MUST NOT catch a failed read and render it as an empty list, a zero count, or a default, and MUST distinguish not-signed-in (401), forbidden (403), bad input (4xx) and platform failure (5xx) in what it tells the user.

**Applicability.** All apps.

**Rationale.** An outage rendered as "no items" is indistinguishable from success; the platform's own MCP tool had exactly this bug (#152). The SDK already logs action failures with name and status; the UI has to stop hiding them.

**Recommended implementation.** Wrap calls in a result type; render `error` distinctly with retry; keep `app.logs` auto-capture on and add `app.logs.warn` at handled failures.

**Conforming example.**

```ts
try { setState({ kind: 'ok', rows: (await app.actions.call<{ rows: Task[] }>('list_tasks')).rows }) }
catch (e) { setState({ kind: 'error', message: String(e) }); app.logs.warn('tasks', 'list failed', { error: String(e) }) }
```

**Non-conforming example.**

```ts
const rows = await app.actions.call('list_tasks').catch(() => ({ rows: [] }))   // outage == empty list
```

**Evidence.** Source: `.catch(() => [])`, `?? []`, `catch {}` around data calls; error states in list components.

**Remediation.** Add error states; remove empty-result fallbacks; log.

**Tests.** With the data worker unreachable (simulated), every list shows an error with retry, and `app.logs` has the entries.

**Supporting links.** [SDK overview — monitoring](../sdk-overview.md#monitoring), [PAS-AUTH-008](./auth.md#pas-auth-008), [PAS-STACK-021](./stack.md#pas-stack-021).

### PAS-DATA-022 — The repository carries cross-tenant negative tests for its actions {#pas-data-022}

**Severity:** High · **Verification:** Manual · **Enforcement:** none (recommended) · **Since:** 1.3

**Rule.** The app MUST include automated tests that, for every scoped action, exercise it as a second user or tenant against the first's ids and assert no rows / no changes, plus positive tests for the intended caller. Tests MUST run in CI (`pnpm test` or the `e2e/` Playwright suite) and MUST be updated when `mcp.json` changes.

**Applicability.** Apps with registered actions.

**Rationale.** The registration lint proves `:__user_id` appears; only a negative test proves it scopes. Chess Academy's write-action audit found actions that were gated in the UI and open on the server — the class a negative test catches on every deploy.

**Recommended implementation.** Unit-level: load `mcp.json`, apply `migrations.json` to an in-memory SQLite, seed fixture rows for two tenants, and execute each statement with `:__user_id` bound to each fixture user in turn. Tests that mock `app.actions.call` (the SDK-mocked helper tests some apps carry) exercise the UI wrapper only and do not count. End-to-end: an `e2e/` spec signed in as the fixture account asserting a 403 or empty result for foreign ids.

**Conforming example.**

```ts
it('list_tasks never returns another org\'s rows', async () => {
  const rows = await runAction('list_tasks', { org_id: ORG_B }, { userId: USER_IN_A })
  expect(rows).toHaveLength(0)
})
it('close_task changes nothing for a non-manager', async () => {
  const { changes } = await runAction('close_task', { id: TASK_A }, { userId: MEMBER_NOT_MANAGER })
  expect(changes).toBe(0)
})
```

**Non-conforming example.**

```text
web/src/**/*.test.ts: renders, formats dates — no test touches mcp.json
```

**Evidence.** Process: test files referencing `mcp.json` tool names; CI workflow running them; coverage of every tool with a scoping predicate.

**Remediation.** Add the manifest test harness; write one negative test per scoped action; wire into CI.

**Tests.** CI runs the suite; removing a scoping predicate from any action makes a test fail.

**Supporting links.** [App actions security — guard idioms](../app-actions-security.md#guard-idioms-the-sql-is-the-security-boundary), [Operations chapter](./ops.md), [PAS-DATA-007](#pas-data-007).
