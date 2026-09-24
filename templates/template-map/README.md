# template-map

Map-centred template for [ProAppStore](https://proappstore.online): the map is the
workspace. Records ("places") sit on a full-width map as markers with clustering,
selection and a detail panel; the same records are a keyboard-navigable list with
the same search, category filter and "near me" ordering. Signed-in users add, edit,
hide and delete their own places; editors and admins manage every record and the
categories from a table. Maps run on `app.maps` (geocoding, reverse geocoding,
OpenStreetMap tiles), photos on `app.storage`. No map provider key anywhere.

Written from the Application Standard, not extracted from an existing app: the
archetype investigation (#179) found no safe map-first source to copy.

Scaffold with the CLI once the template is in the catalogue:

```bash
npm i -g @proappstore/cli
pas create my-map-app --template template-map
```

## When to pick this template — and when not

Pick it when **the map is the primary workspace**: field inventories, community
maps, trail or venue directories, delivery or transport overviews where every record
is a point and users think in "where". Do **not** pick it for a two-sided market
with listings, requests and messaging — that is `template-marketplace`, which has
a map mode behind `MAPS_ENABLED` — nor for back-office records (`template-workspace`)
or membership groups (`template-membership`).

## What's in here

- `migrations.json` — `categories`, `places` (owner, category, name, description, address, lat/lng, status, optional photo key). Additive-only, indexed for viewport and owner queries.
- `mcp.json` — 17 registered actions, all authenticated. `list_places` / `count_places` are the **single predicate** the map and the list share (visible = active, or the caller's own; optional category, text and viewport filters, antimeridian-safe). Owner-scoped writes (`create_place`, `update_place`, `set_place_status`, `delete_place`); coordinates and categories validated in SQL. `admin_*` tools are gated by the app roles `admin` / `editor` (assigned with `app.roles` or the console) and declared `caller_unscoped`; `list_categories` / `category_stats` are the shared catalogue.
- `web/src/map/geo.ts` — Web-Mercator projection, viewport bounds, tile addressing, fitting, grid clustering, haversine. Pure functions, tested in `qa/geo.mjs`.
- `web/src/map/MapView.tsx` — the slippy map with **no library**: OSM raster tiles (the same server `app.maps.staticUrl` uses), drag / wheel / pinch / arrow-key navigation, clustered markers as real buttons, selection, a pick mode for the form, an offline banner and the OSM attribution.
- `web/src/api.ts` — `initPro` on platform-cookie auth, typed helpers, an `ActionError` that tells 403 (denied) from offline, and the **extension points**: `RECORD` noun, `STORAGE_ENABLED`, `GEOCODING_ENABLED`, `MANAGER_ROLES`, `DEFAULT_VIEW`.
- `web/src/pages/` — Map (full-bleed map, filter bar, near me, side panel on desktop / bottom sheet on mobile, detail panel), List (the accessible alternative), Place (detail, directions, owner actions), form (tap the map, geocode an address, use the device, photo), Mine, Admin (categories + all records table), Settings.
- `web/src/components.tsx` — `State` renders the five required states (loading, empty, offline, denied, error) with `data-state` hooks for tests.
- `template.json` — the catalogue entry (validated against `catalogue.schema.json` by the platform test).
- `qa/actions.mjs`, `qa/geo.mjs`, `qa/demo-data.json` — negative tests per scoped action, geometry tests, and clearly-labelled **demo data** (fictional places and fake owner ids; never load into production).
- `e2e/` — Playwright against the live app, run by the canonical deploy workflow: deployment smoke, keyboard list alternative, map/list parity, mobile bottom sheet vs desktop panel, and API-level authorization (unauthorized write → 401, role-gated admin, cross-user hidden record with a second session).

## Permissions model

| Can | signed-in user | editor / admin (app role) |
|---|---|---|
| see active places, search, filter, list | ✓ | ✓ |
| see their own hidden places | ✓ | — (admin table shows every status) |
| add places; edit, hide, delete their own | ✓ | ✓ |
| edit, hide, delete anyone's place | | ✓ |
| manage categories | | ✓ |

Roles are platform app roles: `app.roles.assign(userId, 'editor')` by the app
owner, or the console. `MANAGER_ROLES` in `api.ts` lists which roles unlock the
admin page; the actions enforce the same list server-side through `auth.app_roles`.

## Extending

| You want | Change |
|---|---|
| A different record noun | `RECORD` in `api.ts`; column names stay |
| More fields on a record | a new migration (`ALTER TABLE places ADD COLUMN …` nullable/defaulted), thread it through `create_place` / `update_place` and the column list, and the form |
| No photos | `STORAGE_ENABLED = false` — no upload UI, no storage calls, no dead import |
| No geocoding | `GEOCODING_ENABLED = false` — coordinates by map tap, typing or device only |
| Routing / directions in-app | `app.maps.route(from, to)` from the detail panel; today "Directions" opens OpenStreetMap |
| Real-time presence on the map | `app.rooms` broadcasting positions; keep records in D1 |
| Heavy tile traffic | front `tileUrl` through `app.proxy` or a tile provider — OSM's public tiles are for light use |

## Standard audit (1.5)

Static audit at staging: `pas check` passes all 20 checks with no warnings; the
manifest registers through the platform's own validation and the migrations pass the
additive-only lint (`test/template-map.test.ts` in the platform repository). Every
statement is owner- or visibility-scoped on `:__user_id`; management tools are
app-role gated and declared `caller_unscoped`. PAS-STACK-017: no provider key, tiles
and geocoding through `app.maps`' OpenStreetMap backing. The base template's three
deviations are fixed (PAS-AUTH-001, PAS-UI-002, PAS-UI-007). Known deviations: none.
Live checks run once an app built from this template is deployed; the e2e suite runs
on every deploy.

## License

MIT.
