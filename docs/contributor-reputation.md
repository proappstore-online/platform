---
description: "Your private developer contribution profile: current app participation, verified code evidence and derived badges (#586)."
---

# Your developer contribution profile

The signed-in developer workspace can show your own current app participation and code contribution
evidence. `GET /v1/me/developer-reputation` requires an explicit first-party person session and returns
`Cache-Control: private, no-store`. It accepts no target person or repository. App-origin, workload,
legacy unclassified and anonymous credentials cannot use it. Even a platform administrator sees only
apps they currently own or belong to through a recognized app-team role.

This is the private first slice of [#586](https://github.com/proappstore-online/platform/issues/586).
It adds no public profile, directory or storefront identity. The consumer storefront's anonymity policy
is unchanged. Other-person reputation on team cards or join applications is not delivered by this route.

## Evidence and history

- Each app records the caller's current role. A member's `membership_observed_since` comes from the
  current membership row. Owner start dates are unknown, because an app creation date does not prove
  when the current publisher took ownership.
- Only a canonical `gh:<numeric-id>` whose saved user provider agrees is joined to the LOC ledger.
  Names, email addresses and login aliases never link accounts. A Google sign-in remains unlinked.
- Counts reuse the existing verified repository and versioned LOC counting policy: reachable,
  non-merge, eligible source/test commits attributed by GitHub to that person. Bots and unlinked
  authors do not earn the person's credit. There is no second ingestion ledger.
- `counts: null` means unavailable evidence, not zero. Complete, fresh history with no eligible
  activity returns zero. Incomplete/stale evidence retains its explicit status and refresh time;
  outdated policy, changed repository identity and mismatched synchronization identities do not
  produce trusted figures. Truncated file histories are partial.
- First/last recorded commit dates describe code activity. They do not establish role tenure,
  accepted reviews, surviving code ownership or total lifetime participation. Removed memberships
  disappear; former private projects are not disclosed after access is lost.

## Badges

Badges are derived on every read from complete, fresh, verified evidence under the current counting
policy. Distinct immutable repository IDs prevent two app bindings from doubling repository credit.

| Badge | Evidence |
| --- | --- |
| Code contributor | At least one eligible commit in one verified repository |
| Multi-app contributor | Eligible commits in at least two distinct verified repositories |

A stale/incomplete refresh or repository rewrite can remove a badge until eligible evidence is
verified again. These are transparent activity milestones, not an overall reputation score, skill
assessment, ownership share, permission or payout entitlement. `summary.incomplete_apps` makes
missing evidence explicit; the verified repository count is not claimed to be lifetime coverage.

## Response

The version 1 response contains `policy_version`, `generated_at`, `identity` (`verified_github` or
`unlinked`), `scope: current_authorized_apps`, `apps`, `summary`, `badges` and `history_note`.
Each app contains `app_id`, `role`, `membership_observed_since`, `state`, `state_reason`, `verified`,
`counts` (commits/additions/deletions or null), first/last recorded commit times and last refresh time.
All times are epoch milliseconds. No raw Git author identity or email is returned.

## Remaining #586 work

Other-person profiles require a chosen developer-workspace audience and explicit person-controlled
sharing. Existing anonymous join enquiries must not be matched to a PAS account by email: attaching
reputation requires a separately verified applicant identity and consent. The current membership table
does not retain past membership intervals; a future historical participation ledger must label its
start of coverage and must not fabricate a historical backfill. Broader public profile policy remains
separate from this own-only feature.
