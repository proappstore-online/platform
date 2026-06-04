# MCP: expose your app's tools

ProAppStore is **AI-first**: every app you publish can expose its own tools to
the platform's remote MCP server, so an external AI (Claude Code, Cursor, the
Anthropic API, …) can call your app's data operations directly — list rows,
create records, run a query — the same way the UI does.

This is the per-app counterpart to the [agent-customization](./agent-customization)
story: agents *build* your app, and MCP makes the finished app *callable*.

## How it works

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

- **SQL-only.** A tool can only run the one parameterized statement in its
  manifest against the app's own D1 — no arbitrary code, no cross-app access.
- **Parameterized.** All inputs bind as positional params; no string-built SQL.
- **Per-user by default.** `:__user_id` + `requires_auth` keep a user's data
  scoped to them. Anonymous (`requires_auth: false`) tools must not reference
  `:__user_id`.
- **Mutations are constrained** — `UPDATE`/`DELETE` require a `WHERE`; no DDL.

## Limits & roadmap

- Tools are **SQL against the app's D1** — they can't (yet) call an external API
  or run business logic in a Worker route. That's a deliberate, safe surface.
- Existing agent-built apps register on their **next** deploy (or a `pas publish`).
- Coming next: richer (non-SQL) tool handlers and exposing per-app tools from the
  Console UI alongside [agent customization](./agent-customization).
