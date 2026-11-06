---
description: "App-scoped promoter enrollment: who can promote an app, public referral codes, own-promoter access and owner controls (#549, epic #548)."
---

# Promoters: app-scoped enrollment

A **promoter** is an existing PAS user who has chosen to help grow one app. This is the first backend slice of
epic #548 (#549). It covers enrollment, the public referral code, narrow own-promoter access and the owner's
controls. Counting the users a promoter brings is [Referral capture and attribution](./referral-attribution.md) (#550); totals, shares, standings and public
cards are [Promoter contributions and reporting](./promoter-contributions.md) (#551). This page does not cover any screen (Console #14, Storefront #13). No cash, commission or payout is created or implied.

## What enrolling does and does not do

- Any signed-in PAS person can enroll in an eligible app. They do not need to own an app, publish anything, or be
  a developer: a person who signed in with Google and owns nothing can enroll.
- It uses the existing PAS identity. There is no second login, no password, no new provider scope, and no merge of a
  Google and a GitHub account (they remain two PAS users).
- Enrolling **never** touches `users`, `team_members`, app roles or `apps`, and grants no team, creator, publisher,
  operator or admin right. A promoter cannot read the app's team, enquiries, analytics or promoter list.
- Each (app, person) pair is its own relationship with its own code and, later, its own stats. One person can
  promote several apps without mixing them.

## States

| State | Meaning | Who can move it |
| --- | --- | --- |
| `active` | The code resolves; the person can use their workspace | enrollment; the owner lifting a suspension |
| `suspended` | The code stops resolving. The person cannot lift it | the owner |
| `withdrawn` | The person left; their public name is cleared and the code stops resolving | the person (from `active`) |

- **Suspension is sticky.** Enrolling again, signing in again, or racing the owner's change never reactivates a
  suspended promoter, and a suspended promoter cannot withdraw to escape it (`409 suspended_by_owner`).
- A withdrawn promoter re-enrolls by enrolling again: same code, fresh consent, `reactivated: true`.
- A person who erased their account in an app is withdrawn there (name cleared, event `account_deleted`) and cannot
  enroll again (`403 account_deleted_in_app`). Other apps are unaffected.

## Codes and links

- A code is 8 characters from `23456789ABCDEFGHJKLMNPQRSTUVWXYZ` (no `0 O 1 I`): 40 bits, unique across apps in the
  database, stable for the life of the relationship. The canonical identity is the internal `promoter_id`; the code is
  only its public handle. Codes are typed forgivingly (case, spaces and hyphens are ignored).
- The shareable link is `https://proappstore.online/apps/<appId>?ref=<code>` (`share_url`; `share_path` is the same
  path). The SDK captures `ref` through sign-in and the platform attributes a first-time user: see
  [Referral capture and attribution](./referral-attribution.md).
- **The QR code is drawn by the client, from `share_url`.** The platform serves no image: `share_url` is the whole payload,
  and it is stable across replays and renames, distinct per app, and carries no user id, login or email. Scanning it is only
  a link visit; it is not a contribution (see the attribution doc).
- A code resolves only while the promoter is `active` **and** the app is public.

## Eligibility

An app takes promoters when it exists, is not private, and its owner has not closed enrollment (default open).
A private or missing app gives the identical `404 not found`, so the route cannot probe for private apps. Closing
enrollment stops new enrollments only; existing active promoters and their links keep working. While an app is
private its codes stop resolving, and a promoter's own view shows `app_public: false`.

## API

Errors are plain text bodies, as elsewhere in this API. Everything under "person" needs the person's own signed-in
session (a first-party session): an app-bound, workload, machine or unproven credential gets `403`.

### Public

| Route | Result |
| --- | --- |
| `GET /v1/storefront/promoters/apps?limit=&after=` | `{ apps: [{ appId, iconUrl, tagline, category }], next: { after } \| null }`, public apps with enrollment open, cached 60 s |
| `GET /v1/storefront/promoters/code/:code` | `{ valid: true, app_id, promoter: { display_name } }`, or `404 not found` for anything that is not a live code of a public app. Not cached |

### The signed-in person

| Route | Body | Result |
| --- | --- | --- |
| `POST /v1/apps/:appId/promoters/enroll` | `{ "consent": true, "display_name"?: string, "return_path"?: string }` | `201` on first enrollment, `200` on a replay or when a suspended relationship is returned. `{ ok, created, reactivated, promoter, return_path? }` |
| `GET /v1/promoters/me` | | `{ promoters: [...] }` every relationship of the caller |
| `GET /v1/apps/:appId/promoters/me` | | `{ promoter }`, or `404` |
| `PATCH /v1/apps/:appId/promoters/me` | `{ "display_name": string \| "" }` | rename (active only) |
| `POST /v1/apps/:appId/promoters/me/withdraw` | | leave; idempotent |

`promoter` (own view): `promoter_id, app_id, status, code, code_active, display_name, share_path, share_url, app_public,
status_reason` (only while suspended), `consented_at, created_at, updated_at`. It never contains a user id or email.

- **Consent.** `consent` must be exactly `true`; the version and time are stored. The optional `display_name` is the only
  profile data collected: plain text, 60 characters, no markup, links or email addresses. A replay keeps the existing
  name; use `PATCH` to change it.
- **No second login.** The caller is already signed in, so the `enroll` response is all the Console needs to open the
  workspace. `return_path` is echoed back only if it is a path on the caller's own site (one leading `/`, no scheme,
  host, backslash, whitespace or control character); anything else is `400 invalid_return_path`.
- **Error vocabulary:** `consent_required`, `invalid_return_path`, `enrollment_closed` (403), `account_deleted_in_app` (403),
  `could_not_allocate_code` (503, after repeated collisions), `suspended_by_owner` (409), `not_active` (409),
  `invalid_transition` (409).

### The app owner

All need the app's owner (or a platform admin). A promoter sees none of this.

| Route | Result |
| --- | --- |
| `GET /v1/apps/:appId/promoters?status=&limit=&before_id=` | `{ promoters, counts: { active, suspended, withdrawn, total }, next: { before_id } \| null }`, newest first, stable on ties |
| `POST /v1/apps/:appId/promoters/:promoterId/status` | `{ "status": "suspended" \| "active", "reason"?: string }`. `suspended` needs an `active` promoter, `active` lifts a `suspended` one; anything else is `409 invalid_transition`. Same-state calls are idempotent |
| `GET /v1/apps/:appId/promoters/events?promoter_id=&limit=&before_id=` | the audit trail: `id, promoter_id, actor_kind (self/owner/system), action, from_status, to_status, reason, created_at` |
| `GET` / `PUT /v1/apps/:appId/promoters/settings` | `{ enrollment_open }` |

The owner sees each promoter's chosen display name, code and status, **not** their user id or email. The audit trail
is append-only (the database refuses updates), carries no user ids, and outlives a deleted app or promoter.
A promoter's `promoter_id` from another app is `404` under this app's path.

## Transfer and deletion

- **Ownership transfer.** Enrollments belong to the app, so they survive a transfer. Owner controls follow the app's
  existing owner gate, which the new owner passes. (A transfer moves `apps.creator_id`; whether a former owner's separate
  team row is removed is existing platform behaviour and unchanged here.)
- **App deletion** removes its promoters and settings; the audit events remain.
- **Per-app account deletion** withdraws that person's promoter relationship, as above.

## Compatibility

Everything is additive: migration `0129` adds three tables and two triggers and rewrites no row; no existing route,
response or table changes. The one shared-code change exports a plain-text validator from `lib/public-team.ts`.
There is no SDK or MCP surface yet: SDK referral capture is #550, and owner MCP tools can follow once the console
consumer settles the shape.

## Decisions taken (reversible)

- **Sign-in:** a first-party person session is required, the same bar as the Google connection controls. Nothing here
  promises that Google sign-in is configured; it uses whatever PAS sign-in the person already used.
- **Query parameter** `ref` is what the SDK reads (#550); the code itself is stable either way.
- **Code revocation** is by status (suspend or withdraw). Rotating a code for a live promoter is not offered; it would
  need a decision on old links, which belongs with #550.
- **Discovery** returns only fields the storefront already publishes.

Saved public preferences can be read privately with
`GET /v1/apps/:appId/team/public/me`. The caller must be a first-party person and
currently eligible as publisher, member or active promoter. This returns the
stored choices, including hidden ones; `profile: null` means no saved row.
See [the exact contract](public-team-projection.md#reading-your-saved-preferences).
