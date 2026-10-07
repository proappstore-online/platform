# Migrating an operator view to the admin console

This guide is for apps that already declare an `operator_view` from the #240 operator
console and want to let people other than the owner use it (#291). If your app has no
`operator_view` yet, start with [Admin console](./admin-console.md) instead.

## If you change nothing

Your console keeps working, and it stays **owner-only**. Without `admin_access`, nobody but
the owner (the creator, a team `owner` or a platform admin) can open it. There is no new
required field, and `version` stays `1`.

Three changes since #240 can still affect an existing contract on its next deploy:

| Change | Effect on an existing app | What to do |
|---|---|---|
| **Sensitive fields (#294).** A declared column or detail field whose name matches the sensitive-field list (`password`, `token`, `secret`, `key`, `hash`, `salt`, `credential`, a leading `_internal`, …) is refused at registration. | **The deploy that registers `mcp.json` fails** if your contract declares one, for example a column named `api_key` or `token_count`. | Stop declaring it. If it isn't a secret, select it under a different name: `SELECT token_count AS uses`. |
| **`audit_required_role` is not supported.** | A contract that sets it under `admin_access` is refused. | Declare who may read the trail in `operator_view.audit.app_roles`. |
| **Only returned fields render (#298).** | A declared column that a query doesn't return, or that the platform blocked, is now absent from the console rather than an empty cell. | Nothing, unless you relied on an empty column showing up. |

Run `inspect_admin_console(appId)` (or `GET /v1/apps/:appId/operator-view/inspect`) to see
whether your stored contract has a `sensitive_field` gap before you deploy anything else.

## Adding admins

### 1. Choose the admin role

Pick one to five app role names that should get into the console, for example `moderator`
or `support`. The rules:

- Never `member` (every signed-in user holds it) and never `public`.
- Lowercase, `[a-z][a-z0-9_-]`, up to 50 characters.
- An app role, not a team role. A team `developer` is not an admin of your app's users.
  See [Authorization model](./authorization-model.md).

### 2. Let that role run the actions

Admission only lets someone open the console. Every panel and button still runs its
registered action, and the caller must hold one of that action's `auth.app_roles`. Most #240
contracts gate their actions on `operator`. Add the admin role to every action that admins
should be able to use:

```diff
 {
   "name": "op_list_reports",
   "auth": {
-    "app_roles": ["operator"],
+    "app_roles": ["operator", "moderator"],
     "caller_unscoped": { "reason": "Operators triage every report." }
   }
 }
```

You can split capabilities this way. Give `support` the read actions only and keep
`op_suspend_user` on `operator`. A `support` holder then sees the panels, and gets
`403 requires app role` on the suspend button.

If an admin role appears in no referenced action, `validate_admin_security` warns
`admin_role_grants_nothing`. That role's holders could open the console but do nothing.

### 3. Declare `admin_access`

```diff
 "operator_view": {
   "version": 1,
+  "admin_access": { "roles": ["moderator"] },
   "resources": [ … ],
   "actions": [ … ]
 }
```

The audit trail and the platform users list stay owner-only whatever you declare here.

### 4. Validate, then ship

Either push `mcp.json` to `main` (the deploy validates and registers it), or let an agent do
it with the MCP tools:

1. `propose_admin_update(appId, proposal)`: `valid` must be `true`.
2. `validate_admin_security(appId, proposal)`: `passesSecurityGates` must be `true`.
   Review every warning.
3. `preview_admin_console(appId, proposal)`: check the role access matrix and the blocked
   fields.
4. `apply_admin_update(appId, proposal, { dry_run: true })`, then `{ confirm: true }`.

If step 2 changes your tools, commit and deploy the tools first.
`apply_admin_update` checks against the repo's `mcp.json`, and it writes only
`operator_view`.

### 5. Grant the role

In the Creator Console, open **Settings → Access** and grant the role to each admin by user
id. This needs team `admin` or above. You can also use the SDK:
`app.roles.assign(userId, 'moderator')`. For a GitHub account, a grant made against the
GitHub login also matches. For any other account, grant against the user id.

### 6. Check it as the admin

Sign in as the admin. The app appears in the console's app list with only the **Operator**
tab (`GET /v1/me/administered-apps`). Open a record, run an action, then sign in as the owner
and check that the audit trail shows the admin's own id.

To revoke access, remove the role grant or drop `admin_access`. Either takes effect on the
admin's next request.

## Checklist

- [ ] `inspect_admin_console` shows no `sensitive_field` gap
- [ ] No `audit_required_role`; the audit roles live in `audit.app_roles`
- [ ] Every action that admins use lists the admin role in `auth.app_roles`
- [ ] `destructive` actions declare `step_up`
- [ ] `admin_access.roles` is set, with no `member` and no `public`
- [ ] `validate_admin_security` passes, and its warnings have been reviewed
- [ ] Roles are granted, and the admin has checked the console end to end
