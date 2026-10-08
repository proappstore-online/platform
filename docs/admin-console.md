# Admin console

Every ProAppStore app gets an admin console in the Creator Console (#291). It is for the
people who run the app, not for its developers. They can browse the app's records, open
them, run its moderation actions and read the audit trail, all without SQL, repository
access or a Cloudflare dashboard.

The console is generic code. An app does not ship console UI. It declares what to show in
an `operator_view` contract in `mcp.json`, and every read and write goes through the app's
own registered actions, so the platform enforces their roles, `step_up` and audit.

This page covers the overview, the agent workflow, a worked example and the API reference.
The full contract reference (every field and limit) is
[MCP app tools → Console operator view](./mcp-app-tools.md#console-operator-view-operator-view).
Existing apps should read the [migration guide](./admin-console-migration.md), and agents
should read [Agent onboarding](./agent-onboarding.md).

## Three ways to give an app an admin surface

| | Generic admin console | Custom admin panel | Operator path gate |
|---|---|---|---|
| What | The console's **Operator** tab renders your `operator_view` | Your own React screens on your app's origin | Host-gated path prefix on your app's origin |
| Declared in | `mcp.json` → `operator_view` | App code, using SDK hooks | `mcp.json` → `operator` |
| UI code | None, the platform renders it | Yours | Yours |
| Who gets in | The owner, plus `admin_access.roles` | Anyone the actions admit | Holders of `operator.role` |
| Use it for | Routine browse, search, records and moderation | Workflows the contract can't express | Keeping a custom panel's bundle private |

All three use the same rule: **the actions are the security boundary**. A UI, a contract
or a gate never grants data access. Only a registered action does, under its own
`auth.app_roles`, `step_up` and row-scoped SQL
([App Actions and Data Access Security](./app-actions-security.md)).

## Who can use the console

| Caller | Context, resource rows, records, evidence, metric series, row actions | Audit trail | Platform users list |
|---|---|---|---|
| App owner (the creator, a team `owner`, or a platform admin) | yes | yes¹ | yes |
| Holder of an `admin_access.roles` role | yes | no | no |
| Anyone else: an undeclared role, `member`, a lesser team role, another app's owner | 403 | 403 | 403 |
| Signed out | 401 | 401 | 401 |

¹ If the contract declares `audit.app_roles`, the owner must also hold one of those roles.

Being admitted grants **no action by itself**. Each read and write still runs the referenced
action, and the caller must hold one of that action's `auth.app_roles`. Admission, roles and
the contract are read on every request, so revoking a role or removing `admin_access` takes
effect on the next request. An app role matches the caller's user id. For a GitHub session it
also matches the GitHub login. It never matches a free-text display name (#272).

Admins reach the app from the console's app list: `GET /v1/me/administered-apps` lists apps
where they hold a declared admin role without owning the app or being on its team. Those apps
show only the **Operator** tab (#297).

The owner grants app roles in the console under **Settings → Access**, or with
`app.roles.assign(userId, role)` (`POST /v1/apps/:appId/roles`, which needs team `admin` or
above).

## What the console does and doesn't do

- **Browse:** each `resource` is a panel backed by one query action. It can have search,
  keyset paging, a status filter, and a list of related records.
- **Inspect:** a `detail` opens a record page with the fields you declare. A
  `verification` resource can also show ID-document evidence, which needs a passkey step-up.
- **Change:** each `actions[]` entry is a row button that runs one registered write action.
  It can be a status `transition` (409 if the row has moved on; in a `batch`, every
  statement must check the status, #340) or `destructive` (needs `step_up`). Every
  action asks for confirmation.
- **Metrics:** a `metrics` resource shows KPI tiles or a time series.
- **Audit:** every visit, read and action, and every refused attempt, is recorded under the
  caller's own id.
- **Not provided:** there is no generic "new record" or "edit any field" form, and no raw
  table browser. Creating or editing records is something you declare as a row action
  with its own SQL (for example "Restore listing" or "Change plan"). Anything that needs a
  form, a wizard or several steps belongs in a [custom admin panel](#custom-admin-panels).
- **Never returned:** a column or field you didn't declare. Also any field on the platform's
  sensitive-field list (`password`, `token`, `secret`, `key`, `hash`, …), even if you declare
  it. Registration refuses such a declaration, so you find out at deploy time.

## The agent workflow

An agent connected to `https://mcp.proappstore.online/mcp` as the app's owner can author
the console end to end with six tools. None of them reads app data, and only the last one
writes.

```
discover ──► inspect ──► propose ──► validate ──► preview ──► apply
capabilities  current     structure   security     what it    commit to
+ schema      state+gaps  + actions   gates        renders    mcp.json → deploy
```

| Step | MCP tool | HTTP route | Writes? |
|---|---|---|---|
| Discover | `list_admin_capabilities` | `GET /v1/operator-view/capabilities` | no |
| Inspect | `inspect_admin_console(appId)` | `GET /v1/apps/:appId/operator-view/inspect` | no |
| Propose | `propose_admin_update(appId, proposal, validateAgainstActions?, tools?)` | `POST /v1/apps/:appId/operator-view/propose` | no |
| Validate | `validate_admin_security(appId, proposal, tools?)` | `POST /v1/apps/:appId/operator-view/security` | no |
| Preview | `preview_admin_console(appId, proposal, tools?)` | `POST /v1/apps/:appId/operator-view/preview` | no |
| Apply | `apply_admin_update(appId, proposal, { confirm: true })` | commits `mcp.json` on `main` | **yes** |

1. **Discover.** `list_admin_capabilities` returns the resource kinds, column formats,
   limits, the sensitive-field list and a JSON Schema of `operator_view`. Write the
   proposal against that schema, not from memory.
2. **Inspect.** `inspect_admin_console` returns the stored contract, the actions it
   references and its **gaps** against the app's current tools (`action_missing`,
   `wrong_operation`, `not_role_gated`, `public_action`, `scheduled_action`,
   `not_user_callable`, `step_up_missing`, `column_not_selected`, `sensitive_field`).
   Fix each gap in the tools or in the contract.
3. **Propose.** `propose_admin_update` runs the platform's own validator. `valid: false`
   means a deploy would refuse it. Fix every entry in `errors` and `missing_requirements`.
   When you are adding the actions the contract needs in the same change, pass the proposed
   `tools` array.
4. **Validate.** `validate_admin_security` returns `passesSecurityGates` and a list of
   issues. Errors block `apply`. Treat warnings as review items (see the
   [codes table](#security-issue-codes)).
5. **Preview.** `preview_admin_console` renders the tabs, columns, row actions, the role
   access matrix and the blocked fields. Show it to the human before you apply.
6. **Apply.** Run `apply_admin_update` with `dry_run: true` first, then with
   `confirm: true`. It replaces only `operator_view` in the repo's `mcp.json` with a single
   commit on `main`, then waits up to `wait_seconds` for the deploy that registers it. It
   reports `registered`, `pending`, `failed` or `deployed_contract_differs`.

Apply checks the proposal against the tools in the repo's `mcp.json`, not the registered
ones. If the contract needs new actions, commit those tools first, let them deploy, and then
apply the contract.

## Worked example: two entities with moderation

This example adds a console for a community app with **members** and **reports**. A
`moderator` app role can search members, triage reports, resolve them and suspend
members. The owner gets the same access, plus the audit trail.

### 1. The actions (in `mcp.json` → `tools`)

Every action the console uses must be authenticated and declare `auth.app_roles` that
includes the admin role (never `member`). Operators see rows across all users, so each
read is declared `caller_unscoped`, with a reason.

```json
[
  {
    "name": "op_list_members", "description": "Every member", "operation": "query", "requires_auth": true,
    "params": { "q": { "type": "string", "optional": true }, "after": { "type": "string", "optional": true } },
    "sql": "SELECT m.id AS user_id, m.display_name, m.created_at, m.suspended FROM members m WHERE (:q IS NULL OR m.display_name LIKE '%' || :q || '%') AND (:after IS NULL OR m.id > :after) ORDER BY m.id LIMIT 50",
    "auth": { "app_roles": ["moderator"], "caller_unscoped": { "reason": "Moderators see every member." } }
  },
  {
    "name": "op_member_detail", "description": "One member", "operation": "query", "requires_auth": true,
    "params": { "user_id": { "type": "string" } },
    "sql": "SELECT m.id AS user_id, m.display_name, m.email, m.created_at, m.suspended FROM members m WHERE m.id = :user_id LIMIT 1",
    "auth": { "app_roles": ["moderator"], "caller_unscoped": { "reason": "Moderators open any member." } }
  },
  {
    "name": "op_list_reports", "description": "Problem reports", "operation": "query", "requires_auth": true,
    "params": { "status": { "type": "string", "optional": true }, "after": { "type": "string", "optional": true } },
    "sql": "SELECT r.id AS report_id, r.reported_user_id, r.reason, r.status, r.created_at FROM reports r WHERE (:status IS NULL OR r.status = :status) AND (:after IS NULL OR r.id > :after) ORDER BY r.id LIMIT 100",
    "auth": { "app_roles": ["moderator"], "caller_unscoped": { "reason": "Moderators triage every report." } }
  },
  {
    "name": "op_resolve_report", "description": "Resolve a report", "operation": "execute", "requires_auth": true,
    "params": { "report_id": { "type": "string" }, "from_status": { "type": "string" } },
    "sql": "UPDATE reports SET status = 'resolved' WHERE id = :report_id AND status = :from_status",
    "auth": { "app_roles": ["moderator"], "caller_unscoped": { "reason": "Moderators resolve any report." } }
  },
  {
    "name": "op_suspend_member", "description": "Suspend a member", "operation": "execute", "requires_auth": true, "step_up": true,
    "params": { "user_id": { "type": "string" } },
    "sql": "UPDATE members SET suspended = 1 WHERE id = :user_id AND suspended = 0",
    "auth": { "app_roles": ["moderator"], "caller_unscoped": { "reason": "Moderators suspend any member." } }
  }
]
```

### 2. The contract (in `mcp.json` → `operator_view`)

```json
{
  "version": 1,
  "admin_access": { "roles": ["moderator"] },
  "resources": [
    {
      "id": "members", "kind": "users", "title": "Members", "action": "op_list_members",
      "columns": [
        { "key": "display_name", "label": "Name" },
        { "key": "user_id", "label": "User ID" },
        { "key": "created_at", "label": "Joined", "format": "datetime" },
        { "key": "suspended", "label": "Suspended", "format": "boolean" }
      ],
      "search": { "param": "q" },
      "page": { "param": "after", "column": "user_id" },
      "detail": {
        "action": "op_member_detail", "param": "user_id", "key": "user_id",
        "fields": [{ "key": "display_name", "label": "Name" }, { "key": "email", "label": "Email" }, { "key": "suspended", "label": "Suspended" }]
      }
    },
    {
      "id": "reports", "kind": "reports", "title": "Reports", "action": "op_list_reports",
      "columns": [
        { "key": "report_id", "label": "Report" },
        { "key": "reason", "label": "Reason" },
        { "key": "reported_user_id", "label": "Reported user" },
        { "key": "status", "label": "Status", "format": "badge" }
      ],
      "page": { "param": "after", "column": "report_id" },
      "status": {
        "column": "status", "param": "status",
        "states": [{ "value": "open", "label": "Open" }, { "value": "resolved", "label": "Resolved" }]
      }
    }
  ],
  "actions": [
    {
      "id": "resolve", "title": "Resolve", "resource": "reports", "action": "op_resolve_report",
      "params": { "report_id": "report_id", "from_status": "status" }, "confirm": "Mark this report resolved?",
      "transition": { "from": ["open"], "to": "resolved" }, "target": "report_id"
    },
    {
      "id": "suspend", "title": "Suspend member", "resource": "members", "action": "op_suspend_member",
      "params": { "user_id": "user_id" }, "confirm": "Suspend this member?", "destructive": true
    }
  ]
}
```

### 3. Ship and grant

1. Push `mcp.json` to `main`. The deploy registers the tools and the contract, and refuses
   the whole registration if the contract is invalid. An agent instead calls
   `apply_admin_update` once the tools are registered.
2. The owner grants `moderator` to each admin under **Settings → Access**.
3. The admin opens the console. The app appears in their app list with only the
   **Operator** tab.

The Stash and Parents Clubs fixtures in
`packages/backend/src/__fixtures__/operator-view*.ts` are larger contracts. They also cover
suspension history, an identity-check queue with evidence, and metric series.

## Custom admin panels

When the generic console isn't enough, build the screen in your app with the SDK's admin
hooks (`@proappstore/sdk` ≥ 1.16.69, #299). A panel runs on your app's own origin, never
inside the console, and reaches data only through declared actions.

```tsx
import { AdminConsole, useAction, useAdminContext, type ActionError } from '@proappstore/sdk'

export function Moderation() {
  return <AdminConsole app={app}><Dashboard /></AdminConsole>
}

function Dashboard() {
  const { roles, session } = useAdminContext()
  const deleteGroup = useAction<{ group_id: string }>('admin_delete_group', { onStepUp: reauthenticate })
  if (!session.rolesLoaded) return <p>One moment.</p>
  if (!roles.includes('admin')) return <p>Admins only.</p>   // rendering only; the server decides
  // … deleteGroup({ group_id }) … deleteGroup.pending … deleteGroup.error
}
```

| Export | What it does |
|---|---|
| `<AdminConsole app? renderError?>` | Provides the app and the admin context. Catches a render error in the panel, records it through `app.logs` and shows a fallback. |
| `useAdminContext()` | Returns `{ app: { id }, user, roles, session: { status, rolesLoaded, refreshRoles } }`. `roles` comes from `GET /v1/apps/:appId/roles/me`. It throws if used outside `<AdminConsole>`. |
| `useAction(name, { onStepUp? })` | Returns an invoker for a declared action, with `pending`, `error` and `reset()`. On `step_up_required` it calls `onStepUp(error)`. If that resolves `true`, it retries once. Each outcome is logged as `admin.action`, never with params. |
| `ActionError` | `status`, `code` (the server's `error`), `body`, plus `forbidden` (a 403 role refusal), `stepUpRequired` and `needsPasskey`. |
| `<AdminErrorBoundary>` | The same error boundary, for one part of a panel. |

`roles` is for rendering only. Never treat it as the check: the action executor is the
authority. The working sample is `templates/template-membership/web/src/pages/Moderation.tsx`
(`#/moderation`).

To keep a panel's code private as well as its data, build it under a gated prefix (the
`operator` gate in [MCP app tools](./mcp-app-tools.md#operator-console-gate-operator)).

## API reference

All routes live on `https://api.proappstore.online/v1` and take the caller's
`Authorization: Bearer` session. Responses are `Cache-Control: private, no-store`.

### Console routes

| Route | Gate | Purpose |
|---|---|---|
| `GET /apps/:appId/operator` | owner or admin | Context: app, caller, baseline activity, contract |
| `POST /apps/:appId/operator/entries` | owner or admin | Records a console visit (`{ visit }`) |
| `GET /apps/:appId/operator/resources/:id` | owner or admin | Rows; `?q=`, `?cursor=`, `?status=`, `?related=` |
| `GET /apps/:appId/operator/resources/:id/records/:key` | owner or admin | One record's declared fields |
| `GET /apps/:appId/operator/resources/:id/records/:key/evidence/:field` | owner or admin, plus a review role and a passkey step-up | One evidence document |
| `GET /apps/:appId/operator/metrics/:id?from=&to=&grain=` | owner or admin | A metric time series |
| `POST /apps/:appId/operator/actions/:id` | owner or admin | Runs a row action with `{ row }` |
| `GET /apps/:appId/operator/audit` | owner (plus `audit.app_roles`) | Audit trail, 50 a page |
| `GET /apps/:appId/operator/users` | owner | Platform-held users of the app |
| `GET /me/administered-apps` | signed in | `{ apps: [{ id, name, created_at }] }`: apps the caller only administers |

### Authoring routes

`GET /operator-view/capabilities` needs only a signed-in caller. The others are owner-only
(`requireAppOwner`): `GET /apps/:appId/operator-view/inspect`, and
`POST /apps/:appId/operator-view/{preview,propose,security}` with
`{ operator_view, tools?, validate_against_actions? }`.

### Auth checks in the backend

| Check | Where | Admits |
|---|---|---|
| `requireOperatorAccess(c, appId)` | `lib/operator-audit-marks.ts` | `requireAppOwner`, or else a holder of a declared `admin_access` role (`holdsOperatorAdminRole`) |
| `requireOperatorOwner(c, appId)` | `lib/operator-audit-marks.ts` | `requireAppOwner` only |
| `requireAppOwner(c, appId)` | `lib/auth.ts` | The creator, a team `owner`, or a platform admin |
| Per-action gate | `routes/operator-exec.ts` → the action executor | The action's `auth.app_roles` and `step_up`, plus a success audit |

Both operator checks remember the admitted caller for that request. If an admitted caller is
then refused, the refusal is audited once. Callers who never got past the gate leave nothing
in the trail.

### Error codes

Errors are JSON `{ "error": "<message>", ...extra }`.

| Status | `error` | When |
|---|---|---|
| 401 | `missing bearer token` / `invalid or expired session` | Signed out |
| 403 | `not the app owner` | An owner-only route, for a caller who isn't the owner |
| 403 | `the operator view needs the app owner or one of the app's admin roles` | Signed in, but neither the owner nor a declared admin |
| 403 | `requires app role` | Admitted, but the caller doesn't hold the action's `auth.app_roles`. Also returned for the audit trail when the owner holds none of the `audit.app_roles`. |
| 403 | `step_up_required` (+ `message`, `max_age`, optionally `method: "passkey"`) | The action declares `step_up` (or the route requires a passkey) and the sign-in is too old. Sign in again and retry. |
| 403 | `not a reviewer for this app` | Evidence, for a caller without a review role |
| 404 | `app not found`, `resource not declared`, `action not declared`, `resource has no detail`, `record not found`, `evidence not declared`, `no document for this record`, `resource is not a time series` | Unknown app, or something the contract doesn't declare |
| 400 | `resource is not searchable` / `not paged` / `has no status filter` / `unknown status` / `is not listed per record`, `row must be an object`, `row.<col> is required`, … | A request the contract doesn't allow |
| 409 | `"<title>" is not available from status …` | A transition from a status that isn't in `from` |
| 409 | `the record changed since it was loaded; reload and try again` | A guarded write that changed nothing |
| 409 | `action <name> cannot run from the operator view` | The action is public, scheduled, or can't be called by a user |
| 409 | `action <name> does not guard every statement with :<param>; redeploy it…` | A transition whose stored action has a statement that ignores the status (#340) |
| 409 | `this resource pages on a column on the sensitive-field list…` / `this metric's time column is on the sensitive-field list…` | A contract stored before that name joined the sensitive-field list (#336). Redeploy the `operator_view` |
| 415 | `document type is not viewable` | Evidence that isn't a PDF or an image |
| 502 | `action <name> failed (…)` / `data worker returned an invalid response` | The data worker failed |

### Security issue codes

These are returned by `validate_admin_security` and `propose_admin_update`. Any error-level
issue blocks `apply_admin_update`.

| Code | Severity | Meaning |
|---|---|---|
| `secret_exposure` | error | A declared column or field is on the sensitive-field list |
| `missing_action` | error | The referenced action isn't registered |
| `destructive_without_step_up` | error | A `destructive` action whose tool doesn't declare `step_up` |
| `unscoped_write` | error | A write not scoped to its row (#339): an `UPDATE`/`DELETE` whose top-level `WHERE` doesn't compare a column (`=` or `IN`) with a param mapped from the row's key (the action's `target`, the resource's page column or detail key), or that widens it with a top-level `OR`; a `REPLACE` or upsert that uses no keyed param. Writes are found past leading comments and `WITH`. A plain `INSERT` is not checked |
| `audit_role_error` / `admin_role_error` | error | `member` or `public` used as an audit or admin role |
| `undefined_role` | warning | Nobody holds the role and no referenced action uses it |
| `audit_role_unheld` | warning | The owner holds none of the `audit.app_roles` |
| `admin_role_grants_nothing` | warning | The admin role isn't in any referenced action's `app_roles` |
| `delete_not_destructive` | warning | A `DELETE` not declared `destructive` with `step_up` |
| `select_star` | warning | The read uses `SELECT *` |
| `caller_scoped_read` | warning | The read is scoped to `:__user_id`, so an operator sees only their own rows |
| `unbounded_read` | warning | A list read with no literal `LIMIT` |
