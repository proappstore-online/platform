---
description: "Server-owned referral capture across sign-in and first-activation attribution: the activation event, states, policies and API (#550, epic #548)."
---

# Referral capture and attribution

A promoter (see [Promoters](./promoters.md)) shares a personal link. When a person who is **new to that app** signs in
and uses it, the platform credits that promoter **once**. This is the second backend slice of epic #548 (#550). It
does not compute totals or percentages (those are [Promoter contributions and reporting](./promoter-contributions.md), #551), build any screen, or create a commission, payout or revenue rule.

## What counts: the activation event

A person is credited by one authoritative server event, their **first authenticated activation of the app**:

> the first successful platform request that (1) the host mediated for this app (`X-PAS-App`, which only the private
> `HostApi` binding can set), (2) carried a valid PAS session **bound to that app** (never a first-party or machine
> session, and never another app's), and (3) is not telemetry ingestion or the referral claim itself.

The server reads all of that from the request and records it in its own ledger (`app_user_activations`). A client cannot
send, forge or edit an activation or a counter. These do **not** count, and none of them can confirm a referral:

- loading a page, following a link, clicking, scanning a QR code;
- creating a code, or being issued a token or a session;
- a signed-out request, a failed request, a direct API call with no host mediation (the same rule as usage pings, #58);
- background telemetry (`/apps/:id/logs`) and the claim request.

A person with a PAS account who has never used **this** app qualifies; signing in to PAS earlier does not disqualify them.

## States

| State | Meaning |
| --- | --- |
| `pending` | A valid code was captured; no activation yet |
| `confirmed` | The activation followed: the promoter is credited once |
| `expired` | The activation never came in time, or the promoter stopped being active before it |
| `reversed` | The app owner voided it (`fraud_invalid` or `correction`) |

Pending capture and confirmed referral are separate. Organic (unattributed) users are simply activations with no confirmed
referral; they are never folded into a promoter's number, and `fraud_invalid` is a distinct reversal kind.

## Policies

- **Unique credit.** One row per (app, referred person). **The first valid claim wins**: a later claim, by another promoter or
  the same one, never reassigns or duplicates it (`already_attributed`). A replay is idempotent. Concurrent claims and
  concurrent or replayed activations credit once.
- **No self credit; no existing users.** A promoter claiming their own code, or a person who already used the app, is
  `not_eligible`. "Already used" means a PAS activation record, or an older record of use in the app (per-user data, usage, an
  app role, a personal token, a push subscription or a license) from before a 15-minute window. A person's own first moments
  in the app do not disqualify them. Nothing is backfilled or inferred from analytics.
- **Capture lifetime.** A pending claim waits **14 days** for the activation, then lapses to `expired`; the person may then be
  claimed afresh. The SDK drops a held code after the same 14 days. The first activation may reach the server a moment before
  the claim does, so a claim that arrives within **15 minutes** after the person's first activation still counts.
- **Code lifecycle.** A claim is accepted only for a code of an **active** promoter of **this** app whose app is public. An unknown,
  malformed, other-app, private-app, suspended or withdrawn code is one identical `invalid_code`: nothing reveals which. A
  claim whose promoter is no longer active at activation expires with no credit. A credit already confirmed **stays** when the
  promoter is later suspended; only the owner can reverse it.
- **Corrections.** The owner can `reverse` a confirmed credit (`fraud_invalid` or `correction`, with a reason) and `restore` it.
  Both are idempotent and audited. A reversed person cannot be re-credited by claiming again or reassigned to another promoter.
- **Transfer, deletion, erasure.** Attributions belong to the app: they survive an ownership transfer and go with a deleted
  app (the audit record stays). If the referred person erases their account in the app, an unconfirmed claim is dropped, a
  confirmed credit stays as an anonymous count, and they cannot be credited again.
- **What cannot be inferred.** Credit is per PAS identity and per device flow: a referral made on another device, or by someone
  who signs in with a different account, is not recognised. The platform does not fingerprint devices or merge identities to
  improve coverage.

## API

A claim carries only the public code. The server resolves it to a verified promoter itself; a client-supplied promoter id is never read.

| Route | Who | Result |
| --- | --- | --- |
| `POST /v1/apps/:appId/referrals/claim` `{ "code" }` | the referred person, from inside the app | `{ credited, state }` where `state` is `pending`, `confirmed`, `not_eligible`, `invalid_code`, `already_attributed` or `unverified_origin` (not mediated or not this app's session; nothing stored). Never the promoter |
| `GET /v1/apps/:appId/promoters/me/referrals?limit=&before_id=` | the promoter, own | `{ promoter_status, counts: { pending, confirmed }, referrals: [{ referral_id, status, captured_at, expires_at, activated_at, confirmed_at }], next }`. No invitee identity, nothing of other promoters |
| `GET /v1/apps/:appId/referrals?status=&promoter_id=&limit=&before_id=` | app owner | the app's attributions with `promoter_id` and reversal details, and `counts` of every state, newest first, stable on ties |
| `POST /v1/apps/:appId/referrals/:referralId/reverse` `{ "kind": "fraud_invalid" \| "correction", "reason"? }` | app owner | confirmed to reversed |
| `POST /v1/apps/:appId/referrals/:referralId/restore` | app owner | reversed to confirmed |
| `GET /v1/apps/:appId/referrals/events?referral_id=&limit=&before_id=` | app owner | the audit trail: `action`, `from_status`, `to_status`, `reason`, `actor_kind` (`referred`, `owner`, `system`), no user ids; rejected claims (a self-referral, an existing user) appear with no attribution |

Responses never contain the referred person's user id, login or email. The audit trail is append-only (the database refuses updates).
Errors are plain-text bodies, as elsewhere. The public code check for the "invalid, expired or revoked link" screen is
`GET /v1/storefront/promoters/code/:code` from [Promoters](./promoters.md).

## SDK

`@proappstore/sdk` captures and claims on its own; an app needs no code. `app.referrals`:

- reads `?ref=<code>` from the page URL on load and keeps it on the device (the first valid code stands; the URL is not changed),
  so it survives the redirect to PAS sign-in and back to the exact destination;
- when a person is signed in, sends only that code to the claim route, once; a definite answer clears it, a network or server
  failure keeps it for the next attempt;
- exposes `capture(href?)`, `pending()`, `claim()` and `clear()`; it sends nothing when no code was captured.

Apps on an older SDK, or in legacy-bearer mode (no host mediation), do not capture or activate and are not credited.

## Compatibility

Additive: migration `0130` adds three tables and two triggers and rewrites no row. The only change to existing behaviour is a
post-response observer on `/v1` that reads the request and, for a mediated app-bound session, records an activation; it swallows
its own failures and never alters a response. No existing route, response or table changes. The SDK gains `app.referrals` and exports.
