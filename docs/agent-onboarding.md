# Agent onboarding: admin console tools

This page is for an AI agent (Claude Code, Cursor, an Agent Teams worker, …) that is asked
to give a ProAppStore app an admin console, or to change one. It covers what you need before
the first call, the order of the calls, and the rules you must not break. The product side is
in [Admin console](./admin-console.md).

## Before you start

- **Connect** to the shared MCP endpoint, `https://mcp.proappstore.online/mcp`, signed in
  as a user. The admin console tools are there, not on an app's own
  `/mcp/apps/<app_id>` endpoint.
- **Be the owner.** Every tool except `list_admin_capabilities` is owner-only: the app's
  creator, a team `owner`, or a platform admin. A declared admin of the app can use the
  console but cannot author it. Anyone else gets 403.
- **Know the app id** (`list_apps`, or the user tells you).
- **Read the app's `mcp.json`.** The console only shows what the app's registered actions
  return, so you will be editing `tools` as well as `operator_view`.

## The workflow

Run the steps in this order. Steps 1–5 never write and never read app data, so their
output contains no field values. Repeat them as often as you like.

| # | Call | You get | Move on when |
|---|---|---|---|
| 1 | `list_admin_capabilities()` | Kinds, formats, limits, the sensitive-field list, the JSON Schema of `operator_view` | You have the schema; write the proposal against it |
| 2 | `inspect_admin_console(appId)` | The stored contract, the actions it references, gaps, what renders | You know which gaps to fix |
| 3 | `propose_admin_update(appId, proposal, true, tools?)` | `valid`, the normalized contract, `errors`, `warnings`, `missing_requirements`, `security_issues` | `valid: true` and `missing_requirements` is empty |
| 4 | `validate_admin_security(appId, proposal, tools?)` | `passesSecurityGates`, issues with `path`, `code` and `severity` | No error-level issues, and every warning is explained |
| 5 | `preview_admin_console(appId, proposal, tools?)` | Tabs, columns, actions, the role access matrix, blocked fields | The human has seen it and agreed |
| 6 | `apply_admin_update(appId, proposal, { dry_run: true })` | The exact `mcp.json` change | The diff is only `operator_view` |
| 7 | `apply_admin_update(appId, proposal, { confirm: true })` | A commit on `main` and the registration status | `registered` |

Pass `tools` in steps 3–5 when the proposal depends on actions that aren't registered yet.
The tools are then checked against your proposed `tools` array instead of the live ones.
Step 7 checks against the repo's committed `mcp.json`. **If the change adds or edits
actions, commit and deploy those first** (an ordinary push to `main`), then apply the
contract.

The result of step 7:

- **`registered`:** done.
- **`pending`:** the deploy is still running. Check `deploy_status`, then run
  `inspect_admin_console` again.
- **`failed`:** the deploy refused the manifest. Read the deploy log and fix the cause.
- **`deployed_contract_differs`:** something else changed the contract. Inspect it before
  you do anything else.

## Rules

1. **Never `confirm: true` without a `dry_run` first and a human's yes.**
   `apply_admin_update` commits to `main`, and `main` deploys.
2. **Never put a secret in a contract.** A column whose name is on the sensitive-field list
   is refused (`secret_exposure`). Don't rename a real secret to get past the check. Only
   rename a field that isn't a secret.
3. **The actions are the security boundary.** Every referenced action must require auth and
   declare `auth.app_roles` without `member`. Its SQL must be row-scoped, or declared
   `caller_unscoped` with a real reason. An operator query that reads every user's rows is
   unscoped by design, so say so in the reason.
4. **Destructive means `step_up`.** Mark any action that deletes, suspends or is
   irreversible as `destructive: true`, and give its tool `"step_up": true`.
5. **Writes key on the row.** Every `UPDATE`/`DELETE` must use a param mapped from the row
   (`unscoped_write` otherwise). Status changes are a `transition`, and the SQL checks the
   from-status: `… WHERE id = :id AND status = :from_status`.
6. **Admin roles must be usable.** Each `admin_access.roles` entry should appear in the
   `auth.app_roles` of the actions those admins need (`admin_role_grants_nothing`
   otherwise). Never `member`, never `public`.
7. **Don't promise what the console doesn't do.** There is no generic create or edit form.
   A write is a declared row action. For a form or a multi-step flow, build a custom panel
   with the SDK admin hooks (`AdminConsole`, `useAdminContext`, `useAction`).
8. **Report what happened.** Say what was applied, the commit, the registration status, and
   which roles still need granting (the owner does that under **Settings → Access**). Don't
   report `pending` as done.

## Reading the results

- `errors[].path` and `security_issues[].path` point into the proposal, for example
  `operator_view.actions[1].destructive`. Fix the field at that path.
- `missing_requirements` lists actions that aren't registered and columns their query
  doesn't select.
- The [security issue codes](./admin-console.md#security-issue-codes) and
  [gap codes](./admin-console.md#the-agent-workflow) are listed in Admin console.
- HTTP errors from the console routes are in
  [Admin console → Error codes](./admin-console.md#error-codes).

## Example session

> User: "Let moderators handle reports in my app `stash`."

1. `list_admin_capabilities()`.
2. `inspect_admin_console("stash")`: there is a `reports` resource, owner-only, and its
   actions are on `operator`.
3. Edit `tools`: add `moderator` to `op_list_reports`, `op_report_detail` and
   `op_resolve_report`. Push, and wait for `deploy_status` to report success.
4. Proposal: the stored contract plus `"admin_access": { "roles": ["moderator"] }`.
5. `propose_admin_update` returns `valid: true`. `validate_admin_security` passes, with
   no `admin_role_grants_nothing` warning.
6. `preview_admin_console`: show the role access matrix and get a yes.
7. `apply_admin_update` with `dry_run`, then with `confirm: true`: `registered`.
8. Tell the user: "Done. Grant `moderator` to each moderator under Settings → Access. They
   will see the app in their console with only the Operator tab. The audit trail stays
   yours."

## See also

- [Admin console](./admin-console.md): overview, worked example, API reference
- [Migrating an operator view](./admin-console-migration.md)
- [MCP app tools → Console operator view](./mcp-app-tools.md#console-operator-view-operator-view):
  the full contract reference
- [App Actions and Data Access Security](./app-actions-security.md)
- [Agent Skills](./skills/index.md)
