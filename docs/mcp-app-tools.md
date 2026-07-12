# MCP app tools and auth

ProAppStore is **AI-first**: every app you publish can expose its own tools to
the platform's remote MCP server, so an external AI (Claude Code, Cursor, the
Anthropic API, …) can call your app's data operations directly — list rows,
create records, run a query — the same way the UI does.

This is the per-app counterpart to the [agent-customization](./agent-customization)
story: agents *build* your app, and MCP makes the finished app *callable*.

## Current implementation

```
your app repo                 platform backend            platform MCP server
┌───────────────┐  publish    ┌──────────────┐  GET /v1/  ┌──────────────────┐
│  mcp.json     ├────────────►│  app_tools   ├──tools────►│ mcp.proappstore  │
│  (manifest)   │  registers  │  (D1 table)  │            │ .online/mcp      │
└───────────────┘             └──────────────┘            └────────┬─────────┘
                                                                    │ <app>/<tool>
                                          data-<app>.proappstore ◄──┘  (actions → D1)
```

1. Your app declares tools in an **`mcp.json`** manifest at the repo root.
2. On publish, those tools are registered to the backend `app_tools` table.
3. The platform MCP server loads them dynamically and exposes each as
   `<app_id>/<tool_name>`, discoverable via the `discover_tools` tool.
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

When an authenticated MCP connection calls a tool, the platform MCP server has
the caller's PAS session token and user id. It injects magic placeholders such
as `:__user_id`, `:__now`, and `:__uuid`, then sends the prepared SQL to the
app's data worker with the caller's bearer token.

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

The `auth.platform_roles` and `auth.app_roles` fields are enforced by the
shared platform action executor used by both browser SDK calls and MCP app
tools. In all cases, keep row-level checks in SQL:

- Use `:__user_id` in SQL and check app-domain membership tables, such as an
  `org_id` membership row.
- Use app data that mirrors PAS roles if the tool needs role-specific access.
- Keep all tools that touch user or app data marked with `requires_auth: true`.

The intended manifest extension is to add explicit auth metadata, for example:

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
| `name` | lowercase `a-z0-9_`. Exposed as `<app_id>/<name>`. |
| `description` | what the tool does (the model reads this to decide when to call it). |
| `operation` | `query` → a single `SELECT` (returns rows). `execute` → a single `INSERT`/`UPDATE`/`DELETE`. `batch` → multiple write statements in one D1 transaction. |
| `sql` | required for `query` and `execute`. Bind values with `:name` placeholders; **no semicolons**, one statement only. |
| `statements` | required for `batch`, max 25 statements. Batch tools use `statements`, not `sql`; each member is validated like an `execute` statement. |
| `params` | declared inputs: `{ "name": { "type", "description?", "optional?", "default?", "max?" } }`. Types: `string`, `integer`, `number`, `boolean`. |
| `requires_auth` | explicit `true` or `false`. `true` requires a session token. `false` is allowed only for constrained public `query` tools. SQL using `:__user_id` must require auth. |

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

## Validation rules (enforced at register time)

- `query` / `execute` tools use `sql`; `batch` tools use `statements`.
- SQL must start with `SELECT` / `INSERT` / `UPDATE` / `DELETE`.
- No DDL (`CREATE`, `DROP`, `ALTER`, `PRAGMA`, ...) and no semicolons.
- `UPDATE` and `DELETE` **must** have a `WHERE` clause.
- `query` must use `SELECT`; `execute` and each `batch` member must not.
- Every `:param` in the SQL must be declared in `params` (or be a magic placeholder).
- `requires_auth` must be explicitly `true` or `false`.
- `requires_auth: false` is only allowed for public `query` tools with no
  `:__user_id`, no roles, and a literal `LIMIT 500` or lower.
- Max 120 tools per app.

A manifest that violates any rule is rejected — the whole batch fails, so a bad
tool never half-registers.

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
> manifest and redeploying clears the app's tools.

## Calling an app's tools

Point any MCP client at the platform server:

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
server maps that access token to a PAS session, so `discover_tools` and
`<app>/<tool>` calls run as the connected user.

Clients that cannot run the browser OAuth flow can still send an existing PAS
session token as `Authorization: Bearer <token>`; `pas login` stores that token
at `~/.proappstore/config.json` (`session.token`).

## What is allowed without auth

Unauthenticated access is limited to public protocol and documentation surfaces:

- Server health / landing text.
- OAuth discovery, dynamic client registration, and OAuth login start.
- Protected resource metadata and authorization server metadata.

MCP tools, including `discover_tools`, are authenticated at the transport level
so tool listing and tool calls are tied to a user.

## Security model

- **Authenticated by default.** App-data tools should require a PAS session
  unless they are deliberately public read-only queries.
- **SQL-only.** A tool can only run the parameterized statement, or declared
  batch of write statements, in its manifest against the app's own D1 — no
  arbitrary code, no cross-app access.
- **Parameterized.** All inputs bind as positional params; no string-built SQL.
- **Per-user scoped.** `:__user_id` + `requires_auth` keep a user's data scoped
  to them. Public tools cannot reference `:__user_id`.
- **Role-aware before SQL.** Manifest `auth.platform_roles` and
  `auth.app_roles` are checked by the platform action executor. Still check
  domain-specific row permissions in SQL.
- **Mutations are constrained** — `UPDATE`/`DELETE` require a `WHERE`; no DDL.

## Limits & roadmap

- Tools are **SQL against the app's D1** — they can't (yet) call an external API
  or run business logic in a Worker route. That's a deliberate, safe surface.
  Use `operation: "batch"` for atomic multi-statement writes.
- Existing agent-built apps register on their **next** deploy (or a `pas publish`).
- Coming next: richer (non-SQL) tool handlers, raw-SQL migration gates, and
  exposing per-app tools from the Console UI alongside
  [agent customization](./agent-customization).
