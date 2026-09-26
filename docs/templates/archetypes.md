# Template archetypes — evidence and recommendation

**Investigation #179** · related: [template catalogue](./index.md) (#178), Agent Skills epic #168 · standard version 1.6 · investigated 2026-09-23

Machine-readable evidence: [`archetype-evidence.json`](./archetype-evidence.json) (validated by `test/docs-archetypes.test.ts`). This page is the narrative and the recommendation.

## Method

All 26 app repositories of `proappstore-online` cloned locally were fetched to `origin/main` and inventoried by script: purpose (README / storefront), licence, size, SDK version, `mcp.json` (registered actions by operation, `requires_auth`, scoping predicates, `caller_unscoped`), `migrations.json` (tables, tenant columns) or runtime schema, SDK modules used, `initPro` auth mode, theme key, viewport, PWA plugin settings, workflows (keyless deploy, migrations step, stored tokens), tests and e2e, `pas check` (20 checks), and debt counters (browser storage of state, raw `app.db` in user paths, `auth.token` use, HTML sinks). Live status was checked on every `<app>.proappstore.online`; storefront demand comes from the 21 listings in the storefront registry and the domain lists in [Tailored vs Ready](../tailored-vs-ready.md). Four worktrees of `crm` (`crm-issue*`) and a smoke repo were excluded; `carsads`, `clean-up`, `dog-walking-app`, `micro`, `studio`, `tt` are listed on the storefront but not cloned, so they count as demand only.

**Platform conventions versus app code.** Everything the template already gives every app — `initPro`, the SDK, registered actions on D1, additive migrations, the keyless deploy / CI / compliance workflows, the PWA shell, the design tokens — is *convention* and is not evidence for an archetype. An archetype is a recurring **domain spine** (tables, actions, scoping model, pages) that several unrelated apps rebuilt independently.

## Evidence matrix

| App | Purpose (storefront category) | Actions / migrations / tables | Services | Auth mode · theme · zoom | Deploy · tests · `pas check` | Debt (ls / rawdb / token / html) | Reuse | Archetype |
|---|---|---|---|---|---|---|---|---|
| `aipa-console` | Console exercise (proxy, roles), no data (—) | 0 / 0 / 0 | proxy, roles | platform-cookie · fas:theme · blocked | not keyless · 0 tests · — | 0 / 0 / 0 / 0 | no — no data model | none |
| `aiuniversity` | Course catalogue exercise on the template (—) | 4 / 0 / 0 | auth, db, roles | none · fas:theme · blocked | keyless · 0 tests + e2e · — | 0 / 8 / 0 / 3 | no — raw app.db in user paths; exercise | none |
| `austax` | Static tax calculator, no SDK (—) | 0 / 0 / 0 | — | no-initPro · - · ok | not keyless · 0 tests · — | 0 / 0 / 0 / 0 | no — no SDK | none |
| `bandmates` | Musicians find bands; bands manage members, vacancies, events, documents (social) | 117 / 32 / 11 | actions, auth, db, rooms, storage | none · - · blocked | keyless + migrations · 1 tests · 3/20 | 12 / 0 / 0 / 2 | with-fixes — MIT; legacy-bearer, no PWA plugin, 12 localStorage search keys | membership |
| `chess-academy` | Children's chess clubs: organisations, schools, classes, games, puzzles, tournaments (education) | 120 / 47 / 26 | actions, auth, db, invites, logs, notifications, rooms, storage | platform-cookie · stores-theme · blocked | keyless + migrations · 92 tests · 0/20 | 12 / 3 / 5 / 4 | yes — MIT; platform-cookie, stores-theme, 92 tests, 0 compliance failures | membership |
| `coffeerating` | Empty scaffold (—) | 0 / 0 / 0 | — | no-initPro · - · ok | not keyless · 3 tests + e2e · — | 0 / 0 / 0 / 0 | no — empty scaffold, no source to reuse | none |
| `crm` | Brand-neutral CRM / PSA: companies, contacts, deals, projects, time, approvals, invoices (—) | 112 / 2 / 30 | actions, auth | platform-cookie · - · ok | keyless + migrations · 231 tests · 0/20 | 19 / 0 / 0 / 5 | with-fixes — MIT (ported from ~/work/crm per PAS_PORTING.md); localStorage active-org id, engines >=20, no compliance.yml | workspace |
| `dating` | Swipe dating: profiles, matches, chat, blocks, reports (social) | 18 / 2 / 6 | actions, auth, db, kv, rooms, storage | none · - · blocked | keyless + migrations · 0 tests · 4/20 | 0 / 0 / 0 / 1 | with-fixes — MIT; legacy-bearer, seed_demo_profile tool in the manifest | marketplace |
| `doordrop` | Two-sided flyer-delivery marketplace (ported from a Firebase app; custom Worker API) (logistics) | 0 / 0 / 0 | — | none · - · blocked | not keyless · 0 tests · 4/20 | 0 / 0 / 1 / 0 | no — custom Worker API instead of registered actions (PAS-DATA-014); Leaflet instead of app.maps; port of a Firebase app | marketplace |
| `flights` | Flight search and saved trips (standalone template exercise) (travel) | 0 / 0 / 0 | ai, db, kv, maps | none · fas:theme · blocked | not keyless · 0 tests · — | 0 / 1 / 0 / 0 | no — template-standalone exercise | none |
| `freedocstore-editor` | Editor exercise (kv, proxy), no data (—) | 0 / 0 / 0 | kv, proxy | platform-cookie · - · ok | not keyless · 0 tests · — | 9 / 0 / 0 / 0 | no — no data model | none |
| `grasskarma` | Neighbours share a mower street by street: groups, schedules, reviews (marketplace) | 37 / 1 / 9 | actions, auth, db, storage | platform-cookie · - · blocked | keyless + migrations · 0 tests · 4/20 | 0 / 0 / 0 / 0 | with-fixes — MIT; platform-cookie; 4 compliance failures; street groups + storage-heavy reviews | membership |
| `interns` | Internship management: organisations, positions, applications (business) | 44 / 0 / 0 | actions, auth, db, notifications | platform-cookie · stores-theme · blocked | keyless · 14 tests + e2e · 0/20 | 0 / 0 / 0 / 0 | with-fixes — MIT; runtime schema, pages folded into App | membership |
| `jobs` | Job board: companies post jobs; users search, save, apply (business) | 35 / 4 / 6 | actions, auth, db | platform-cookie · fas:theme · blocked | keyless + migrations · 0 tests · 5/20 | 0 / 0 / 0 / 2 | with-fixes — MIT; legacy-bearer, catalogue reads declared requires_auth true + caller_unscoped | marketplace |
| `kanban` | Team kanban boards in workspaces with invites, assignees, live presence (productivity) | 84 / 0 / 0 | actions, auth, db, notifications, rooms | none · fas:theme · blocked | keyless + migrations · 0 tests · 4/20 | 6 / 0 / 0 / 0 | with-fixes — MIT; legacy-bearer, fas:theme, runtime schema (no migrations.json) | membership |
| `leads` | Lead management in projects with members and invites (—) | 54 / 9 / 8 | actions, auth | none · fas:theme · blocked | keyless + migrations · 0 tests · 0/20 | 0 / 0 / 0 / 0 | with-fixes — MIT; legacy-bearer, fas:theme, non-consumable project_invites | membership |
| `loopride` | Recurring rides with a driver; map and rooms (transport) | 0 / 0 / 0 | auth, kv, maps, rooms | none · - · blocked | not keyless · 12 tests · 4/20 | 9 / 0 / 1 / 0 | no — MapLibre instead of app.maps; no registered actions; legacy-bearer | marketplace |
| `meet` | Instant 1-on-1 video meetings with availability and push (social) | 6 / 1 / 1 | actions, auth, db, kv, notifications, rooms | none · - · blocked | keyless + migrations · 7 tests · 3/20 | 0 / 0 / 0 / 0 | with-fixes — MIT; legacy-bearer, 1 table | none |
| `meetup` | Groups, events, RSVPs, waitlists, group chat (social) | 45 / 11 / 7 | actions, auth, db, maps, rooms, storage | none · - · blocked | keyless + migrations · 1 tests · 4/20 | 2 / 0 / 0 / 0 | with-fixes — MIT; legacy-bearer, no PWA plugin, no ci.yml | membership |
| `parents-clubs` | Template exercise (items / activities / responses) (—) | 5 / 3 / 3 | db | none · fas:theme · blocked | keyless + migrations · 2 tests · — | 0 / 2 / 0 / 0 | no — scaffold exercise | none |
| `prolang` | Firebase-based language app, not ported (education) | 0 / 0 / 0 | — | no-initPro · - · blocked | not keyless · 0 tests · — | 0 / 0 / 0 / 0 | no — Firebase, no LICENSE | none |
| `queueflow` | Template scaffold (items) (—) | 3 / 1 / 1 | — | none · fas:theme · blocked | keyless + migrations · 0 tests · — | 0 / 0 / 0 / 0 | no — scaffold | none |
| `room-rent` | Short-term rentals: listings, bookings, favourites, reviews, host messaging (real-estate) | 24 / 20 / 5 | actions, ai, auth, db, maps, notifications, storage | none · fas:theme · blocked | keyless + migrations · 0 tests · 4/20 | 0 / 2 / 0 / 0 | with-fixes — MIT; legacy-bearer, app.db in a user path (SeedListings) | marketplace |
| `school-clubs` | Template scaffold (items), not deployed (—) | 3 / 1 / 1 | — | none · fas:theme · blocked | keyless + migrations · 0 tests · — | 0 / 0 / 0 / 0 | no — scaffold, 404 live | none |
| `timetrack` | Time tracking, projects, estimates, invoices, expenses, approvals for a company (productivity) | 101 / 8 / 19 | actions, auth, db, storage | platform-cookie · stores-theme · blocked | keyless + migrations · 4 tests · 4/20 | 3 / 0 / 0 / 0 | with-fixes — MIT; platform-cookie; 4 compliance failures (viewport, pwa-offline, html-meta, a11y) | workspace |

`ls` = browser-storage sites holding app state other than the theme; `rawdb` = `app.db.query/execute/batch` in `web/src`; `token` = `auth.token` uses (chess-academy's five are all in tests asserting it is null); `html` = `innerHTML` / `dangerouslySetInnerHTML` sites. `pas check` is the 20-check hygiene scan, not a security audit ([automation levels](../standard/audit-model.md)).

## What recurs

Three domain spines recur across unrelated apps; one candidate named in the issue does not.

| Spine | Apps that rebuilt it | Shared tables / tools observed |
|---|---|---|
| **Membership groups** — group · members with role · invite / join code · events + RSVPs · thread · activity | chess-academy, bandmates, meetup, kanban, leads, interns, grasskarma (7) | `group_members` / `band_members` / `members` / `project_members` with a `role` column and a `UNIQUE(group, user)`; `join_codes` / `invites` / `project_invites` / `join_requests`; `events` ×2, `rsvps`, `messages` ×4, `activity_log(s)` ×3; every statement scoped by a membership sub-query (kanban 122, chess 138, bandmates 84 such statements) |
| **Back-office records workspace** — organisation · members with permissions · invitations · records with a status lifecycle · approvals · audit · invoices | crm, timetrack (complete); kanban, jobs, interns (partial) (2 + 3) | `companies` ×3, `projects` ×3, `invoices` ×2, `time_entries` ×2, `members` ×2; `update_company`, `list/create/update_project` are the only tool names three apps share; crm `access_roles` + `entity_audit`, timetrack `members.permissions` + `activity_log`; 0 unscoped statements in both |
| **Two-sided listings marketplace** — public catalogue · owner-scoped listings · favourites · request (booking / application / match) · pair messaging · reviews | room-rent, jobs, dating (cloned); doordrop, loopride, grasskarma partially; carsads, clean-up, dog-walking-app on the storefront (3 + 3 + 3) | `favorites` ×3, `messages` ×4, `listings` / `jobs` / `profiles`, `bookings` / `applications` / `matches`; public reads declared `caller_unscoped` (room-rent 4, jobs 9); room-rent's `can_leave_review` guard |
| Map-centred directory / field (named in the issue) | room-rent, meetup use `app.maps` as an option; loopride (MapLibre), doordrop (Leaflet, custom Worker) | no shared spine; the two map-first apps bypass the platform — **not an archetype**, an optional capability of the marketplace template |

## Scores

1 = weak, 5 = strong; maintenance cost is inverted (5 = expensive). Demand from the storefront and the strategy's domain lists; genericity from how many unrelated apps share the spine; configurability from how much varies only by nouns; conformity from the cleanest source app's audit posture.

| Archetype | Demand | Genericity | Configurability | Maintenance cost | Standard conformity | Recommendation |
|---|---|---|---|---|---|---|
| Membership groups (`template-membership`) | 4 | 5 | 4 | 2 | 4 | **recommended** → #189 |
| Back-office records workspace (`template-workspace`) | 5 | 4 | 4 | 3 | 4 | **recommended** → #190 |
| Two-sided listings marketplace (`template-marketplace`) | 5 | 3 | 3 | 3 | 3 | **recommended** → #191 |
| Map-centred directory / field app (`map-centered-field`) | 2 | 2 | 3 | 4 | 2 | not recommended |

### Membership groups — `template-membership`

**Ticket:** #189 (the full template definition — intended problems and non-goals, core pages and workflows, required / optional services, schema and action boundaries, extension points, security and tenancy model, metadata and compatibility, extract versus rewrite — lives in the ticket and is summarised here).

- **Evidence apps:** `chess-academy`, `bandmates`, `meetup`, `kanban`, `leads`, `interns`, `grasskarma`.
- **Demand:** social ×4; education ×2; strategy: Events / RSVPs, Light social / community, LMS.
- **Generic spine (extract):** tables `groups`, `group_members`, `join_codes`, `events`, `rsvps`, `messages`, `activity_log`; actions `create_group`, `redeem_code`, `list_members`, `add_member`, `remove_member`, `list_events`, `create_event`, `rsvp_event`, `list_messages`, `post_message`.
- **Services:** required `app.auth`, registered actions, `app.roles`; optional `app.rooms`, `app.storage`, `app.notifications`, `app.invites`.
- **Tenancy:** Ready — group-scoped membership sub-query in every statement.
- **Extract from:** `kanban` — members / invites (consumable) / activity DDL, EXISTS guards; `meetup` — events / rsvps / waitlist actions; `chess-academy` — join-code redemption batch, user_roles idiom; `bandmates` — activity log.
- **Do not copy:** bandmates localStorage search state; leads non-consumable project_invites; meetup missing ci.yml gates; legacy-bearer initPro in bandmates / meetup / kanban / leads.
- **Clauses the template must satisfy first:** [PAS-DATA-007](../standard/data.md#pas-data-007), [PAS-DATA-008](../standard/data.md#pas-data-008), [PAS-DATA-009](../standard/data.md#pas-data-009), [PAS-DATA-022](../standard/data.md#pas-data-022), [PAS-AUTH-001](../standard/auth.md#pas-auth-001), [PAS-AUTH-016](../standard/auth.md#pas-auth-016), [PAS-AUTH-018](../standard/auth.md#pas-auth-018).

### Back-office records workspace — `template-workspace`

**Ticket:** #190 (the full template definition — intended problems and non-goals, core pages and workflows, required / optional services, schema and action boundaries, extension points, security and tenancy model, metadata and compatibility, extract versus rewrite — lives in the ticket and is summarised here).

- **Evidence apps:** `crm`, `timetrack`, `kanban`, `jobs`, `interns`.
- **Demand:** productivity ×5; business ×3; strategy: the whole Tailored domain list (CRM, PSA, quoting, invoicing, HR, ATS, helpdesk, practice management).
- **Generic spine (extract):** tables `workspaces`, `members`, `invitations`, `activity_log`, `approvals`; actions `create_workspace`, `invite_member`, `accept_invitation`, `list_members`, `set_member_role`, `log_activity`, `export_workspace`.
- **Services:** required `app.auth`, registered actions, `app.roles`; optional `app.storage`, `app.email`, `app.notifications`, `app.ai`, `app.logs`.
- **Tenancy:** Tailored by default (one fork per customer) with Ready-compatible workspace scoping.
- **Extract from:** `timetrack` — members / invitations / activity_log DDL, company-scoped actions (0 unscoped); `crm` — approvals and entity_audit idioms, test patterns (231 tests).
- **Do not copy:** crm localStorage['crm.active_org_id'] as the tenant selector; crm engines >=20 and missing compliance.yml; timetrack user-scalable=no and pwa-offline failures; crm 30-table domain schema ported in 2 migrations.
- **Clauses the template must satisfy first:** [PAS-DATA-007](../standard/data.md#pas-data-007), [PAS-DATA-012](../standard/data.md#pas-data-012), [PAS-AUTH-019](../standard/auth.md#pas-auth-019), [PAS-DATA-022](../standard/data.md#pas-data-022), [PAS-STACK-011](../standard/stack.md#pas-stack-011), [PAS-AUTH-001](../standard/auth.md#pas-auth-001), [PAS-STACK-020](../standard/stack.md#pas-stack-020).

### Two-sided listings marketplace — `template-marketplace`

**Ticket:** #191 (the full template definition — intended problems and non-goals, core pages and workflows, required / optional services, schema and action boundaries, extension points, security and tenancy model, metadata and compatibility, extract versus rewrite — lives in the ticket and is summarised here).

- **Evidence apps:** `room-rent`, `jobs`, `dating`, `doordrop`, `loopride`, `grasskarma`.
- **Demand:** marketplace ×2; real-estate; logistics; lifestyle; transport; business (jobs); strategy: Scheduling / booking, Property management, Field service / dispatch.
- **Generic spine (extract):** tables `listings`, `favorites`, `requests`, `messages`, `reviews`, `blocks`, `reports`; actions `list_listings`, `search_listings`, `get_listing`, `create_listing`, `update_listing`, `archive_listing`, `create_request`, `set_request_status`, `list_messages`, `send_message`, `add_favorite`, `remove_favorite`, `can_review`, `create_review`.
- **Services:** required `app.auth`, registered actions, `app.storage`; optional `app.maps`, `app.notifications`, `app.rooms`, `app.ai`, `app.email`.
- **Tenancy:** Ready — public catalogue reads (requires_auth false, capped); owner-, requester- or pair-scoped writes.
- **Extract from:** `room-rent` — listings / bookings / favorites / reviews / messages DDL, can_leave_review and host guards; `jobs` — public search / count / get tools (convert to requires_auth false); `dating` — blocks / reports.
- **Do not copy:** doordrop custom Worker API and Leaflet; loopride MapLibre; dating seed_demo_profile tool; room-rent app.db in a user path; jobs requires_auth true on catalogue reads.
- **Clauses the template must satisfy first:** [PAS-DATA-011](../standard/data.md#pas-data-011), [PAS-DATA-012](../standard/data.md#pas-data-012), [PAS-DATA-007](../standard/data.md#pas-data-007), [PAS-DATA-008](../standard/data.md#pas-data-008), [PAS-STACK-012](../standard/stack.md#pas-stack-012), [PAS-STACK-017](../standard/stack.md#pas-stack-017), [PAS-OPS-016](../standard/ops.md#pas-ops-016), [PAS-DATA-014](../standard/data.md#pas-data-014).

### Map-centred directory / field app — `map-centered-field`

**Not recommended.** Only room-rent and meetup use app.maps, both as an optional feature of a marketplace or membership shape; the two map-centred apps (loopride, doordrop) bypass the platform (third-party map libraries, custom Worker, no registered actions) and cannot be extracted. Maps are an optional capability of template-marketplace, not an archetype.

## Debt that must not be copied into any template

- **Session mode.** 14 of 26 apps call `initPro` without `authMode` (legacy-bearer): every template starts on `platform-cookie` ([PAS-AUTH-001](../standard/auth.md#pas-auth-001)). chess-academy, crm, timetrack, interns, jobs, grasskarma, aipa-console, freedocstore-editor are already migrated.
- **Theme and viewport.** `fas:theme` in 9 apps and `user-scalable=no` in 22 of 26 — both are known deviations of the current template-app ([PAS-UI-002](../standard/ui.md#pas-ui-002), [PAS-UI-007](../standard/ui.md#pas-ui-007)); fixed at the source before any archetype is cut from it.
- **State in browser storage.** crm keeps the active organisation id in `localStorage` (19 sites) and bandmates its search state (12): tenant selection is re-derived from the membership sub-query, preferences go to `app.kv` ([PAS-DATA-020](../standard/data.md#pas-data-020)).
- **Runtime schema.** kanban and interns create tables from app code instead of `migrations.json` ([PAS-DATA-002](../standard/data.md#pas-data-002)).
- **Bypassing the platform.** doordrop's custom Worker API and Leaflet, loopride's MapLibre, dating's `seed_demo_profile` tool, room-rent's `app.db` in a page, aiuniversity's eight raw `app.db` calls ([PAS-DATA-003](../standard/data.md#pas-data-003), [PAS-DATA-014](../standard/data.md#pas-data-014), [PAS-STACK-017](../standard/stack.md#pas-stack-017)).
- **Catalogue reads declared as authenticated.** jobs and meetup expose public catalogue reads with `requires_auth: true` plus `caller_unscoped`; a template ships them as deliberate public queries ([PAS-DATA-011](../standard/data.md#pas-data-011)).
- **Non-consumable grants.** leads' `project_invites` has no `accepted_at`; kanban's `invites.accepted_at` is the shape to copy ([PAS-DATA-008](../standard/data.md#pas-data-008)).
- **Gates.** Only chess-academy, crm, interns and leads pass all 20 compliance checks; only chess-academy (92), crm (231), interns (14) and loopride (12) have meaningful test suites; bandmates, meetup, room-rent, jobs, dating, grasskarma ship no tests.

## Legality of reuse

Every cloned app is MIT-licensed except `prolang` (no LICENSE, Firebase-based, not ported). `crm` is a ProAppStore copy of an external CRM source (`PAS_PORTING.md`) and `doordrop` a port of the Firebase `DoorDrop/platform` app; both are MIT in this org, but the templates extract *shapes* (DDL idioms, guard statements, page inventories), not product code, so no app's product-specific code is copied into a template.

## Decision

Three archetypes are supported by the repositories and recommended; one candidate from the issue is not. Each recommended archetype has its own implementation ticket (#189, #190, #191). A template enters the [catalogue](./index.md) only after it exists as a GitHub template repository, passes `pas check`, is audited against the standard with its deviations listed, and has a maintainer — none of the three exists yet, so `catalogue.json` is unchanged by this investigation.

