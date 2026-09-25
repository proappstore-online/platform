# Delegated, group-scoped invites

`app.invites` supports multi-tenant onboarding without making a tenant admin a
member of the app's development team. The platform keeps three authorities
separate:

| Authority | Stored by | Purpose |
| --- | --- | --- |
| App-team role | `team_members` | Build, operate and deploy the app. `developer`+ retains full invite access. |
| App data role | `app_roles` | The app's own user capability, such as `org_admin`. |
| Group-admin grant | `app_group_admin_grants` | A platform-owned, per-user grant to administer one app-local group id. |

A team admin explicitly configures a policy mapping a data role to every role
it may invite, then grants the user administration of the relevant group. A
delegated caller needs both conditions. It can only create a scoped invite in a
granted group, only for a policy-approved role; list and revoke are restricted
to those groups. Group ids are opaque app-local strings, so the same value in a
different app is never in scope.

```ts
// Performed by an app-team admin (not by the tenant admin).
await app.invites.addDelegatedPolicy('org_admin', 'teacher')
await app.invites.addDelegatedPolicy('org_admin', 'student')
await app.invites.grantGroupAdmin('gh:42', 'school:melbourne-high')

// Performed by gh:42, who has the app data role org_admin.
await app.invites.create({
  role: 'student',
  group: 'school:melbourne-high',
  metadata: { schoolId: 'melbourne-high' },
})
```

The management methods (`listDelegatedPolicies`, `addDelegatedPolicy`,
`removeDelegatedPolicy`, `listGroupAdminGrants`, `grantGroupAdmin`, and
`revokeGroupAdmin`) require app-team `admin` access, like `app.roles` role
administration. They do not assign app roles or team membership.

Invite redemption is idempotent per invite and user. The platform writes its
redemption record, consumes a use, and assigns the invite role in one D1
transaction; metadata remains application context returned to the redeemer.
