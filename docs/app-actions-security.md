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
`<app_id>/list_orgs`.

## Request flow

```text
Browser SDK or MCP client
  -> api.proappstore.online/v1/apps/:appId/actions/:name
  -> validates PAS session
  -> enforces manifest platform/app role metadata
  -> injects :__user_id, :__now, :__uuid server-side
  -> forwards prepared SQL to data-<app>.proappstore.online
  -> app D1
```

The caller can pass normal declared params. The caller cannot override magic
params; values such as `__user_id`, `__now`, and `__uuid` are owned by the
platform executor.

## Auth rules

All browser and MCP app-data actions require a PAS session. Public unauthenticated
database actions are not part of the production app-data surface.

Use manifest metadata for coarse permission gates:

| Field | Meaning |
|-------|---------|
| `requires_auth` | Must be `true` for app-data actions. |
| `auth.required` | Optional explicit marker. `false` is rejected for app-data actions. |
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
(repository == org/<appId>, ref == main). `pas publish` and the Agent Teams
deploy stage register through the same `replaceAppTools` path. Registered
tools therefore cannot drift from the repo.

Registration validates every statement (SELECT/INSERT/UPDATE/DELETE only, no
semicolons, no DDL, every `:param` declared) and caps apps at 120 tools.

## Low-level raw SQL

`app.db.query()` / `app.db.execute()` / `app.db.batch()` run caller-supplied
SQL, so the data worker restricts them to the app's team (creator +
`team_members`), verified against `/v1/apps` over a service binding. A regular
signed-in user gets `403 not authorized for this app` — by design. Keep
`app.db.migrate()` for schema setup, and make the startup call 403-tolerant so
non-team users proceed (team visits apply new migrations):

```ts
try { await app.db.migrate(MIGRATIONS) } catch (err) {
  if (!String(err).includes('403')) throw err
}
```

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
