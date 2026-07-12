# App Actions and Data Access Security

PAS app data should be exposed through registered actions. The same action
manifest powers browser SDK calls and MCP app tools, so authentication,
authorization, parameter binding, and data-worker execution stay in one platform
path.

## Recommended path

Declare app actions in `mcp.json`:

```json
{
  "tools": [
    {
      "name": "list_orgs",
      "description": "List organisations the signed-in user can see",
      "operation": "query",
      "sql": "SELECT id, name FROM orgs WHERE owner_id = :__user_id ORDER BY name LIMIT :limit",
      "params": {
        "limit": { "type": "integer", "default": 50, "max": 100, "optional": true }
      },
      "requires_auth": true,
      "auth": {
        "required": true,
        "app_roles": ["member"]
      }
    }
  ]
}
```

Call the action from app UI:

```ts
const result = await app.actions.call<{ rows: Org[] }>('list_orgs', {
  limit: 20,
});
```

After publish, the same action is available to authenticated MCP clients as
`{app_id}/list_orgs`.

## Request flow

```text
Browser SDK or MCP client
  -> api.proappstore.online/v1/apps/:appId/actions/:name
  -> validates PAS session
  -> enforces manifest platform/app role metadata
  -> injects :__user_id, :__now, :__uuid server-side
  -> forwards prepared SQL to data-{app}.proappstore.online
  -> app D1
```

The caller can pass normal declared params. The caller cannot override magic
params; values such as `__user_id`, `__now`, and `__uuid` are owned by the
platform executor.

## Auth rules

Browser and MCP app-data actions require a PAS session by default. Deliberately
public database actions are allowed only for constrained read-only query tools:
`requires_auth: false`, `operation: "query"`, no `:__user_id`, no role metadata,
and a literal `LIMIT 500` or lower.

Use manifest metadata for coarse permission gates:

| Field | Meaning |
|-------|---------|
| `requires_auth` | Must be explicit. Use `true` for writes and user-scoped reads; `false` is only for constrained public queries. |
| `auth.required` | Optional explicit marker. `false` is allowed only when `requires_auth` is also `false`. |
| `auth.platform_roles` | Any listed PAS platform role may call the action, such as `creator` or `admin`. |
| `auth.app_roles` | Any listed app role may call the action, such as `member`, `manager`, `editor`, or a custom role. |

Role metadata is an early gate, not the whole data permission model. SQL must
still scope rows to the signed-in user or to app-domain membership tables.

Good:

```sql
UPDATE onboarding_items
   SET done = :done
 WHERE id = :id
   AND org_id IN (
     SELECT org_id FROM org_members
      WHERE user_id = :__user_id
        AND role IN ('owner', 'manager')
   )
```

Unsafe:

```sql
UPDATE onboarding_items SET done = :done WHERE id = :id
```

The unsafe query lets any authenticated user update any row if they know or can
guess an id.

## Guard idioms (the SQL IS the security boundary)

Registered actions are directly POSTable by any signed-in PAS user — the guard
subqueries in the tool SQL are the enforcement, not a convention. Standard
idioms (all proven in interns + chess-academy):

**Self-scoping** — a user may only touch their own rows:

```sql
UPDATE weeks SET goal = :goal WHERE id = :week_id AND user_id = :__user_id
```

**Role guard via the app's own role table** — privileged writes carry an
`EXISTS` check on the caller:

```sql
DELETE FROM memberships
 WHERE org_id = :org_id AND user_id = :user_id
   AND EXISTS (SELECT 1 FROM memberships gm
                WHERE gm.org_id = :org_id
                  AND gm.user_id = :__user_id
                  AND gm.role = 'manager')
```

**Row-derived org guard** — when the target table carries the org, derive it
from the row instead of trusting an org param:

```sql
UPDATE games SET status = 'paused'
 WHERE id = :game_id
   AND EXISTS (SELECT 1 FROM user_roles g
                WHERE g.pas_user_id = :__user_id AND g.is_active = 1
                  AND (g.role = 'platform_admin' OR g.org_id = games.org_id))
```

**Server-derived grants** — never let the client name the privilege it
receives. Derive it from a server row inside the SQL (join-code redemption):

```sql
INSERT INTO user_roles (pas_user_id, display_name, role, org_id)
SELECT :__user_id, :display_name, jc.role, jc.org_id
  FROM join_codes jc WHERE jc.id = :code_id
```

**One-shot guards must be consumable.** A guard like "has an accepted invite"
is replayable forever unless revocation also consumes the invite — a removed
manager could re-grant themselves from the stale row. Pair every one-shot
grant with a revocation tool that closes the grant condition.

## Batch tools (atomic multi-statement actions)

`operation: "batch"` with `statements: [...]` (max 25) runs every statement in
ONE D1 transaction on the data worker, binding all statements against a single
shared params pool. Use a batch tool whenever a flow must not be observable
half-applied — tournament round creation, org create + owner membership,
cascading deletes:

```json
{
  "name": "create_org_with_membership",
  "operation": "batch",
  "statements": [
    "INSERT INTO orgs (id, name, owner_id, created_at) VALUES (:id, :name, :__user_id, :__now)",
    "INSERT INTO memberships (org_id, user_id, role, created_at) VALUES (:id, :__user_id, 'admin', :__now)"
  ],
  "params": { "id": { "type": "string" }, "name": { "type": "string" } },
  "requires_auth": true
}
```

Shared `:params` (and `:__user_id` / `:__now`) resolve identically across
statements; `:__uuid` is per-occurrence, so ids that must correlate across
statements are client-supplied params. Sequential single actions are fine only
when every step is independently idempotent and safe to observe alone.

## Registration and drift

The manifest is registered from the committed `mcp.json` on every deploy: the
app deploy workflow calls `PUT /v1/apps/:appId/tools/oidc`, authorized by the
same verified GitHub OIDC claims as the keyless R2 credential mint
(repository == org/{appId}, ref == main). `pas publish` and the Agent Teams
deploy stage register through the same `replaceAppTools` path. Registered
tools therefore cannot drift from the repo.

Registration validates every statement (SELECT/INSERT/UPDATE/DELETE only, no
semicolons, no DDL, every `:param` declared) and caps apps at 120 tools.

**Schema coherence (#33).** Registration also compiles every action's SQL against
the app's LIVE schema (data worker `/validate` → `EXPLAIN`, no execution). An
action that references a table/column that doesn't exist **blocks registration**
(422) — the deploy fails, naming the tool + column, instead of users hitting
`no such column` at runtime. Since Phase 1 migrates before registering, the
schema checked here is current. The check hard-blocks only on a definitive
missing table/column; if it can't reach the data worker it skips silently
(defense-in-depth, not a new failure point). Migration attempts land in
`migration_audit`, surfaced at `GET /v1/apps/:app/schema-status` and the
`schema_status` MCP tool so pending/failed migrations are visible. Repair and
fleet checks are documented in [Migration Repair Runbook](./migration-repair-runbook.md).

## Low-level raw SQL

`app.db.query()` / `app.db.execute()` / `app.db.batch()` run caller-supplied
SQL, so the data worker restricts them to the app's team (creator +
`team_members`), verified against `/v1/apps` over a service binding. A regular
signed-in user gets `403 not authorized for this app` — by design.

**Schema belongs in `migrations.json`, applied at deploy time (§10, #32 Phase 1).**
The committed `migrations.json` is applied to D1 by the deploy — BEFORE the
frontend goes live and BEFORE this manifest re-registers — so an action here can
never reference a column that isn't there yet. This replaces the old lazy
"apply on the first team visit" pattern, which left schema behind the actions
that depended on it and 500'd users (chess-academy, 2026-07-11). Every column an
action reads/writes must exist in `migrations.json`; keep it additive-only
(`CREATE`/`ALTER … ADD`/`INSERT` — the deploy rejects `DROP`/`RENAME`/destructive
statements). `app.db.migrate()` still works for local iteration and mirrors
`migrations.json`, but the committed file is authoritative.

The action executor reaches the data worker with the platform `INTERNAL_TOKEN`
(prepared, role-checked SQL — the trusted path), so end users never need raw
SQL access.

## Status

This model is FULLY ENFORCED as of 2026-07-10, not aspirational:

- Data workers restrict raw SQL to the app team (fleet redeployed 29/29).
- interns and chess-academy (all real-user apps) run entirely on registered
  actions with the guard idioms above.
- All five agent-teams seed templates ship an actions-based data layer +
  `mcp.json`, and `templates.test.ts` asserts the invariants (guards present
  in tool SQL, no raw `app.db` outside migrate, no interpolation).
- The template-app (CLI clone source) contains no raw browser SQL.
- Deploy workflows re-register `mcp.json` on every push.
