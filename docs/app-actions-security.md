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

## Low-level raw SQL

`app.db.query()` and `app.db.execute()` are legacy/low-level escape hatches.
They require a valid PAS session at the data worker, but they are not a
row-level authorization boundary by themselves because the browser supplies the
SQL statement.

Use raw SQL only for controlled migration or trusted internal/admin tooling.
New user-facing app UI should use `app.actions.call()`.

## Migration plan

1. New apps declare data operations in `mcp.json` and call them through
   `app.actions.call()`.
2. Existing apps add `mcp.json` actions for each user-facing data operation.
3. Existing app UI moves from `app.db.query()` / `app.db.execute()` to actions.
4. Compliance warns on browser raw SQL usage in user-facing code.
5. After first-party apps are migrated, compliance can fail unsafe raw SQL usage
   and data workers can restrict raw `/query` and `/execute` to trusted internal
   paths.

This sequence avoids breaking existing apps while moving the platform to one
permissioned action surface.
