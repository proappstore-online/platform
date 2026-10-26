---
description: "Find an app's ownership, repository, route and live status, or check whether an app ID is available before provisioning."
---

# App directory

Status: **shipped** (#424). One place to answer: does this app exist, is it
mine, is it live, and which repository and route belong to it? It also
answers whether an id is free before anyone provisions it.

Code: `packages/backend/src/routes/app-directory.ts` (API),
`packages/mcp/src/directory-tools.ts` (MCP `find_apps`), and the console's
Directory tab (`proappstore-online/console`, `web/src/DirectoryView.tsx`, `#/directory`).

## What is listed

`GET /v1/apps/directory` returns every app the caller can reach, plus their drafts:

| Access level | Means |
|---|---|
| `owner` | the caller created it (`apps.creator_id`), or it is their draft |
| `team` | a `team_members` row (with `teamRole`) |
| `operator` | one of the app's declared `admin_access` roles (#297) |
| `transfer_recipient` | its owner offered it to the caller in a pending, unexpired transfer (#423) |
| `inaccessible` | only for the one id a search names, when someone else holds it |

`pendingTransfer` is `incoming` or `outgoing` for an open transfer either way.

## Lifecycle

Each app gets one `lifecycle`, checked in this order:

| Lifecycle | Rule |
|---|---|
| `draft` | no registry row yet: an agent project, or an open provisioning plan |
| `failed` | `provision_operations.status = 'failed'` |
| `live` | listed on the storefront (`app_storefront_publication.listed = 1`, #399) |
| `unpublished` | has a submission (pending, approved, rejected, published) but is not listed |
| `archived` | delisted (`listed = 0`, only ever written by an unlisting) with nothing in review |
| `deployed` | a CI deploy ran (`deploy_audit`), never submitted |
| `provisioned` | registered, nothing deployed yet |

`deployStatus` is `not_provisioned`, `provisioning`, `provision_failed`,
`deployed` or `not_deployed`, plus `lastDeployAt`.

**Route health is not stored.** The API always returns `routeHealth: null`.
`find_apps` with `check_health: true` measures it live through the host
worker for up to 25 results: `ok` (a private app's marked refusal counts as
up), `down` or `timeout`. `app_info` does the same for one app.

## Search

`q` matches the id, the display name (latest submission, else the agent
project name) and the custom domains of apps the caller reaches. One of these
names a single exact id:

- the id itself;
- `https://<id>.proappstore.online`, including the `data-` and `about-` hosts;
- `https://proappstore.online/apps/<id>/`;
- `github.com/proappstore-online/<id>`;
- one of the caller's custom domains.

When it does, `lookup` gives the answer for that id:

| `lookup.status` | Means |
|---|---|
| `yours` / `accessible` | in the list above |
| `unclaimed` | no registry row, provisioning claim or agent project holds it |
| `reserved` | a platform hostname (`admin`, `agents`, `api`, `console`, `dashboard`, `docs`, `kb`, `mcp`, `www`) or a `data-` / `about-` prefix |
| `exists_inaccessible` | someone else holds it |
| `invalid` | a PAS or GitHub URL that names no app id |

An `exists_inaccessible` id appears as one item with only public facts: its
route, and its store page if it is listed. It never shows the holder, the real
display name or the repository. Its `links.ownership` points at the #423 status
and recovery flow. The console offers the recovery request inline.

## Filters and links

`status` and `access` (`mine`, `team`, `operator`, `transfer`, `inaccessible`)
take one value or a comma-separated list. `limit` is 1–200 (default 50);
`truncated` says when more matched. The response is `Cache-Control: private, no-store`.

`links` holds only what the caller can use:

- `details`: the console app page, or its operator tab for operator access;
- `deployHistory` and `repository`: GitHub, owner and team only;
- `ownership`: always, `/v1/apps/<id>/ownership`;
- `storePage`: only when live.
