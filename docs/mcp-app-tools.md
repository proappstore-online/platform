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
| `schedule` | optional platform schedule for an `execute` or `batch` action: `{ "cron": "*/15 * * * *", "params": { ... } }`. See [Scheduled actions](#scheduled-actions). |
| `core` | optional boolean. On a large manifest (see below) `core: true` keeps this tool pre-loaded on the app's MCP session instead of deferring it to discovery. Ignored on a small manifest, where everything is pre-loaded anyway. |

Use `requires_auth: true` for writes and user-scoped reads. Deliberately public
read-only queries can use `requires_auth: false`, but registration constrains
them: they must be `query` tools, must not reference `:__user_id`, must not
declare roles, and must include a literal `LIMIT 500` or lower.

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

Each due minute is first written and atomically claimed in the platform D1
before the prepared action reaches the app data worker. Duplicate/overlapping
ticks cannot run it twice; a stale claim is recovered as a failure. Missed
minutes are never backfilled, and a still-claimed prior run suppresses the
next due run rather than stacking work. Five consecutive failures disable that
action until its manifest is re-registered and create an app alert.

Owners can inspect `GET /v1/apps/:appId/scheduled-runs` (optional `status`,
`limit`) or the MCP `list_scheduled_runs` tool. Registration/deploy logs print
the action name and UTC cron.

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
