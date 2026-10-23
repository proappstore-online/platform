# Approved templates

The catalogue of templates a ProAppStore app may be provisioned from, and the
selection contract every provisioning path applies. Machine-readable copy:
[`templates/catalogue.json`](./catalogue.json) (schema:
[`catalogue.schema.json`](./catalogue.schema.json)); the MCP tool
`list_templates` returns the same data.

There are two approved templates today. The catalogue exists so that template
selection is governed — identity, purpose, compatibility, security status,
maintainer, reviewed revision, deprecation — not so that it is long. Entries are
added only for reviewed, maintained templates (see
[#179](https://github.com/proappstore-online/platform/issues/179) and
[#180](https://github.com/proappstore-online/platform/issues/180) for the
candidates under investigation).

## Selection contract

| You name… | Provisioning does |
|---|---|
| nothing | uses the **default** (`template-app`) |
| an **approved** id | proceeds |
| a **deprecated** id | proceeds and records a warning naming the replacement |
| an **unknown** or **withdrawn** id | **refuses** (400 from `/v1/provision`; `Refused:` from `provision_pas_app`; an error from `pas create`) and lists the approved ids. A platform admin may pass an explicit override, which is recorded on the app |

Every path — `pas create` → `pas publish`, the MCP `provision_pas_app` and
`scaffold_app` tools, and `POST /v1/provision` — records **which template and
which exact source commit** was copied on the app row (`apps.template_id`,
`apps.template_rev`, returned by `GET /v1/apps` and the `app_info` tool). The
revision is the template repository's branch head read just before the copy,
recorded only when the new repository's initial tree proves it is what GitHub
copied (#369): the copy API takes no revision, so a template that moves during
the copy is caught, and provisioning stops with the repository kept. If it
cannot be resolved or proven it is recorded as unknown, never guessed. The
catalogue's `release.source_commit` is the *reviewed* revision; the app's
`template_rev` is the *copied* one — normally equal, and the difference is
exactly what an audit wants to see.

A console submission (`POST /v1/submissions`) carries the same two facts as
`template` and `templateRev`, checked against the catalogue with no override,
and its `repoUrl` may only be `https://github.com/proappstore-online/<appId>`.
Approval re-checks the template against the catalogue and provisions exactly
what was submitted (#366). A submission that names no template, including every
one made before this, is approved with its provenance recorded as unknown
(`template_id` NULL), never attributed to `template-app`.

## How the create-app workflow uses it

1. Read [`catalogue.json`](./catalogue.json) (or call `list_templates`).
2. Pick the approved template whose `supported_categories` and `capabilities`
   fit; explain the choice; default to `template-app`.
3. Call `provision_pas_app` with `template_repo: <id>` and `dry_run: true`, then
   with `confirm: true`. Unknown ids are refused before any repository or
   infrastructure is created.
4. Check the result's `Template revision:` line and, later,
   `app_info` → `template_id` / `template_rev`.
5. Apply the template's `security_compliance.known_deviations` on day one —
   they are the Application Standard clauses the scaffold does not yet meet.

## Catalogue

| id | repo@ref | status | reviewed commit | categories | requires | known deviations |
|---|---|---|---|---|---|---|
| `template-app` (default) | `proappstore-online/template-app@main` | approved | `45c69477bcaa` (2026.10.23) | any | sdk >=1.16.78, cli >=2.6.0, node >=22, pnpm 10.x | [PAS-AUTH-001](../standard/auth.md#pas-auth-001) |
| `template-marketplace` | `proappstore-online/template-marketplace@main` | approved | `4b000c9967db` (2026.09.25) | marketplace, real-estate, lifestyle, business, social | sdk >=1.16.61, cli >=2.6.0, node >=22, pnpm 10.x | none |

### `template-app` — ProAppStore app template

The canonical Pro app scaffold: React 19 + Vite 8 + Tailwind 4 web/ workspace, @proappstore/sdk, registered actions (mcp.json), additive D1 migrations (migrations.json), PWA manifest and service worker, the keyless deploy / CI / compliance workflows, and the design tokens. Suits any app category.

- **Capabilities:** platform-auth, registered-actions, d1-migrations, pwa, design-tokens, keyless-oidc-deploy, ci-typecheck, compliance-workflow, app-shell
- **Security / compliance:** reviewed on 2026-10-23 at `45c69477bcaa1499a11ccf68ac4d6b3c1a80b152`. The items migration matches all three registered actions; reads are caller-scoped. The theme boot script uses `stores-theme`, viewport zoom is allowed, and deployment uses the keyless reusable pipeline. After replacing `APPNAME`, 20 source compliance checks pass; two warnings remain for the unbuilt bundle and long `CLAUDE.md`. The remaining standard deviation is [PAS-AUTH-001](../standard/auth.md#pas-auth-001): `initPro()` omits an explicit `authMode`; set the intended mode when building the app. The reviewed source fixture and migration/action isolation tests are in `test/template-app-review.test.ts`.
- **Maintainer:** proappstore-online — https://github.com/proappstore-online/platform/issues
- **Preview:** https://docs.proappstore.online/getting-started/
- **Deprecation:** none

### `template-marketplace` — Two-sided listings marketplace template

Two-sided markets: owners publish listings, seekers browse a public catalogue, save favourites, send a request (booking / application / enquiry — the noun is configurable), message the owner and review after a completed request, with blocks and reports built in. Listing photos through app.storage; an optional map mode (MAPS_ENABLED) geocodes listings through app.maps. Not for apps where the map is the primary workspace (`template-map`), back-office records (`template-workspace`) or community groups (`template-membership`); no payments or escrow.

- **Capabilities:** platform-auth, registered-actions, public-catalogue, d1-migrations, owner-scoping, requests-lifecycle, favorites, messaging, reviews, storage-uploads, maps-optional, pwa, keyless-oidc-deploy
- **Security / compliance:** reviewed on 2026-09-25. Static audit at staging (a268bee, #191): pas check passes every hard check once APPNAME is replaced; the manifest registers through the platform's own validation (manifest rules, PAS-DATA-011 public-tool rules, :__user_id scoping, schema coherence) and the migrations pass the additive-only lint. Five public reads name their columns and never expose a reviewer's id; every other statement is scoped to the owner, requester or message pair, transitions are guarded in SQL, and blocks are enforced in SQL. Fixes the base template's three known deviations (PAS-AUTH-001, PAS-UI-002, PAS-UI-007).
- **Maintainer:** proappstore-online — https://github.com/proappstore-online/platform/issues
- **Preview:** https://docs.proappstore.online/templates/
- **Deprecation:** none

## Candidate archetypes

The 2026-09-23 investigation of the org's app repositories (#179) found three
recurring domain spines and recommends one template for each — membership
groups, back-office records workspace, two-sided listings marketplace — with
an implementation ticket per archetype (#189, #190, #191). Evidence matrix,
scores, what to extract and what must not be copied:
[Template archetypes](./archetypes.md). None is in the catalogue until it
exists as a reviewed template repository.

The marketplace template (#191) is published as `proappstore-online/template-marketplace`
and listed in the catalogue above (#199).

The back-office workspace template (#190) is staged the same way at
`templates/template-workspace/` — workspaces, members, a `permissions` table, single-use
invitations, records with a guarded lifecycle, approvals, and an audit row in every write's
batch — validated by `test/template-workspace.test.ts`, and enters the catalogue once
published as `proappstore-online/template-workspace`.

The membership groups template (#189) completes the set at
`templates/template-membership/` — groups, members with a role, consumable join codes,
events with RSVPs and a waitlist, a thread, an activity log, and app-wide moderation tools
gated by `auth.app_roles` — validated by `test/template-membership.test.ts`, and enters the
catalogue once published as `proappstore-online/template-membership`.

The map-centred template (#180) is staged at `templates/template-map/`. The
archetype investigation recommended maps as a mode of the marketplace template
rather than a fourth archetype; this template exists for apps where the map is
the *primary workspace* and was written from the standard, not extracted from an
app. It enters the catalogue once published as `proappstore-online/template-map`.
Pick it only when every record is a point and users think in "where"; two-sided
markets with a map belong to `template-marketplace` with `MAPS_ENABLED`.

### Publishing a staged template

Each staged template ships its catalogue entry as `template.json`, validated against
`catalogue.schema.json` by its test. The entry stays out of the catalogue until the
template repository exists, because the provisioner copies from `repo` (#199). Its
`release.source_commit` is all zeros until then, and the catalogue test refuses that
placeholder. To publish one (an org owner creates the repository, since members cannot):

1. Create `proappstore-online/template-<name>`, mark it as a GitHub template repository, and
   push `templates/template-<name>/` as its root
   (`git subtree split --prefix templates/template-<name>`).
2. Confirm its `ci.yml` and `compliance.yml` are green. Its deploy workflow skips only
   `template-app`, so its Deploy job runs in the template repository itself and fails at
   Build on the unreplaced placeholders; nothing is uploaded.
3. Copy `template.json` (without `$comment`) into `packages/build-core/src/template-catalogue.ts`
   with `release.source_commit` set to the pushed commit, then run
   `node scripts/build-template-catalogue.mjs` to regenerate `catalogue.json`.

## Adding, deprecating, withdrawing

A newer template head needs a fresh review before advancing its reviewed
revision. For `template-app`, preserve the relevant source files verbatim in
`test/fixtures/template-app-review.json`, together with the exact commit and
review date. Run the source compliance checks after substituting `APPNAME` and
the migration/action isolation checks in `test/template-app-review.test.ts`.
Update the actual requirements and remaining deviations in the catalogue, then
regenerate its public JSON and update this guide. Do not remove a deviation just
because the template head changed.

A template enters the catalogue only after it exists as a GitHub template
repository in `proappstore-online`, passes `pas check`, has been audited
against the [Application Standard](../standard/index.md) with its deviations
listed, and has a maintainer. Deprecation keeps the entry (status
`deprecated`, with `replaced_by` and a reason) so existing apps' provenance
still resolves; withdrawal keeps the entry too and makes provisioning refuse
it. Entries are never deleted or renamed — `template_id` on existing apps must
always resolve. The source of truth is
`packages/build-core/src/template-catalogue.ts`; `catalogue.json` is generated
from it and a test fails on drift.
