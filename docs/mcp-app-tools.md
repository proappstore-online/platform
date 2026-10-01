# MCP app tools and auth

> **App requirements** for registered actions — explicit auth metadata, declared parameters, row scoping, batch atomicity, public queries — are clauses in the [Application Standard — Data, actions, and Workers](./standard/data.md); MCP-specific expectations are [PAS-STACK-023](./standard/stack.md#pas-stack-023). This page is the mechanism those clauses cite.

ProAppStore is **AI-first**: every app you publish can expose its own tools to
the platform's remote MCP server, so an external AI (Claude Code, Cursor, the
Anthropic API, …) can call your app's data operations directly — list rows,
create records, run a query — the same way the UI does.

This is the per-app counterpart to the [agent-customization](./agent-customization)
story: agents *build* your app, and MCP makes the finished app *callable*.

## Current implementation

```
your app repo                 platform backend              platform MCP server
┌───────────────┐  publish    ┌──────────────┐ GET /v1/apps/ ┌────────────────────┐
│  mcp.json     ├────────────►│  app_tools   ├──:id/tools───►│ mcp.proappstore    │
│  (manifest)   │  registers  │  (D1 table)  │               │ .online/mcp/apps/<app_id> │
└───────────────┘             └──────────────┘               └──────────┬─────────┘
                                                                        │ <tool_name>
                                          data-<app>.proappstore ◄──────┘  (actions → D1)
```

1. Your app declares tools in an **`mcp.json`** manifest at the repo root.
2. On publish, those tools are registered to the backend `app_tools` table.
3. The platform MCP server exposes an app's tools on that app's own endpoint,
   `/mcp/apps/<app_id>`, under their manifest names — all of them for a small
   manifest, a resident core plus discovery for a large one (see
   [Large manifests](#large-manifests-progressive-disclosure)). The shared
   `/mcp` endpoint does not register app tools. It offers
   `list_app_tools(app_id)` and `call_app_tool(app_id, tool, params)` to reach
   any app's tools without loading them all.
4. When called, the MCP server sends the request to the platform action
   executor (`/v1/apps/:appId/actions/:name`) with the caller's session. The
   platform validates auth, checks role metadata, injects magic params, and
   forwards prepared SQL to your app's data worker
   (`data-<app>.proappstore.online`).

Apps do **not** need to implement their own MCP server for normal D1-backed app
actions. The app-owned surface is the `mcp.json` action manifest. A local MCP
server can still be useful as a development bridge, but the platform MCP server
is the canonical integration point.

The same registered manifest is also the migration target for browser app data:
PAS exposes `POST /v1/apps/:appId/actions/:name`, and the SDK exposes
`app.actions.call(name, params)`. Browser calls are authenticated, prepared by
the platform, checked against declared roles, and then forwarded to the app data
worker. That replaces ad hoc browser raw SQL for user-specific or role-specific
reads and writes.

## Authentication model

Most app-data tools should be authenticated. In the current production manifest
format, authenticated app-data auth is represented by:

```json
{ "requires_auth": true }
```

When an authenticated MCP connection calls a tool, the platform MCP server
forwards the call to the platform action executor
(`/v1/apps/:appId/actions/:name`) with the caller's PAS session token and user
id. The executor injects magic placeholders such as `:__user_id`, `:__now`, and
`:__uuid`, then forwards the prepared, role-checked SQL to the app's data worker
over the trusted `X-Internal-Token` path — so the call runs for any
authenticated user, not just the app's owner. (The caller's bearer token is
forwarded too, for compatibility with un-redeployed data workers, but the data
worker authorizes the executor via the internal token.)

For app tools, authentication answers "who is this user?" Authorization still
belongs in the tool SQL or the app's data model. Scope reads and writes with
`:__user_id` and app-specific permission checks, for example:

```sql
WHERE EXISTS (
  SELECT 1 FROM memberships
  WHERE org_id = :org_id
    AND user_id = :__user_id
    AND role = 'manager'
)
```

This pattern prevents a caller from passing someone else's `org_id` and reading
or mutating data they do not manage.

## Roles and permissions

PAS provides reusable roles through the SDK (`app.roles`). Those roles are the
right abstraction for coarse permission gates such as owner, moderator, editor,
viewer, manager, or custom app roles.

> These are **app roles** — one of PAS's three distinct role scopes (platform /
> team / app). App roles govern *your app's own users*; they are separate from
> team roles (who may build/deploy the app) and platform roles (ProAppStore
> standing). Understand why — and which check to use — in the
> [Authorization Model](./authorization-model.md).

The `auth.platform_roles` and `auth.app_roles` fields are enforced by the
shared platform action executor used by both browser SDK calls and MCP app
tools. In all cases, keep row-level checks in SQL:

- Use `:__user_id` in SQL and check app-domain membership tables, such as an
  `org_id` membership row.
- Use app data that mirrors PAS roles if the tool needs role-specific access.
- Keep all tools that touch user or app data marked with `requires_auth: true`.

Add explicit auth metadata to gate a tool by role, for example:

```json
{
  "auth": {
    "required": true,
    "platform_roles": ["creator"],
    "app_roles": ["manager"]
  }
}
```

That metadata is not a substitute for row-level checks. A user can have a
`manager` role somewhere and still not manage the specific organisation named
by `:org_id`. Use role metadata for early rejection and better UX; use SQL
scoping for the final data permission check.

## The `mcp.json` manifest

```json
{
  "tools": [
    {
      "name": "list_items",
      "description": "List the signed-in user's items, newest first",
      "operation": "query",
      "sql": "SELECT id, title, created_at FROM items WHERE user_id = :__user_id ORDER BY created_at DESC LIMIT :limit",
      "params": { "limit": { "type": "integer", "default": 50, "max": 200, "optional": true } },
      "requires_auth": true
    },
    {
      "name": "create_item",
      "description": "Create an item for the signed-in user",
      "operation": "execute",
      "sql": "INSERT INTO items (id, user_id, title, created_at) VALUES (:__uuid, :__user_id, :title, :__now)",
      "params": { "title": { "type": "string" } },
      "requires_auth": true
    },
    {
      "name": "create_project_with_membership",
      "description": "Create a project and add the signed-in user as owner",
      "operation": "batch",
      "statements": [
        "INSERT INTO projects (id, name, owner_id, created_at) VALUES (:id, :name, :__user_id, :__now)",
        "INSERT INTO project_members (project_id, user_id, role, created_at) VALUES (:id, :__user_id, 'owner', :__now)"
      ],
      "params": { "id": { "type": "string" }, "name": { "type": "string" } },
      "requires_auth": true
    }
  ]
}
```

Each tool is either one parameterized SQL statement or an atomic write batch
against your app's own D1 tables.

| Field | Meaning |
|-------|---------|
| `name` | lowercase `a-z0-9_`. Exposed under this name on `/mcp/apps/<app_id>`. |
| `description` | what the tool does (the model reads this to decide when to call it). |
| `operation` | `query` → a single `SELECT` (returns rows). `execute` → a single `INSERT`/`UPDATE`/`DELETE`. `batch` → multiple write statements in one D1 transaction. `verify` → a `SELECT` whose rows are checked by a platform-vetted verifier, then optional writes bound to the verdict (see [Verify actions](#verify-actions)). |
| `sql` | required for `query` and `execute`. Bind values with `:name` placeholders; **no semicolons**, one statement only. |
| `statements` | required for `batch`, max 25 statements. Batch tools use `statements`, not `sql`; each member is validated like an `execute` statement. Optional on `verify` (the writes that run after verification, same limits). |
| `verifier` | required for `verify`: the id of the platform verifier that runs on the rows of `sql`. Currently `chess.replay`. |
| `params` | declared inputs: `{ "name": { "type", "description?", "optional?", "default?", "max?" } }`. Types: `string`, `integer`, `number`, `boolean`. |
| `requires_auth` | explicit `true` or `false`. `true` requires a session token. `false` is allowed only for constrained public `query` tools. SQL using `:__user_id` must require auth. |
| `cache_ttl` | optional integer, 1–300 seconds, **public `query` tools only**. The platform caches a `200` response at the edge for this long, keyed by the prepared statement and params, and serves it with `Cache-Control: public, max-age=<ttl>`. Registration rejects it on any tool that requires auth. See [Public actions: rate limit and cache](#public-actions-rate-limit-and-cache). |
| `schedule` | optional platform schedule for an `execute` or `batch` action: `{ "cron": "*/15 * * * *", "params": { ... } }`. See [Scheduled actions](#scheduled-actions). |
| `core` | optional boolean. On a large manifest (see below) `core: true` keeps this tool pre-loaded on the app's MCP session instead of deferring it to discovery. Ignored on a small manifest, where everything is pre-loaded anyway. |

Use `requires_auth: true` for writes and user-scoped reads. Deliberately public
read-only queries can use `requires_auth: false`, but registration constrains
them: they must be `query` tools, must not reference `:__user_id`, must not
declare roles, and must include a literal `LIMIT 500` or lower.

### Public actions: rate limit and cache

Any caller can reach a public action, so the platform bounds what one caller can
cost the app's D1 and the platform's (#211):

- **Rate limit.** Anonymous calls to `POST /v1/apps/:appId/actions/:name` are
  limited to **120 per 60 seconds per (app, client IP)**. The next call returns
  `429` with `Retry-After: 60`, before any database read. A call carrying a valid
  session is not limited. A bearer that does not verify counts as anonymous.
  Platform service-binding calls (the host's tenant-meta lookup) are exempt.
- **Cache.** Without `cache_ttl`, every response is `Cache-Control: no-store`.
  With it, identical params within the TTL are answered from the edge cache
  without a data-worker request. Only `200` responses are stored. Cached rows
  can be up to `cache_ttl` seconds stale, so declare it only on data that may be.

### Magic placeholders

These are injected by the platform — **do not** declare them in `params`:

| Placeholder | Resolves to |
|-------------|-------------|
| `:__user_id` | the calling user's id (forces `requires_auth: true`). Scope per-user rows with `WHERE user_id = :__user_id`. |
| `:__now` | current time, ms since epoch. |
| `:__uuid` | a fresh UUID (use for inserting primary keys). |
| `:__verify_<output>` | on a `verify` tool's `statements` only: an output of the verifier (`:__verify_over`, `:__verify_result`, …). Never accepted from the client. |

## Validation rules (enforced at register time)

- `query` / `execute` tools use `sql`; `batch` tools use `statements`; `verify` tools use `sql` (a `SELECT`) plus an optional `statements` (writes) and a known `verifier`.
- SQL must start with `SELECT` / `INSERT` / `UPDATE` / `DELETE`.
- No DDL (`CREATE`, `DROP`, `ALTER`, `PRAGMA`, ...) and no semicolons.
- `UPDATE` and `DELETE` **must** have a `WHERE` clause.
- `query` must use `SELECT`; `execute` and each `batch` member must not.
- Every `:param` in the SQL must be declared in `params` (or be a magic placeholder).
- `requires_auth` must be explicitly `true` or `false`.
- `requires_auth: false` is only allowed for public `query` tools with no
  `:__user_id`, no roles, and a literal `LIMIT 500` or lower.
- `cache_ttl` is only allowed on those public `query` tools, as an integer from 1 to 300.
- Every statement of a `requires_auth: true` tool — reads included — must
  reference `:__user_id` (own rows, or an `EXISTS` on a membership table), or the
  tool must declare `"auth": { "caller_unscoped": { "reason": "..." } }` with a
  non-empty reason (shared catalog data, one-time codes). Never accept the
  caller's id as a client param.
- Max 500 tools per app (the rejection names both counts: `received 537, max 500`).
  From 400 tools registration still succeeds but warns with the count, the cap
  and the headroom left (see [Budgeting for larger apps](#budgeting-for-larger-apps)).
- Tool names starting with `api_` are reserved for console-defined endpoints.
- `verify` tools must `requires_auth: true`; `:__verify_*` may appear only in
  their `statements`, only for outputs the named verifier declares, never in
  the input `sql`.

A manifest that violates any rule is rejected — the whole batch fails, so a bad
tool never half-registers.

## Scheduled actions

An `execute` or atomic `batch` action can run unattended on the platform's
five-minute UTC scheduler. This is the bounded SQL alternative to app-owned
Workers for reapers, expiries and summary maintenance; it is not arbitrary
per-app compute.

```json
{
  "name": "reap_stale_games_all",
  "description": "Close stale active games across active tournaments",
  "operation": "execute",
  "sql": "UPDATE games SET status = 'abandoned', updated_at = :__now WHERE id IN (SELECT id FROM games WHERE status = 'active' AND updated_at < :__now - :idle_ms LIMIT 100)",
  "params": { "idle_ms": { "type": "integer" } },
  "requires_auth": true,
  "auth": { "caller_unscoped": { "reason": "Scheduled maintenance has no human caller; rows are bounded by stale state." } },
  "schedule": { "cron": "*/15 * * * *", "params": { "idle_ms": 1800000 } }
}
```

Registration validates all of the following:

- Five numeric cron fields in UTC (`*`, lists, ranges and steps), with no
  interval below five minutes.
- Only `execute` and `batch`; `requires_auth: true`; a non-empty
  `auth.caller_unscoped.reason`. The executor binds `:__user_id` to the
  synthetic `system:schedule`, which matches no app user. Never use a human
  role guard for a scheduled action.
- `schedule.params` is an object of declared parameters only and passes the
  exact type/default validation used at runtime. There is no caller input.
- At most five scheduled actions per app.

**A scheduled action is not callable over HTTP or MCP.** `POST
/v1/apps/:appId/actions/<name>` answers `403 scheduled actions run only on the
platform scheduler` to every caller (session users, app tokens, the owner and
platform admins alike), and MCP sessions neither list nor register it. Its
`caller_unscoped` reason is only true for the schedule's fixed params. For
manual runs, register a separate user-invoked action with a role guard.

Each due minute is first written and atomically claimed in the platform D1
before the prepared action reaches the app data worker. Duplicate/overlapping
ticks cannot run it twice; a stale claim is recovered as a failure. Missed
minutes are never backfilled, and a still-claimed prior run suppresses the
next due run rather than stacking work. Five consecutive failures disable that
action until its manifest is re-registered and create an app alert.

Owners can inspect `GET /v1/apps/:appId/scheduled-runs` (optional `status`,
`limit`) or the MCP `list_scheduled_runs` tool. Registration/deploy logs print
the action name and UTC cron. Run history is kept for 30 days
(#27): the daily prune deletes runs that were due more than 30 days ago, except
a run still `claimed`.

## Verify actions

Actions are SQL, and SQL cannot replay a chess game. A `verify` action is the
trusted path for the logic SQL cannot express: the platform runs a **vetted,
platform-owned verifier module** — not app code — between a scoped read and an
optional write, so a stored fact can be derived on the server instead of
trusted from a client's claim.

```json
{
  "name": "claim_game_over",
  "description": "Record the result of my game only if replaying its moves proves it is over",
  "operation": "verify",
  "verifier": "chess.replay",
  "sql": "SELECT moves FROM games WHERE id = :game_id AND (white_id = :__user_id OR black_id = :__user_id)",
  "statements": [
    "UPDATE games SET status = 'finished', result = :__verify_result, end_reason = :__verify_reason, finished_at = :__now WHERE id = :game_id AND (white_id = :__user_id OR black_id = :__user_id) AND :__verify_over = 1"
  ],
  "params": { "game_id": { "type": "string" } },
  "requires_auth": true
}
```

How a call runs:

1. `sql` runs on the app's data worker with the usual bindings (`:params`,
   `:__user_id`) — it is the caller-scoped read that selects the input rows.
2. The rows go to the verifier named by `verifier`, which runs inside the
   platform API worker. Verifiers are pure and deterministic (no I/O, no clock,
   no randomness), bounded (at most 5 000 input rows, plus the module's own
   cap), and produce a flat record of scalar outputs.
3. If the verifier **completed** (`ok: true`), `statements` run as ONE D1
   transaction with every output bound as `:__verify_<output>`; the SQL guards
   on the verdict (`AND :__verify_over = 1`). If it could not run (`ok: false`:
   no row, missing column, malformed data), nothing is written.

The response is `{ ok, verifier, output, error?, writes? }` — `output` holds
every declared output (`null` where not applicable), `writes` the per-statement
`meta` when statements ran. A verify tool with no `statements` is a read-only
check (a read personal app token may call it; one with statements needs a
`write` token). The MCP server treats every verify tool as mutating.

### Verifiers

| Id | Input rows (from `sql`) | Outputs |
|----|-------------------------|---------|
| `chess.replay` | one row with a `moves` column (JSON array or whitespace-separated SAN/UCI), or one row per move in a `move` / `san` / `uci` column in `ORDER BY` order; optional `fen` on the first row sets the start position; ≤ 1 000 plies | `legal` (bool), `illegal_index` (int|null), `illegal_move` (string|null), `ply` (int), `over` (bool), `result` (`1-0` / `0-1` / `1/2-1/2` / null), `reason` (`checkmate` / `stalemate` / `insufficient_material` / `threefold_repetition` / `fifty_moves` / null), `turn` (`w`/`b`), `in_check` (bool), `fen` (string) |

Verifiers live in `packages/backend/src/lib/verifiers/` and are added by the
platform, never by an app; an id the platform does not know is rejected at
registration. Propose a new one in a platform issue with the input contract,
the outputs and why SQL cannot do it.

## Full-text search (FTS5)

A deploy migration may create an SQLite **FTS5** virtual table (#206); no other
virtual table module is accepted. Seed rows may contain any text: the
additive-only lint checks keywords in code, never inside string literals.

```json
{ "name": "0007_products_fts", "sql": "CREATE VIRTUAL TABLE IF NOT EXISTS products_fts USING fts5(product_id UNINDEXED, title, body)" }
```

**Keep the index in sync in your batch actions, not with triggers.** A trigger
that updates or deletes is refused by the deploy lint (an `AFTER UPDATE` event
included), because the automated path is additive-only. Write the row and its
index entry in the same atomic batch, scoped like any other statement. A
correlated id must be a client-supplied param, because `:__uuid` is generated
separately for each statement.

```json
[
  {
    "name": "create_product", "description": "Create a product and index it", "operation": "batch",
    "statements": [
      "INSERT INTO products (id, owner_id, title, body, created_at) VALUES (:id, :__user_id, :title, :body, :__now)",
      "INSERT INTO products_fts (product_id, title, body) SELECT id, title, body FROM products WHERE id = :id AND owner_id = :__user_id"
    ],
    "params": { "id": { "type": "string" }, "title": { "type": "string" }, "body": { "type": "string" } },
    "requires_auth": true
  },
  {
    "name": "update_product", "description": "Edit a product and re-index it", "operation": "batch",
    "statements": [
      "UPDATE products SET title = :title, body = :body, updated_at = :__now WHERE id = :id AND owner_id = :__user_id",
      "DELETE FROM products_fts WHERE product_id = :id AND EXISTS (SELECT 1 FROM products WHERE id = :id AND owner_id = :__user_id)",
      "INSERT INTO products_fts (product_id, title, body) SELECT id, title, body FROM products WHERE id = :id AND owner_id = :__user_id"
    ],
    "params": { "id": { "type": "string" }, "title": { "type": "string" }, "body": { "type": "string" } },
    "requires_auth": true
  },
  {
    "name": "search_products", "description": "Full-text product search", "operation": "query",
    "sql": "SELECT p.id, p.title FROM products_fts JOIN products p ON p.id = products_fts.product_id WHERE products_fts MATCH :q ORDER BY rank LIMIT 20",
    "params": { "q": { "type": "string" } },
    "requires_auth": false
  }
]
```

**D1 cannot export a database that contains a virtual table.** Cloudflare's
workaround is to drop the virtual tables, export, then recreate them. The
platform does not export app databases, but an owner running
`wrangler d1 export` must do this first. The FTS5 index is derived data, so it
can be rebuilt from the base table.

## Link previews and sitemap (`page_meta`, `sitemap`)

Link unfurlers (LinkedIn, Slack, WhatsApp) and non-rendering crawlers never run
your JavaScript, so a title set by the SPA is invisible to them. Declare which
paths have their own preview, and the host rewrites `<title>`, `og:title`,
`og:description` and `og:image` for them from one of your **public** query
actions (#210). Both keys sit at the top level of `mcp.json`, next to `tools`,
and are registered and replaced with them.

```json
{
  "tools": [
    {
      "name": "public_product_meta", "description": "Product link preview", "operation": "query",
      "sql": "SELECT p.title, p.summary AS description, p.photo_url AS image_url FROM products p WHERE p.id = :id AND p.status = 'live' LIMIT 1",
      "params": { "id": { "type": "string" } },
      "requires_auth": false, "cache_ttl": 300
    },
    {
      "name": "public_sitemap_urls", "description": "Sitemap URLs", "operation": "query",
      "sql": "SELECT '/p/' || id AS path, updated_at FROM products WHERE status = 'live' AND '/p/' || id > :cursor ORDER BY path LIMIT 500",
      "params": { "cursor": { "type": "string", "optional": true, "default": "" } },
      "requires_auth": false, "cache_ttl": 300
    }
  ],
  "page_meta": [{ "path": "/p/:id", "action": "public_product_meta", "param": "id" }],
  "sitemap": { "action": "public_sitemap_urls" }
}
```

**`page_meta`** is up to 20 routes; the first that matches a request path wins.

- `path` is literal segments plus exactly one `:placeholder`, named by `param`.
- `action` must be a `requires_auth: false` query in the same manifest that
  declares `param` and selects `title`, `description` and `image_url` (as
  columns or aliases). Registration answers `400` otherwise. The check is a
  light scan of the SELECT list, not a parser.
- On an uncached HTML GET for a matching path, the host calls the action with
  the path value. Any field it returns overrides the app-level listing and
  tenant metadata. `image_url` must be an absolute `http(s)` URL.
- **Fail-open:** an error, an empty row, or no answer within 1.5 s serves the
  page with app-level meta and a `200`. The rewritten page is cached with the
  page at the edge.

**`sitemap`** names a public query that returns `path` and `updated_at` and
declares a `cursor` param. The host serves `/sitemap.xml` from it:

- It pages with `cursor` set to the last row's `path` (`''` first): keyset
  paging, `WHERE path > :cursor ORDER BY path`. It stops at an empty page, a
  cursor that does not advance, or 20 pages.
- `path` must be same-origin (starts with `/`). `updated_at` is epoch ms or an
  ISO date and becomes `<lastmod>`.
- The sitemap is cached for an hour. If the action fails, the host answers
  `503` rather than publish an empty sitemap. With no `sitemap` declared, a
  static `sitemap.xml` in your build is served as before.

Every uncached HTML hit on a matching path costs one action call, so declare
`cache_ttl` on these actions (see
[Public actions: rate limit and cache](#public-actions-rate-limit-and-cache)).
Host calls use a service binding and are not subject to the anonymous rate
limit.

## Operator console gate (`operator`)

An app with an operator or admin console declares the path prefix it lives under
and the app role that may load it (#229):

```json
{
  "tools": [],
  "operator": { "prefix": "/admin", "role": "operator" }
}
```

The host then serves `/admin` and everything under `/admin/` only to a signed-in
user who holds the `operator` app role. It asks the backend on every request, so
revoking the role takes effect on the next request.

- **No session:** a page navigation is redirected to sign-in
  (`/.pas/auth/start?return_to=<path>`). Any other request gets `403`.
- **Signed in without the role:** `403`.
- **Role lookup failed:** `503`. The host never serves the path when it cannot
  check the role.
- **Caching:** gated responses are `Cache-Control: private, no-store` and never
  go into the edge cache.
- **Deep links:** an extension-less path under the prefix falls back to
  `<prefix>/index.html` if the build has one, otherwise to the app's own
  `index.html`.

`prefix` is lowercase path segments (`[a-z0-9_-]`, each starting with a letter or
digit), not `/`. `role` is an app role name and cannot be `member`, because every
signed-in user holds it. One gate per app. Like `page_meta`, it is replaced with
the manifest on every registration. Removing it from `mcp.json` removes the gate.

**What the gate protects is the bundle, not the data.** Only files under the
prefix are protected. A console that is lazy-loaded routes in the main SPA ships
its code in `/assets/`, which stays public. To keep the console code private,
build it under the prefix, for example a second Vite entry with
`base: '/admin/'` output to `dist/admin/`. Either way, every operator read or
write must still be a registered action with `auth.app_roles: ["operator"]` and
row-scoped SQL ([App Actions and Data Access Security](./app-actions-security.md)).

If the app is a PWA, keep the prefix out of the service worker: add it to
`navigateFallbackDenylist` and to workbox `globIgnores`. Otherwise precaching
would request gated files for every visitor, and the refusals would fail the
service worker install.

## Private apps (`visibility`)

A personal or invite-only app declares itself private (#259):

```json
{
  "tools": [],
  "visibility": { "mode": "private", "roles": ["viewer"] }
}
```

The whole app — `/`, every asset, `/.pas/api/*`, `/.pas/data/*`, its actions, its
`mcp.proappstore.online/mcp/apps/<id>` endpoint and its storefront listing — is
then available only to the app's **team** (its creator, any team member, platform
admins) and to users holding one of `roles`. Grant those roles with the normal
invite flow. `/.pas/auth/*` stays reachable, so a visitor can still sign in.

- **No session:** a page navigation is redirected to sign-in
  (`/.pas/auth/start?return_to=<path>`). Any other request gets `403`.
- **Signed in, not on the team and without a listed role:** `403`.
- **Lookup failed:** `503`. Nothing is served when the check cannot run.
- **Caching:** every response is `Cache-Control: private, no-store` and never goes
  into the edge cache.

`mode` is `public` (the default) or `private`. `roles` is 0–5 app role names, and
cannot include `member`, because every signed-in user holds it. With no roles, only
the team can use the app. A private app **cannot register a public action**
(`requires_auth: false`) or a public console endpoint, so `page_meta` and
`sitemap`, which need one, are not available to it either. Its public storage,
counters and rooms are limited to the same callers.

The declaration registers with the tools, so a manifest with `"tools": []` still
registers when it declares `visibility`. `pas publish` exits non-zero, and an Agent
Teams deploy is parked for a human, if a private declaration fails to register —
until it registers, the app is served publicly.

Like `operator`, it is replaced with the manifest on every registration: removing
it from `mcp.json` makes the app public again. Deleting the app's tools does not.
See [Authorization Model](./authorization-model.md#private-apps-visibility-private-who-may-use-the-app-at-all)
for where each surface is enforced and what is not covered.

## Console operator view (`operator_view`)

The app's owner oversees it from the Creator Console: **Operator** tab,
`console.proappstore.online/#/apps/<app-id>/operator` (#240). Every owned app
gets a baseline there: users holding app roles and 30-day activity, plus the
app's **platform-held users** (#246). `GET /v1/apps/<app-id>/operator/users`
returns every user with an app role or recorded activity: platform user id,
login, avatar, roles, join date, last activity and `activity`
(`active` within 30 days, `inactive`, `never_seen`). It never includes email.
It returns 50 per page, `q` matches a login prefix or an exact id, and each read
is audited as `read:platform-users`. The platform has no user suspension of its
own; an app's suspensions are its contract's `suspensions` resource. An app
adds its own operator data and actions by declaring an `operator_view`
contract in `mcp.json`. The console renders it with generic code; there is no
per-app console code.

```json
{
  "tools": [
    {
      "name": "op_list_reports", "description": "Open problem reports", "operation": "query", "requires_auth": true,
      "sql": "SELECT r.id AS report_id, r.reported_user_id, r.reason, r.created_at FROM reports r WHERE r.status = 'open' ORDER BY r.created_at DESC LIMIT 200",
      "params": {},
      "auth": { "app_roles": ["operator"], "caller_unscoped": { "reason": "Operators triage every report." } }
    },
    {
      "name": "op_suspend_user", "description": "Suspend a user", "operation": "execute", "requires_auth": true,
      "sql": "UPDATE members SET suspended = 1 WHERE id = :user_id",
      "params": { "user_id": { "type": "string" } },
      "auth": { "app_roles": ["operator"], "caller_unscoped": { "reason": "Operators suspend any member." } }
    }
  ],
  "operator_view": {
    "version": 1,
    "resources": [
      {
        "id": "open_reports", "kind": "reports", "title": "Open reports", "action": "op_list_reports",
        "columns": [
          { "key": "reason", "label": "Reason" },
          { "key": "reported_user_id", "label": "Reported user" },
          { "key": "created_at", "label": "Filed", "format": "datetime" }
        ]
      }
    ],
    "actions": [
      {
        "id": "suspend", "title": "Suspend user", "resource": "open_reports", "action": "op_suspend_user",
        "params": { "user_id": "reported_user_id" }, "confirm": "Suspend the reported user?"
      }
    ]
  }
}
```

- **`version`** is required. `1` is the only version today. A later version adds
  fields or kinds and keeps accepting `1`.
- **A resource** is a panel. `kind` is `users`, `reports`, `suspensions`,
  `verification` or `metrics`, and the console groups panels by kind. `action`
  names one of the app's registered **query** actions, called with no params.
  `columns` (1 to 12) are the fields shown, each one selected by that query. The
  column `format` is `text` (the default), `number`, `datetime`, `boolean` or
  `badge`. A `metrics` resource shows KPI tiles; every other kind shows a
  table. A `metrics` resource without `series` is an aggregate (#245). Every
  column must be `number`, and its read returns at most one row, with each value
  a finite number or `null`. Extra rows and non-numeric values (an email, a
  name) never leave the platform: `caller_unscoped` is for aggregates that
  return no row data (PAS-AUTH-016).
- **An action** is a row button on one resource. `action` names a registered
  **write** action (`execute`, `batch` or `verify`). `params` maps each of its
  params to a column of the row, and every required param must be mapped.
  `confirm` is the question the owner confirms before it runs.
- **Every referenced action** must require sign-in and declare `auth.app_roles`
  without `member`. Public, `member`-gated and scheduled actions are refused, so
  operator data is never readable by every signed-in user.
- **Strict validation.** Unknown fields, kinds, formats and versions are
  refused at registration, with the registration failing as a whole. Like
  `page_meta`, the contract is replaced with the manifest, and removing it
  returns the app to the baseline.

### Lists: search, paging, detail, status and related

A `users`, `reports`, `suspensions` or `verification` resource may also declare
search, keyset paging, a per-record detail page, a status workflow and a
related list. Each is optional, and each is backed by the app's own role-gated query
actions:

```json
{
  "id": "members", "kind": "users", "title": "Members", "action": "op_list_users",
  "columns": [{ "key": "display_name", "label": "Name" }, { "key": "user_id", "label": "User ID" }],
  "search": { "param": "q" },
  "page": { "param": "after", "column": "user_id" },
  "detail": {
    "action": "op_member_detail", "param": "user_id", "key": "user_id",
    "fields": [{ "key": "display_name", "label": "Name" }, { "key": "email", "label": "Email" }]
  }
}
```

- **`search.param`** is an optional string param of the list action. It receives
  the owner's search text (up to 100 characters). The app's SQL decides what it
  matches, for example `WHERE (:q IS NULL OR display_name LIKE '%' || :q || '%')`.
- **`page`** is keyset paging. `param` is an optional string param that receives
  the last row's `column`, which must be a declared column, for example
  `AND (:after IS NULL OR id > :after) ORDER BY id`. The list query must `ORDER BY`
  and end with a literal `LIMIT` of 1 to 200, which is the page size. A full page
  returns a `next_cursor`; a short page ends paging.
- **`detail`** runs `action` with `param` set to the row's `key` column. `key`
  must be a declared column. `fields` (1 to 24) are what the detail page shows,
  each one selected by that query. The detail action may take no other required
  params. Declare `step_up` on it when opening a record should need a recent
  sign-in.
- **`status`** declares a workflow: `column` (a declared column holding the
  row's state), `states` (1 to 12 `{ value, label }`), and optionally `param`,
  a string param of the list action that filters by state (`?status=`, which
  must be a declared state).
- **`related: { resource, param }`** lists this resource per record of another
  resource that has a detail page. The console shows it on that record's page,
  passing the record's key to `param`. For example, a `suspensions` resource
  related to `members` is each member's suspension history.
- These are refused on `metrics` resources.

**Row actions** (`actions[]`) may also declare:

```json
{
  "id": "resolve", "title": "Resolve", "resource": "open_reports", "action": "op_resolve_report",
  "params": { "report_id": "report_id", "from_status": "status" }, "confirm": "Mark this report resolved?",
  "transition": { "from": ["open", "reviewing"], "to": "resolved" }, "target": "report_id"
}
```

- **`transition`** makes the action a status change. It is offered only on rows
  whose status is in `from`, and `to` must be a declared state. The app's SQL
  must enforce it: one param must be mapped to the status column and used by
  the write, for example `UPDATE reports SET status = 'resolved' WHERE id =
  :report_id AND status = :from_status`. The platform refuses a row whose status
  is not in `from` with a 409. A write that changes nothing (someone else moved
  the record first) is also a 409, and is audited with status 409.
- **`destructive: true`** marks an irreversible or account-affecting action,
  such as a suspension. Its registered action must declare `step_up`, so it
  needs a recent sign-in. The console styles it as dangerous and offers a
  re-sign-in when it is refused.
- **`target`** is the resource column whose value the audit records as the
  record acted on. It defaults to the first mapped column.
- An action's registered action must be an `execute` or `batch` write.

### Identity verification

A `verification` resource is an ID-check queue. Its rules are stricter than
other lists, because identity data and decisions are sensitive:

- It must declare `status` (for example pending, approved, rejected) and
  `detail`.
- Its detail action must declare `step_up`, so opening a check needs a recent
  sign-in.
- The detail fields must include the status column and every column its
  decisions map, so decisions can be taken on the record page.
- Every row action on it must be a guarded `transition` whose action declares
  `step_up`. There are no unguarded or unauthenticated decisions.
- `detail.evidence` (1 to 6 `{ field, label }`) names detail fields that hold
  a document path in the app's review storage, `_review/u/<uid>/<path>` (the
  #208 namespace: `pas.storage` uploads under `_review/`).

```json
"detail": {
  "action": "op_kyc_detail", "param": "request_id", "key": "request_id",
  "fields": [{ "key": "full_name", "label": "Name" }, { "key": "status", "label": "Status" },
             { "key": "request_id", "label": "Request" }, { "key": "document_path", "label": "ID document" }],
  "evidence": [{ "field": "document_path", "label": "ID document" }]
}
```

**How evidence is served.** The record route never returns a document path;
each evidence field comes back as `true` or `false` (is a document there). The
console fetches a document from
`GET /v1/apps/:appId/operator/resources/:id/records/:key/evidence/:field`,
which:

- requires a recent **passkey** step-up (#244). A fresh OAuth or password
  sign-in does not count, and nothing is read first. Any other session gets 403
  `step_up_required` with `method: "passkey"`. The console then runs the passkey
  ceremony on its own relying party (`console.proappstore.online`), offering to
  register a passkey first if there is none, and retries with the short-lived
  step-up session it gets back, held only in memory;
- runs the detail action again (role gate, `step_up`, audit) and takes the
  path from that fresh row, never from the client;
- serves only a `_review/u/<uid>/<path>` object in this app's own storage, so
  no other namespace, app or storage path is reachable;
- requires the caller to hold one of the app's review roles
  (`PUT /v1/apps/:appId/storage-config`), so the operator view never widens
  who may open review documents;
- serves PDF and image types only, `private, no-store`, `nosniff`, with
  `default-src 'none'`;
- records the read in `storage_review_access` (the #208 trail) and in
  `app_action_audit` as `evidence:<resource>.<field>`.

### Metric time series

A `metrics` resource shows one row of KPI tiles by default. With `series` it
becomes an app-wide time series, with a summary value per measure and a chart
and data table per breakdown value:

```json
{
  "id": "growth", "kind": "metrics", "title": "Sign-ups", "action": "op_daily_signups",
  "columns": [{ "key": "day", "label": "Day" }, { "key": "plan", "label": "Plan" }, { "key": "signups", "label": "Sign-ups" }],
  "series": {
    "time": { "column": "day", "grain": "day" },
    "range": { "from_param": "from", "to_param": "to", "default_days": 30, "max_days": 366 },
    "measures": [{ "column": "signups", "label": "Sign-ups", "unit": "count", "aggregation": "sum" }],
    "dimension": { "column": "plan", "label": "Plan", "max_values": 5 }
  }
}
```

- **`time`**: the column holding each row's date (`YYYY-MM-DD`, an ISO
  date-time, or epoch seconds or milliseconds), and the grain the query
  returns: `day`, `week` (weeks start on Monday) or `month`.
- **`range`**: two optional string params of the query that receive the
  requested dates, for example `WHERE day >= :from AND day <= :to`.
  `max_days` (1 to 731) caps any request, and `default_days` is the window
  shown first. The query must end with a literal `LIMIT` of at most 5000.
- **`measures`** (1 to 4): each is a declared column with an explicit `label`,
  a `unit` (`count`, `percent`, `seconds`, `bytes`, or `currency` with an ISO
  `currency` code), and an `aggregation` (`sum`, `avg`, `min` or `max`). The
  aggregation applies when rows are rolled into a bucket and to the summary
  over the whole range.
- **`dimension`** (optional, one measure only): a breakdown column. The
  `max_values` (1 to 8) largest values are shown, and the response says how
  many were left out.

The console reads it from
`GET /v1/apps/:appId/operator/metrics/:id?from=&to=&grain=`. Before the query
runs, the platform refuses malformed dates, `from` after `to`, a future `to`,
a range longer than `max_days`, and a grain finer than the declared one. It
passes the range to the two params, rolls the rows up into every bucket of
the range (a bucket with no rows is `null`, not `0`), and returns only the
declared measures. The query runs under its own `auth.app_roles` and
`step_up`. The audit row records `series:<id>` and the range
(`2026-09-01..2026-09-30/day`), never a value. A series resource cannot be
read through the plain resource route.

### Operator audit trail

The console's **Audit trail** panel lists what the app's owner did in the
operator view:

- entering the view, once per visit (a console tab session per app);
- list, record, document and metric reads;
- row actions, and every refused attempt with its status.

Each row shows who, when, what, which record (`target`), the role that
allowed it, and the outcome. It never shows tokens, action params, document
paths or query results.

`GET /v1/apps/:appId/operator/audit` returns 50 rows a page, newest first,
with `?cursor=` and these filters:

- `?kind=` is one of `enter`, `audit`, `read`, `detail`, `evidence`,
  `series`, `action`.
- `?outcome=` is `success` or `refused`.
- `?actor=` and `?target=` match exactly.
- `?from=` and `?to=` are dates spanning at most 366 days.

Targets of identity-verification reads and document views are hidden (with
`target_hidden: true`) until the owner has signed in recently. Reading the
trail is itself recorded.

The trail is owner-only. An app can require more by declaring
`"audit": { "app_roles": ["operator"] }` at the top level of `operator_view`:
the owner must then also hold one of those roles (never `member`).

**Only declared columns and fields leave the platform.** A query may select
more (an internal id, a hash): the operator read routes return only the
declared keys, in declared order, and a declared key the row lacks comes back
as `null`.

**The contract grants nothing.** The console uses three owner-only routes:

- `GET /v1/apps/:appId/operator/resources/:id` reads rows, with `?q=`,
  `?cursor=`, `?status=` and `?related=`.
- `GET /v1/apps/:appId/operator/resources/:id/records/:key` reads one record.
- `POST /v1/apps/:appId/operator/actions/:id` with `{ row }` runs a row action.
  Only the declared columns its params map are read from the row, and each must
  be a scalar.

Each runs the app's registered action with the same checks as
`POST /v1/apps/:appId/actions/:name`: the owner's own session, the action's
`auth.app_roles`, `step_up`, and the success audit of role-gated actions (#232).
For these calls the audit row also records `operator_action` (the contract
action id, or `read:<resource>` / `detail:<resource>`) and `target` (the
record's key). It still records no other params and no results. The owner
must hold the role themselves (grant it in the console under **Settings →
Access**). Only the app's owner can read the contract, through
`GET /v1/apps/:appId/operator`. It is not part of the public tool listing or MCP
discovery. The actions it names stay ordinary MCP tools.

## How tools get registered

There are two paths, both idempotent (re-registering replaces the app's tool set):

- **CLI apps** — `pas publish` reads the repo's `mcp.json` and calls
  `PUT /v1/apps/:appId/tools` (owner-authenticated).
- **Agent-built apps** — the Agent Teams **deploy stage** auto-registers the
  working tree's `mcp.json` after a green deploy (via an internal,
  `INTERNAL_TOKEN`-guarded endpoint), once the app's data plane exists. The Dev
  agent is instructed to author `mcp.json` for any app with `app.db` tables, so
  agent-built apps are MCP-callable **with no manual step**.

> If an app ships no `mcp.json`, nothing is registered (no-op). Removing the
> manifest and redeploying clears the app's **code-defined** tools. Endpoints
> created in the console (names starting `api_`) are stored separately and are
> never touched by a deploy; manage them in Console → Data → API. The `api_`
> prefix is reserved, and `mcp.json` tools may not use it.

### Console-defined endpoints

A creator can also expose a **read** or **insert** action without writing SQL:
in the console, pick a table, columns, a scope (`own` rows, `all` rows behind an
app role, or `public`) and optional filters, sort and page size. The platform
reads the table schema from the app's data worker, generates the SQL (named
columns, `:params`, a literal `LIMIT`, `:__user_id` for own-rows scope) and
runs it through exactly the validators above before saving. The result is an
ordinary registered action: `POST /v1/apps/:appId/actions/api_…` and the
app-scoped MCP endpoint pick it up within a minute, and `GET /v1/apps/:appId/tools`
lists it with `source: "console"` (code tools read `source: "code"`). Routes:
`GET /v1/apps/:appId/endpoints`, `POST …/endpoints/preview`,
`PUT …/endpoints/:name`, `DELETE …/endpoints/:name` — owner session only,
every change audited, at most 30 per app.

## Calling an app's tools

Point app users at an app-scoped platform endpoint so their MCP client only sees
that app's tool set:

```json
{
  "mcpServers": {
    "crm": {
      "command": "npx",
      "args": ["mcp-remote", "https://mcp.proappstore.online/mcp/apps/crm"]
    }
  }
}
```

### Personal app tokens (HTTP only)

Scripts and integrations call the same actions over plain HTTP with a
**personal app token** — a long-lived, per-user, per-app, revocable bearer:

```bash
curl -X POST https://api.proappstore.online/v1/apps/<appId>/actions/<name> \
  -H "Authorization: Bearer pas_at_…" -H "Content-Type: application/json" \
  -d '{"params":{"status":"open"}}'
```

A signed-in user mints one from the app (`app.tokens.create({ label,
expiresIn, access, actions })` in the SDK) or from the dashboard; the plaintext
is shown once and only its hash is stored. `access: "read"` may call `query`
actions only; `actions: [...]` limits the token to named actions. The lifetime is
required and capped — 90 days when minted from an app origin, a year from the
dashboard — and `GET /v1/me/tokens` lists every token a user holds across apps
so any of them can be revoked from a surface the app doesn't control.

The token runs as its user: `:__user_id` is injected and `auth.app_roles` are
checked exactly as for a session, but platform roles are fixed to `user`, so an
action gated on `auth.platform_roles` answers 403 for a token even when its
holder is a creator. Tokens work on the HTTP actions route **only** — never on
MCP (which authenticates with its own OAuth) and never on kv, storage or any
other platform route. Routes: `POST | GET /v1/apps/:appId/tokens`,
`DELETE …/tokens/:tokenId`, `GET /v1/me/tokens` (session only).

### Large manifests: progressive disclosure

Every tool a session registers is in the model's context on every call, and
tool selection degrades fastest among near-identical candidates (thirty
`list_*` tools differing by table). So an app-scoped session does not register
a large manifest whole (platform #117):

- **Below 40 KB** of `tools/list` (`PROGRESSIVE_DISCLOSURE_THRESHOLD_BYTES`,
  measured as the session publishes it — name, description, params; never SQL)
  every tool is registered directly, as before.
- **At or above 40 KB** the session registers a **resident core** of at most 10
  tools — those marked `core: true` in `mcp.json` first, then `get_*` /
  `count_*` reads, in manifest order — plus `list_app_tools` and
  `call_app_tool` **scoped to the app** (no `app_id` argument). Their
  descriptions state how many tools the app has and how many are pre-loaded.
  Every other tool is one `list_app_tools({})` away and is invoked by name with
  `call_app_tool({ tool, params })`, through the same executor, role checks,
  audit and read-only gate as a pre-loaded tool. Nothing is hidden, only
  deferred.

Registration reports the manifest's model-facing byte cost (`bytes`,
`estimatedTokens`) and warns above 50 KB, so the number is in the deploy log;
the session's own log line records the split and the bytes saved per call.
The core set is chosen without `listChanged` promotion on purpose: clients that
cache `tools/list` would not see a mid-session change, and the static core plus
discovery pair needs no client cooperation. To keep a tool resident on a large
app, mark it `core: true`; to shrink the payload, shorten descriptions.

### Budgeting for larger apps

A mature app can follow the registered-action model all the way — every
browser and MCP call an action, RBAC in the SQL, raw SQL team-only — without
running into a wall (platform #109). The limits, from soft to hard:

| Signal | Threshold | What happens | What to do |
|---|---|---|---|
| Byte cost warning | manifest model-facing payload > 50 KB | registration succeeds; the deploy log warns with `bytes` / `estimatedTokens` | shorten descriptions; mark the resident set `core: true` |
| Progressive disclosure | an app-scoped MCP session's `tools/list` ≥ 40 KB | the session pre-loads ≤ 10 core tools; the rest are reached through `list_app_tools` / `call_app_tool` | nothing — the split is automatic; use `list_app_tools({ filter })` to browse by group |
| Count warning | ≥ 400 tools | registration succeeds; the deploy log warns with the count, the cap and the headroom | consolidate near-duplicates, or ask for a higher cap (below) |
| Hard cap | > 500 tools | registration is refused; the deploy fails, naming both counts | consolidate, or ask for a higher cap before you need it |

Every warning is a line in `warnings[]` of the registration response; the app's
deploy workflow prints each as a `::warning::` annotation on the run, so the
team sees it on the push that crossed the line, not on the push that failed.

**Keep the manifest maintainable by grouping.** Name actions
`<domain>_<verb>_<object>` and keep one domain per prefix —
`tournament_list_pairings`, `tournament_set_result`, `puzzle_check_move`,
`staff_adjudicate_game`. The prefix is what a model (or a reviewer) browses
by: `list_app_tools({ filter: "tournament_" })` lists one group of a 500-tool
app instead of all of it, and a manifest reads as a table of contents. A
group that needs its own resident tools marks them `core: true` (at most 10
across the app). Consolidate near-duplicates before adding: one
`list_games` with optional `status` / `player_id` filters instead of one
action per column; one `set_game_result` with a validated `result` param
instead of three. Each consolidated action keeps the same guards — every
statement still scopes on `:__user_id` (or declares `caller_unscoped`),
every `:param` is declared, and the whole set is compiled against the live
schema at registration — so consolidation never trades safety for count.

**The extension path.** The 500 cap is an abuse bound, not a design target;
it was 120 until real CRM/ERP-shaped manifests crossed it (#116). When a
legitimate app nears it, open a platform issue with the numbers the deploy log
already prints (tool count, `bytes`, `estimatedTokens`), what the next feature
set adds, and which groups the manifest is organised into. Raising the cap is
one constant (`MAX_TOOLS_PER_APP`) plus the registration-timing regression
test that pins the cost of a full-size manifest, so it is a review, not a
project. Nothing else in the registration path is sized by the cap: the
validators, the `:__user_id` lint, the schema-coherence check and the
public-query constraints run per statement, and progressive disclosure keeps
MCP sessions the same size whatever the count.

Use the shared platform endpoint for ProAppStore builder/operator workflows
(platform, project and QA tools). It reaches app tools only through
`list_app_tools` / `call_app_tool`:

```json
{
  "mcpServers": {
    "proappstore": {
      "command": "npx",
      "args": ["mcp-remote", "https://mcp.proappstore.online/mcp"]
    }
  }
}
```

On first connection, auth-capable clients such as `mcp-remote` receive an MCP
OAuth challenge and open a PAS browser confirmation page. The user chooses
GitHub or Google on that page, then completes sign-in in the browser. After the
OAuth flow completes, the client retries with an OAuth access token. The MCP
server maps that access token to a PAS session and the requested MCP resource.
On an app-scoped endpoint, only that app's tools are registered, alongside
`whoami` and `mcp_audit_log`. The shared `/mcp` endpoint registers no app
tools; `list_app_tools` and `call_app_tool` live there.

OAuth access tokens are bound to their requested MCP resource. A token minted
for `/mcp/apps/crm` is rejected on `/mcp` and on other app endpoints, forcing a
separate consent flow for each app or for platform-level operation.

Clients that cannot run the browser OAuth flow can still send an existing PAS
session token as `Authorization: Bearer <token>`; `pas login` stores that token
at `~/.proappstore/config.json` (`session.token`).

## What is allowed without auth

Unauthenticated access is limited to public protocol and documentation surfaces:

- Server health / landing text.
- OAuth discovery, dynamic client registration, and OAuth login start.
- Protected resource metadata and authorization server metadata.

MCP tools, including `list_app_tools` and `call_app_tool`, are authenticated
at the transport level so tool listing and tool calls are tied to a user.

## Security model

- **Authenticated by default.** App-data tools should require a PAS session
  unless they are deliberately public read-only queries.
- **SQL-only.** A tool can only run the parameterized statement, or declared
  batch of write statements, in its manifest against the app's own D1 — no
  arbitrary code, no cross-app access.
- **Parameterized.** All inputs bind as positional params; no string-built SQL.
- **Per-user scoped.** `:__user_id` + `requires_auth` keep a user's data scoped
  to them. Public tools cannot reference `:__user_id`.
- **SQL is not public.** `GET /v1/apps/:appId/tools` returns tool names,
  descriptions and params to any caller. `sql` / `statements` are returned
  only to the app's team (`requireAppAccess`, any team role). There is no
  cross-app listing: the former `GET /v1/tools` was retired (#193).
- **Role-aware before SQL.** Manifest `auth.platform_roles` and
  `auth.app_roles` are checked by the platform action executor (the live
  authority). The MCP server additionally pre-flights `auth.platform_roles` at
  the edge for a fast, clear rejection; `auth.app_roles` are *not* pre-checked
  there, because a session's per-app roles can lag a just-granted role, so the
  executor verifies those live against D1. Still check domain-specific row
  permissions in SQL.
- **Mutations are constrained** — `UPDATE`/`DELETE` require a `WHERE`; no DDL.

## Agent Skills

Workflows that drive these tools from an AI client are published as open
[Agent Skills](https://agentskills.io/specification) in the platform
repository under `skills/` — currently
[`create-proappstore-app`](https://github.com/proappstore-online/platform/blob/main/skills/create-proappstore-app/SKILL.md)
(gather inputs → `list_templates` → `provision_pas_app` dry-run → explicit
confirm → provision → verify) and
[`choose-proappstore-architecture`](https://github.com/proappstore-online/platform/blob/main/skills/choose-proappstore-architecture/SKILL.md)
(requirements → decision tables → unsupported needs → `sdk_reference` /
`recipe` verification → a bounded architecture decision citing the standard;
read-only) and
[`proappstore-auth-sessions-roles`](https://github.com/proappstore-online/platform/blob/main/skills/proappstore-auth-sessions-roles/SKILL.md)
(platform-cookie sessions, SDK sign-in/sign-out, app roles + manifest gates +
SQL scoping, permissions UI, negative tests; detects the auth anti-patterns;
read-only) and
[`proappstore-data-migrations-actions`](https://github.com/proappstore-online/platform/blob/main/skills/proappstore-data-migrations-actions/SKILL.md)
(store choice, additive migrations, registered actions with typed params and
magic params, SQL scoping, batches, idempotency, negative tests, migration and
deployment checks; detects cross-tenant access, guessed ids, replayable grants,
unsafe writes and drift; read-only) and
[`proappstore-publish-deploy`](https://github.com/proappstore-online/platform/blob/main/skills/proappstore-publish-deploy/SKILL.md)
(gates → inspect migrations and actions → preview → push to `main` →
`deploy_status` / `schema_status` / `list_app_tools` / `qa_list_runs` →
evidence bundle → `git revert` rollback; read-only plus `qa_run`) and
[`proappstore-upgrade-app`](https://github.com/proappstore-online/platform/blob/main/skills/proappstore-upgrade-app/SKILL.md)
(inventory → `list_templates` baseline → drift → staged plan; dry-run by
default, one reviewed stage per commit, product code never overwritten;
read-only) and
[`audit-proappstore-app`](https://github.com/proappstore-online/platform/blob/main/skills/audit-proappstore-app/SKILL.md)
(fetch `standard.json` → applicability → direct rules → one result per
clause → findings in the published contract → optional issue creation after
a duplicate check; read-only). They install as one portable plugin
([`plugin.json`](https://github.com/proappstore-online/platform/blob/main/plugin.json),
[`mcp.json`](https://github.com/proappstore-online/platform/blob/main/mcp.json),
and [`marketplace.json`](https://github.com/proappstore-online/platform/blob/main/marketplace.json));
the [Claude compatibility manifest](https://github.com/proappstore-online/platform/blob/main/.claude-plugin/plugin.json)
is retained for Claude Code.
Every skill is evaluated on every push — see the
[evaluation summary](./skills/evaluations.md) — and released through the
bundle gate (`skills/index.json` with checksums). Skills carry no credentials, call only a minimal allow-list of MCP
tools, and are validated by `test/skills.test.ts`.

## Limits & roadmap

- Tools are **SQL against the app's D1** — they can't (yet) call an external API
  or run business logic in a Worker route. That's a deliberate, safe surface.
  Use `operation: "batch"` for atomic multi-statement writes.
- Existing agent-built apps register on their **next** deploy (or a `pas publish`).
- Coming next: richer (non-SQL) tool handlers and raw-SQL migration gates,
  alongside [agent customization](./agent-customization).
