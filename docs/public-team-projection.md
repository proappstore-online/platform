---
description: "The public app-team list, members' opt-in profiles, and typed team_join enquiries (#542, part of #541)."
---

# Public team projection and team-join enquiries

An app's storefront can show who is behind it, and a visitor can ask to join. This is a platform contract
(#542, first slice of #541); console and storefront screens are separate work. Nothing here grants
membership or access, sends an email or creates an invitation.

## Who appears: individual opt-in

Nothing is public by default. A current member (the publisher, or anyone in the app's team) appears on the
public list only after they set **their own** profile to visible. The owner can take someone off the list; the
owner cannot publish someone else.

A member's public profile is a **display name** (up to 60 characters) and an optional **label** (up to 40),
both plain text: no markup, entities, links or email addresses. A label such as "Designer" is presentation.
It is never a permission and changes nothing about what the person can do.

Visibility is cleared, and must be chosen again, when:

- the member is **removed** from the team, so rejoining does not bring the old choice back;
- the app's **publisher changes**: both the previous and the new publisher start private.

The public read also joins current membership, so a stale flag can never show someone who has left.
Making an app private hides the whole list (see below); making it public again shows the members who still
have a visible profile and are still members.

## API

### Public: the team list

`GET /v1/storefront/apps/:id/team` — no authentication, `Cache-Control: public, max-age=60`.

```json
{ "members": [ { "display_name": "Ada L.", "label": "Maintainer", "is_creator": true } ] }
```

The publisher is listed first. The payload carries no user id, login, email, provider id, access role,
`invited_by` or pending invitation. A **private or missing app** answers an identical `404 not found`.

### A member's own profile

All three need the person's own signed-in session. A session minted without a person, and an app-bound
credential, are refused. Only a current member (publisher or team member) may use them.

| Route | Body | Effect |
| --- | --- | --- |
| `PUT /v1/apps/:appId/team/public/me` | `{ "display_name": "Ada L.", "label": "Maintainer", "visible": true }` | Saves the profile. `visible` is required; `display_name` is required to be visible. |
| `DELETE /v1/apps/:appId/team/public/me` | — | Withdraws (`visible: false`), keeping what they wrote. |

A non-member gets `403`. Invalid text gets `400` with the reason.

Two additive points from [Promoter contributions](./promoter-contributions.md) (#551): the body may also carry `show_promotion` (default `false`,
only with `visible: true`, and only for an active promoter, else `400 not_an_active_promoter`), and an **active promoter who is not on the team**
may keep a profile too. The public team list above still shows only current team members.

### Owner moderation

| Route | Effect |
| --- | --- |
| `GET /v1/apps/:appId/team/public` | The owner's private view: every current member with `user_id`, `role`, `display_name`, `label`, `visible`, `updated_at`. Not cached. |
| `DELETE /v1/apps/:appId/team/public/:userId` | Takes one person off the public list (`404` if they were not on it). |

Hiding someone is not a ban: they may opt in again. To stop a person appearing for good, remove them from the
team. Only the owner (or a platform admin) can use these routes.

## Team-join enquiries

`POST /v1/storefront/apps/:appId/enquiries/team-join`, JSON only:

```json
{ "name": "Sam", "email": "sam@example.com", "message": "I would like to help with translations." }
```

- **Eligible apps only.** A private or missing app answers `404`, identically.
- **Exact origins.** The request's `Origin` must be the app's own `https://about-<appId>.proappstore.online` or
  `https://proappstore.online` (the storefront); anything else is `403`. The existing contact endpoint
  (`POST /v1/apps/:appId/enquiries`) is unchanged and still accepts the about- site only.
- **Validation.** `name`, `email` and `message` are required (≤100, ≤254, ≤5000 characters; 16 KB body). The email
  must look like an address. HTML tags are refused in every field, a link is refused in the name, and control
  characters are refused. The honeypot field `website` is accepted and discarded. Stored text is data: clients
  must still escape it when rendering.
- **Rate limits** are the contact form's, in the same atomic statement, shared with it: five per client per hour
  and 200 per app per day, in total across both types. Over the limit is `429` with `Retry-After`.
- **Duplicates.** One *new* team-join enquiry per email address per app. A repeat while it is still new answers
  `201 { "ok": true }` and stores nothing, so the answer never reveals whether an address already applied. Once
  the owner marks it handled, the person may apply again.
- **Result.** `201 { "ok": true, "id": "…" }`. The enquiry is stored with `type: "team_join"`.

### Reviewing them (owner)

The owner's private inbox is the durable notification. **No email or push is sent** when one arrives.

`GET /v1/apps/:appId/enquiries` gains an optional `?type=general|team_join` filter (omit it for both) and every
enquiry carries a `type` (`general` for all earlier ones). `counts` is exactly as before; the per-type counts are
separate top-level fields. All of them cover the whole inbox, whatever the filter:

```json
{ "counts": { "new": 3, "total": 9 },
  "new_count": 3, "new_general_count": 2, "new_team_join_count": 1,
  "next": { "before_id": "…" } }
```

Paging uses the same stable `next.before_id` cursor over `(created_at, insertion order)`; it keeps ties on the
same millisecond in order, with or without the `type` filter. The MCP tool `list_enquiries` takes the same `type`.

### After review

Reviewing a team-join enquiry changes nothing by itself. If the owner wants the person on the team, they use the
existing, authorized invitation flow for the app (`POST /v1/apps/:appId/team/invite`, requiring admin on the app)
and contact the person themselves. Marking the enquiry handled (`PATCH`) records that it was reviewed. Account
governance flags are not involved, and no invitation is created automatically.
