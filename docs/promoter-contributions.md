---
description: "Promoter contribution totals, share among promoters, standings and public contributor cards (#551, epic #548)."
---

# Promoter contributions and reporting

How a promoter's confirmed referrals are reported: their own totals and share, the app owner's standings, and the
public contributor card. This is the third backend slice of epic #548 (#551), after [enrollment](./promoters.md) (#549) and
[referral attribution](./referral-attribution.md) (#550). It adds reads only. No money moves: nothing here is a
commission, a payout or a revenue rule, and existing usage, code stats and payout behaviour are unchanged.

## What is measured, and what is not

- A promoter's contribution is their **confirmed referrals**: people the platform recorded activating the app after
  claiming their code. Enrolling, a code, a click or a pending capture is not a contribution. The **first confirmed referral**
  is what establishes a recorded promotion contribution (`recorded: true`).
- **The percentage** is *this promoter's confirmed referrals ÷ all promoters' confirmed referrals, for the same app and
  period*. It is a share **among promoters**. It is not a share of all users, and the field says so in its `basis`.
- **Organic users** (activations with no referral) are a separate bucket, shown to the app owner only. They never go into a
  promoter's number or the denominator.
- **Zero denominators** give `ratio: 0, percent: 0`, never an error or `NaN`.
- **Code contribution is not part of these responses.** Every response carries a `code` section with `available: false` and a reason
  pointing at [Project contributions](./contributions.md) (`GET /v1/apps/:appId/contributions`, app team only). No line counts are
  estimated or fabricated here, and promotion and code are **never combined** into one figure, score or percentage. Code appears
  beside promotion, not merged with it. A person is the same person in both sections only by the same PAS user; nothing is matched by name, email or membership.
- Only people PAS recorded activating the app since attribution began are counted. Earlier users are not reconstructed (`freshness`
  says since when).

## Period

`?from=&to=` on every route. Each is an ISO date (`2026-10-01`, UTC midnight), an ISO date-time **with a zone**
(`2026-10-01T10:00:00+10:00`), or epoch milliseconds. The period is **half-open**: `from <= time < to`. Either end may be
omitted (all history). `from` must be before `to`; anything else is `400`.

Confirmed and reversed credits are placed by **when they were confirmed**; pending and expired ones by **when they were captured**.
So reversing a credit moves it from `confirmed` to `reversed` in the same period, and every total, share and rank changes together.

## Ranking

Standings are ordered by confirmed referrals (most first), then **earliest first confirmation in the period**, then promoter id, so
the order is deterministic. `rank` is 1-based for promoters with at least one confirmed referral and `null` for the rest, who follow
in id order. `tied_on_count` is true when another promoter has the same confirmed count. A suspended or withdrawn promoter's
valid credits still count in everyone's denominator and standings.

## Routes

Errors are plain-text bodies, as elsewhere. The first two need a first-party person session (an app-bound session is refused).

| Route | Who | Result |
| --- | --- | --- |
| `GET /v1/apps/:appId/promoters/me/contributions?from=&to=` | the promoter, own | `{ version, app_id, period, freshness, contributions: { promotion, code } }` where `promotion` has `promoter_status`, `recorded`, `first_confirmed_at`, `counts { pending, confirmed, reversed, expired }`, `share_of_referred_users { numerator, denominator, ratio, percent, basis }` and `standing { rank, ranked_promoters, tied_on_count }`. A suspended or withdrawn promoter still reads their own record. A non-promoter gets `404` |
| `GET /v1/apps/:appId/promoters/contributions?from=&to=&limit=&after_id=` | app owner | `{ ..., totals, acquisition, contributions: { code }, standings: [...], next }`. `standings[]` has `rank`, `tied_on_count`, `promoter_id` (opaque), `display_name`, `status`, `counts`, `first_confirmed_at`, `share_of_referred_users`. `acquisition` has `activations_recorded`, `referred_confirmed`, `referred_reversed` and `organic`. The `after_id` cursor is a promoter id, stable across ties |
| `GET /v1/apps/:appId/promoters/:promoterId/public-card?from=&to=` | public | one contributor card, or the same `404` as any other miss |
| `GET /v1/storefront/apps/:appId/contributors?from=&to=` | public | `{ version, app_id, period, contributors: [card] }` in standings order; `404` for a private or missing app |

A promoter never sees another promoter's invitees, the organic bucket, app-wide acquisition, or the owner's analytics. Their standing is
only their rank and how many promoters are ranked. Nothing returns a referred person's id, login or email. Passing a different
promoter's id to the own route is impossible: it always reads the caller's own record.

## Public contributor cards (#541 / #542)

A person appears only if **they** chose to, and only while they are an **active promoter** of a **public** app with at least one
confirmed referral:

1. They have a public profile for the app (`PUT /v1/apps/:appId/team/public/me`) with `visible: true` and a `display_name`, and
2. they set `show_promotion: true` there. This is a separate switch, off by default; sharing a name never shows promotion by itself.

A promoter who is **not** on the team can keep such a profile; the public team list (`/storefront/apps/:id/team`) is unchanged and
still shows only current team members.

The card contains the chosen `display_name` and `label`, a confirmed-referral count and a share among promoters. It contains **no** user id,
email, invitee, pending or reversed figure, and no promoter id inside the body. It is addressed by the opaque `promoter_id`, never a user id.
The owner and the promoter get the id from their own routes; the public list needs none.

Lifecycle:

- **Opt-out:** `show_promotion: false`, `visible: false`, or `DELETE /v1/apps/:appId/team/public/me` removes the card.
- **Suspension** hides the card while it lasts and it returns when the owner lifts it, if the person still opted in.
- **Withdrawal** clears `show_promotion` (database trigger). Enrolling again does **not** bring it back: the person must choose to show it again.
- A **publisher transfer** and **removal from the team** clear the profile as in #542; a **private** app answers `404`.
- Owner moderation is suspension, or removal from the team for a member.

## Compatibility

Additive. Migration `0131` adds indexes, one column (`show_promotion`, default off) and one trigger, and rewrites no row. The public-team
list and every existing route keep their responses. `PUT /team/public/me` accepts an optional `show_promotion` and now also accepts an active
promoter (not only a team member); its response gains `show_promotion`.

SDK: `app.referrals.contributors(period?)` and `app.referrals.publicCard(promoterId, period?)` read the two public routes. The own and owner
routes need a first-party session, so they are read by the Console, with the `PromoterContributions` and `PromoterStandings` types exported
from the SDK.
