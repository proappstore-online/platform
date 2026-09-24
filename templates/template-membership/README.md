# template-membership

Membership groups template for [ProAppStore](https://proappstore.online): clubs, classes,
bands, community groups, small teams. Create a group, hand out join codes that carry a role,
run events with RSVPs and a waitlist, talk in a group thread, and keep an activity log. One
deployment hosts many groups (Ready tenancy).

Scaffold with the CLI once the template is in the catalogue:

```bash
npm i -g @proappstore/cli
pas create my-club --template template-membership
```

## What's in here

- `migrations.json` — `groups`, `group_members`, `join_codes`, `events`, `rsvps`, `messages`, `activity_log`. Additive-only.
- `mcp.json` — 27 registered actions, all authenticated. Every group statement is scoped through a membership sub-query on `:__user_id` (PAS-DATA-007); role gates live in SQL; state-changing writes are batches whose last statement is the activity row, guarded on the write's post-state. Join codes are consumable grants (PAS-DATA-008): the role comes from the code, the use is counted in the same batch, and expiry and `max_uses` are checked in SQL. Two app-wide moderation tools (`admin_list_groups`, `admin_delete_group`) are gated by the platform app role `admin` through `auth.app_roles` (PAS-AUTH-016) and are the only unscoped statements, declared as such.
- `web/src/api.ts` — `initPro` on platform-cookie auth, typed `q` / `x` / `batch` helpers and the **extension points**: `GROUP` (noun), `ROLES`, capability flags `ROOMS_THREAD`, `STORAGE_AVATARS`, `THREAD_POLL_MS`.
- `web/src/pages/` — Landing (my groups), Onboarding (create or join by code), Group home, Members, Events + event detail (RSVP, waitlist, who's coming), Thread, Activity, Profile (display name per group), Admin (roles, join codes, settings).
- `qa/actions.mjs` — negative tests per scoped action on a real SQLite built from `migrations.json` (`pnpm test`).
- `.github/workflows/` — keyless deploy (migrations → actions → R2), compliance, CI typecheck.

## Permissions model

Roles per group: `admin`, `moderator`, `member`, stored on `group_members`.

| Can | admin | moderator | member |
|---|---|---|---|
| edit the group, change roles, remove moderators/admins | ✓ | | |
| create join codes (member / moderator), add or remove members | ✓ | ✓ | |
| create events, edit or delete any event | ✓ | ✓ | creator only |
| RSVP, post, delete own messages, read everything | ✓ | ✓ | ✓ |
| delete any message | ✓ | ✓ | |

Nobody changes their own role; the last admin can neither leave nor be removed. App-wide
moderation (`admin_*`) uses the platform's app roles (`app.roles`), granted by the app owner,
not a group role.

## Extending

| You want | Change |
|---|---|
| A different noun (band, class, club) | `GROUP` in `api.ts`; copy |
| Live thread | `ROOMS_THREAD = true` and subscribe with `app.rooms` in `Messages.tsx`; keep `post_message` as the record |
| Group avatars / documents | `STORAGE_AVATARS = true`, upload with `app.storage.uploadUserPublic`, store the URL in `groups.avatar_url` |
| Event reminders | `app.notifications` on a schedule from `list_events` |
| Domain records (games, puzzles, vacancies, media) | new tables with `group_id` and the same membership predicate; copy `create_event` as the write pattern |

## What this template deliberately does not do

Billing or per-group pricing, back-office records (workspace archetype), public marketplaces
(marketplace archetype), server-authoritative realtime. No seed tooling ships in the manifest.

## Standard audit (1.5)

Static audit at staging: `pas check` passes all 20 checks with no warnings; the manifest
registers through the platform's own validation (manifest rules, `:__user_id` scoping with the
two declared `caller_unscoped` app-admin tools, schema coherence) and the migrations pass the
additive-only lint — see `test/template-membership.test.ts` in the platform repository. The
base template's three deviations are fixed here (PAS-AUTH-001 platform-cookie, PAS-UI-002
`stores-theme`, PAS-UI-007 zoomable viewport). Known deviations: none. Live checks run once
an app built from this template is deployed.

## License

MIT.
