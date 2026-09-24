# APPNAME (Pro)

A Pro app on ProAppStore, built from `template-membership`: groups with roles, consumable
join codes, events with RSVPs and a waitlist, a group thread, and an activity log. One
deployment hosts many groups.

- Subdomain: `APPNAME.proappstore.online`
- Dev: `pnpm install && pnpm dev`
- Test: `pnpm test` (typecheck + `qa/actions.mjs`, the negative tests per scoped action)
- Build: `pnpm build` (runs the platform compliance check via prebuild)
- Deploy: `git push origin main` (migrations → actions → R2, keyless)

Platform conventions, SDK modules and the Application Standard: https://proappstore.online/skills.md

## Layout and extension points

`README.md` describes every file and the permissions model. The knobs are in
`web/src/api.ts`: `GROUP`, `ROLES`, `ROOMS_THREAD`, `STORAGE_AVATARS`.

## Invariants this app relies on

- Every read and write is a registered action in `mcp.json`; never `app.db` in a user path.
- Every group statement scopes through a membership sub-query on `:__user_id`; role gates are
  in SQL. The group id in the URL is a hint, never trusted.
- Join codes are consumable: the role comes from the code, the use is counted in the same batch.
- App-wide moderation tools are gated by `auth.app_roles: ["admin"]` and are the only
  `caller_unscoped` statements — declare any new one the same way, with a reason.
- Creates are idempotent by client id; batches end with the activity row.
- Schema lives in `migrations.json`, additive only; never edit an applied migration.
- Add a negative test to `qa/actions.mjs` for every scoped action you add.
