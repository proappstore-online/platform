# APPNAME (Pro)

A Pro app on ProAppStore, built from `template-workspace`: a back-office records workspace —
members with roles and permissions, single-use invitations, records with a lifecycle, an
approvals queue, reports and export, and an audit trail written with every change.

- Subdomain: `APPNAME.proappstore.online`
- Dev: `pnpm install && pnpm dev`
- Test: `pnpm test` (typecheck + `qa/actions.mjs`, the negative tests per scoped action)
- Build: `pnpm build` (runs the platform compliance check via prebuild)
- Deploy: `git push origin main` (migrations → actions → R2, keyless)

Platform conventions, SDK modules and the Application Standard: https://proappstore.online/skills.md

## Layout and extension points

`README.md` describes every file and the permissions model. The knobs are in
`web/src/api.ts`: `RECORD_TYPES`, `PERMISSION_KEYS`, `ROLES`.

## Invariants this app relies on

- Every read and write is a registered action in `mcp.json`; never `app.db` in a user path.
- Every statement scopes on the workspace through a membership sub-query on `:__user_id`.
  The active workspace id from the client is a hint (kept in `app.kv`), never trusted.
- Privileged writes check the role or a `permissions` key in SQL, not in the UI.
- Every state-changing write is a `batch` whose last statement is the `activity_log` row,
  guarded on the write's post-state (a refused write leaves no audit row).
- Transitions carry `AND status = …` guards; creates are idempotent by client id.
- Schema lives in `migrations.json`, additive only; never edit an applied migration.
- Add a negative test to `qa/actions.mjs` for every scoped action you add.
