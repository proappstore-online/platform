# APPNAME (Pro)

A Pro app on ProAppStore, built from `template-map`: the map is the workspace —
places with a category as clustered markers, a detail panel, search / filters /
near me, a keyboard-accessible list of the same records, owner-scoped editing, and
an admin table for records and categories.

- Subdomain: `APPNAME.proappstore.online`
- Dev: `pnpm install && pnpm dev`
- Test: `pnpm test` (typecheck + `qa/actions.mjs` + `qa/geo.mjs`); `e2e/` runs on deploy
- Build: `pnpm build` (runs the platform compliance check via prebuild)
- Deploy: `git push origin main` (migrations → actions → R2 → e2e, keyless)

Platform conventions, SDK modules and the Application Standard: https://proappstore.online/skills.md

## Layout and extension points

`README.md` describes every file, the permissions model and when this template
fits. The knobs are in `web/src/api.ts`: `RECORD`, `STORAGE_ENABLED`,
`GEOCODING_ENABLED`, `MANAGER_ROLES`, `DEFAULT_VIEW`.

## Invariants this app relies on

- Every read and write is a registered action in `mcp.json`; never `app.db` in a user path.
- The map and the list read the same actions with the same filters (`list_places`
  + `count_places`); never give one of them a different predicate.
- Visibility is `status = 'active' OR owner_id = :__user_id`; writes are owner-scoped;
  `admin_*` tools are gated by `auth.app_roles: ["admin", "editor"]` and are the only
  `caller_unscoped` statements besides the category catalogue.
- Maps: no provider key, no map library. Tiles come from the server `app.maps.staticUrl`
  uses; geocoding through `app.maps`. Keep the OpenStreetMap attribution.
- Schema lives in `migrations.json`, additive only; never edit an applied migration.
- Add a negative test to `qa/actions.mjs` for every scoped action you add.
