# template-marketplace

Two-sided listings marketplace template for [ProAppStore](https://proappstore.online):
owners publish listings, seekers browse a public catalogue, save favourites, send a
request (booking / application / enquiry — you pick the noun), message the owner and
review after a completed request. Blocks and reports are built in.

Scaffold with the CLI once the template is in the catalogue:

```bash
npm i -g @proappstore/cli
pas create my-market --template template-marketplace
```

## What's in here

- `migrations.json` — `listings`, `favorites`, `requests`, `messages`, `reviews`, `blocks`, `reports`. Additive-only; applied on every deploy before actions register.
- `mcp.json` — 28 registered actions. Five are **public** catalogue reads (`list_listings`, `search_listings`, `get_listing`, `list_reviews`, `listing_stats`: named columns, literal `LIMIT`, called with `callPublic`); every other statement is scoped to the owner, the requester or the message pair with `:__user_id`, and every state transition is guarded in SQL (`AND status = :from`).
- `web/src/api.ts` — `initPro` on platform-cookie auth, typed action helpers, and the **extension points**: `REQUEST` (the noun), `CATEGORIES`, `MAPS_ENABLED`.
- `web/src/App.tsx` — hash router; browse and listing detail render without a session, everything else inside `ProShell`.
- `web/src/pages/` — Browse + Saved, Listing (request, review, message), Requests (mine) + Inbox (owner transitions), Owner dashboard + listing form (photos via `app.storage.uploadUserPublic`, optional geocode), Messages, Settings (block / report).
- `qa/actions.mjs` — negative tests per scoped action against a real SQLite built from `migrations.json` (`pnpm test`).
- `.github/workflows/` — keyless deploy (migrations → actions → R2), compliance, CI typecheck.

## Extending

| You want | Change |
|---|---|
| A different request noun (booking, application, match) | `REQUEST` in `api.ts`; status names in `set_request_status` if the lifecycle differs |
| Listing attributes (bedrooms, salary, make/model) | add nullable or defaulted columns in a new migration, thread them through `create_listing` / `update_listing` and the public column list, and the form |
| A map on listings | `MAPS_ENABLED = true` — geocodes the location on save with `app.maps.geocode` and embeds `app.maps.embedUrl` on the detail page |
| Real-time chat in the thread | add `app.rooms` on top of the polling `Thread`; keep `send_message` as the record |
| Notifications on request status | `app.notifications` from the Inbox transitions |

## What this template deliberately does not do

Payments and escrow (the platform subscription is the only billing), real-time dispatch or
tracking, server-authoritative matching, community groups. No seed tooling ships in the
manifest; use `pas` or the console to load demo data.

## Security notes

- Public tools expose the owner's chosen display name and platform user id (needed to message them) and never a reviewer's id.
- `create_request` and `send_message` refuse blocked pairs in SQL, not in the UI.
- Reviews attach to a completed request the caller made, once (`UNIQUE(request_id)`).
- Archiving is the soft delete; history stays consistent.

## Standard audit (1.5)

Static audit at the time of staging: `pas check` passes all 20 checks with no warnings;
the manifest registers through the platform's own validation (manifest rules, PAS-DATA-011
public-tool rules, `:__user_id` scoping, schema coherence) and the migrations pass the
additive-only lint — see `test/template-marketplace.test.ts` in the platform repository.
The three deviations the base template carries are fixed here: `initPro` sets
`authMode: 'platform-cookie'` (PAS-AUTH-001), the theme boot script reads `stores-theme`
(PAS-UI-002), and the viewport allows zoom (PAS-UI-007). Known deviations: none. The
live checks (reachability, served manifest, fonts, tracking) run once an app built from
this template is deployed.

## License

MIT.
