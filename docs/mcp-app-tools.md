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
                                          data-<app>.proappstore ◄──┘  (SQL → D1)
```

1. Your app declares tools in an **`mcp.json`** manifest at the repo root.
2. On publish, those tools are registered to the backend `app_tools` table.
3. The platform MCP server loads them dynamically and exposes each as
   `<app_id>/<tool_name>`, discoverable via the `discover_tools` tool.
4. When called, the server runs the tool's SQL against your app's data worker
   (`data-<app>.proappstore.online`) using the caller's session — returning rows
   for a `query`, or a write result for an `execute`.

Apps do **not** need to implement their own MCP server for normal D1-backed app
actions. The app-owned surface is the `mcp.json` action manifest. A local MCP
server can still be useful as a development bridge, but the platform MCP server
is the canonical integration point.

## Authentication model

All app-data tools should be authenticated unless they are deliberately public.
In the current production manifest format, auth is represented by:

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

The current `mcp.json` registration API does **not yet enforce role fields in
the manifest**. Until role-gated manifest fields are implemented, enforce
permissions in one of these ways:

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

That extension is not a substitute for row-level checks. A user can have a
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
    }
  ]
}
```

Each tool is **one parameterized SQL statement** against your app's own D1 tables.

| Field | Meaning |
|-------|---------|
| `name` | lowercase `a-z0-9_`. Exposed as `<app_id>/<name>`. |
| `description` | what the tool does (the model reads this to decide when to call it). |
| `operation` | `query` → a single `SELECT` (returns rows). `execute` → a single `INSERT`/`UPDATE`/`DELETE`. |
| `sql` | the statement. Bind values with `:name` placeholders; **no semicolons**, one statement only. |
| `params` | declared inputs: `{ "name": { "type", "description?", "optional?", "default?", "max?" } }`. Types: `string`, `integer`, `number`, `boolean`. |
| `requires_auth` | `true` ⇒ the call needs a session token. Auto-required when the SQL uses `:__user_id`. |

Use `requires_auth: true` for every app-data tool unless the data is genuinely
public. For user-scoped and organisation-scoped apps, that normally means every
tool, including reads.

### Magic placeholders

These are injected by the platform — **do not** declare them in `params`:

| Placeholder | Resolves to |
|-------------|-------------|
| `:__user_id` | the calling user's id (forces `requires_auth: true`). Scope per-user rows with `WHERE user_id = :__user_id`. |
| `:__now` | current time, ms since epoch. |
| `:__uuid` | a fresh UUID (use for inserting primary keys). |

## Validation rules (enforced at register time)

- SQL must start with `SELECT` / `INSERT` / `UPDATE` / `DELETE`.
- No DDL (`CREATE`, `DROP`, `ALTER`, `PRAGMA`, …) and no semicolons / multi-statement.
- `UPDATE` and `DELETE` **must** have a `WHERE` clause.
- `query` must use `SELECT`; `execute` must not.
- Every `:param` in the SQL must be declared in `params` (or be a magic placeholder).
- If SQL uses `:__user_id`, `requires_auth` must be `true`.
- Max 50 tools per app.

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

Then `discover_tools` lists what's registered, and `<app>/<tool>` calls it.
Tools marked `requires_auth` need a session token on the connection (the call
runs as that user, so `:__user_id` resolves and per-user scoping is enforced).

## Security model

- **Authenticated by default.** App-data tools should require a PAS session.
  Public tools should be intentional and rare.
- **SQL-only.** A tool can only run the one parameterized statement in its
  manifest against the app's own D1 — no arbitrary code, no cross-app access.
- **Parameterized.** All inputs bind as positional params; no string-built SQL.
- **Per-user scoped.** `:__user_id` + `requires_auth` keep a user's data scoped
  to them. Anonymous (`requires_auth: false`) tools cannot reference
  `:__user_id`.
- **Role-aware in SQL today.** Until manifest role gates are implemented, check
  app roles or membership tables in the SQL itself.
- **Mutations are constrained** — `UPDATE`/`DELETE` require a `WHERE`; no DDL.

## Limits & roadmap

- Tools are **SQL against the app's D1** — they can't (yet) call an external API
  or run business logic in a Worker route. That's a deliberate, safe surface.
- Existing agent-built apps register on their **next** deploy (or a `pas publish`).
- Coming next: role-gated manifest fields, richer (non-SQL) tool handlers, and
  exposing per-app tools from the Console UI alongside
  [agent customization](./agent-customization).
