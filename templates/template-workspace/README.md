# template-workspace

Back-office records workspace template for [ProAppStore](https://proappstore.online): a
company runs its operations in one workspace — members with roles and permissions,
single-use invitations, records with a lifecycle (draft → submitted → approved → closed,
or rejected), an approvals queue, reports and a scoped CSV export, and an audit trail written
in the same transaction as every change.

Scaffold with the CLI once the template is in the catalogue:

```bash
npm i -g @proappstore/cli
pas create my-office --template template-workspace
```

## What's in here

- `migrations.json` — `workspaces`, `members`, `permissions`, `invitations`, `records`, `approvals`, `activity_log`. Additive-only.
- `mcp.json` — 27 registered actions, all authenticated. Every statement carries `:__user_id` through a membership sub-query on the workspace; privileged writes check the role or a permission key in SQL; every state-changing write is a **batch** whose last statement is the audit row, guarded on the write's post-state so a refused write leaves no trace (PAS-AUTH-019). Transitions are guarded on the current status; creates are idempotent by client id.
- `web/src/api.ts` — `initPro` on platform-cookie auth, typed `q` / `x` / `batch` helpers and the **extension points**: `RECORD_TYPES`, `PERMISSION_KEYS`, `ROLES`.
- `web/src/workspace.tsx` — the active workspace: the caller's choice lives in per-user platform KV (never `localStorage`) and is re-validated against `list_my_workspaces`; every action re-checks membership in SQL regardless.
- `web/src/pages/` — Onboarding (create / join by code), Dashboard, Records (list with filters and keyset pagination, detail with transitions and approval history, form), Approvals queue, Reports + export, Team (roles, permission toggles, invitations), Activity, Settings (rename, profile name, leave).
- `qa/actions.mjs` — negative tests per scoped action on a real SQLite built from `migrations.json` (`pnpm test`).
- `.github/workflows/` — keyless deploy (migrations → actions → R2), compliance, CI typecheck.

## Permissions model

One of the two shapes the archetype allowed, chosen and documented here: a `permissions`
table keyed `(workspace_id, user_id, key)`. Roles are `admin | manager | member`; admins hold
every key implicitly, managers may close records and edit anyone's drafts, members work on
their own. Keys today: `manage_members`, `approve`, `export`. Add a key by extending
`PERMISSION_KEYS`, the `IN (...)` list in `grant_permission`, and the SQL guard of the action
it protects.

## Extending

| You want | Change |
|---|---|
| Real record modules (companies, contacts, deals, invoices, time entries) | keep `records` as the lifecycle spine or add a table per module with the same `workspace_id` + membership predicate; copy `create_record` / `submit_record` / `decide_approval` as the pattern |
| Email invitations | `app.email` from the Team page with the code in the message; the code stays single-use |
| Notifications on approvals | `app.notifications` after `submit_record` and `decide_approval` |
| Attachments | `app.storage` keys on the record, uploaded by the creator |
| A shared (Ready) deployment | nothing: every statement is already tenant-scoped, so one deployment can host many workspaces |

## What this template deliberately does not do

Public catalogues or two-sided markets (marketplace archetype), community events (membership
archetype), payments (the platform subscription is the only billing). Nothing about a person
is stored beyond the display name they set per workspace.

## Standard audit (1.5)

Static audit at staging: `pas check` passes all 20 checks with no warnings; the manifest
registers through the platform's own validation (manifest rules, `:__user_id` scoping, schema
coherence) and the migrations pass the additive-only lint — see
`test/template-workspace.test.ts` in the platform repository. The base template's three
deviations are fixed here (PAS-AUTH-001 platform-cookie, PAS-UI-002 `stores-theme`,
PAS-UI-007 zoomable viewport). Known deviations: none. Live checks run once an app built from
this template is deployed.

## License

MIT.
