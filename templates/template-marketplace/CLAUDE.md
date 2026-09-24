# APPNAME (Pro)

A Pro app on ProAppStore, built from `template-marketplace`: a two-sided listings
marketplace — public catalogue, owner-scoped listings, favourites, requests with a guarded
lifecycle, pair messaging, reviews after completion, blocks and reports.

- Subdomain: `APPNAME.proappstore.online`
- Dev: `pnpm install && pnpm dev`
- Test: `pnpm test` (typecheck + `qa/actions.mjs`, the negative tests per scoped action)
- Build: `pnpm build` (runs the platform compliance check via prebuild)
- Deploy: `git push origin main` (migrations → actions → R2, keyless)

Platform conventions, SDK modules and the Application Standard: https://proappstore.online/skills.md

## Layout and extension points

`README.md` describes every file. The knobs are in `web/src/api.ts`: `REQUEST` (the noun
each side uses — booking, application, enquiry), `CATEGORIES`, `MAPS_ENABLED`.

## Invariants this app relies on

- Every user-facing read and write is a registered action in `mcp.json`
  (`app.actions.call` / `callPublic`). Never `app.db` in a user path.
- A public tool (`requires_auth: false`) is a `query` with named columns and a literal
  `LIMIT`, never `:__user_id`. Anything about a person's own data is scoped.
- State transitions carry `AND status = :from`; creates are idempotent by client id.
- Blocks are enforced in SQL (`create_request`, `send_message`), not in the UI.
- Schema lives in `migrations.json`, additive only; never edit an applied migration.
- Add a negative test to `qa/actions.mjs` for every scoped action you add.
