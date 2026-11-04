---
description: "Personal and team accounts as resource owners, fixed account roles, named app permissions and a single authorization decision function."
---

# ADR-013: Team accounts and the authorization contract

## Status

Accepted for milestone 1 of [#534](https://github.com/proappstore-online/platform/issues/534): the account and authorization foundation (T01–T04). Everything beyond that milestone is **proposed** in the [design](../team-accounts-design.md) and gated on [readiness](../team-accounts-readiness.md). This ADR does **not** amend [ADR-009](009-app-workers.md); runtime eligibility is unchanged.

## Date

2026-11-04

## Context

An app is owned by one user: `apps.creator_id` is the owner, `team_members` adds app-scoped collaborators ranked `viewer < po < developer < admin < owner`, and a platform admin bypasses all of it. Agent projects, build tools, the data worker, provisioning and connector grants each hold their own copy of "the owner". A person who signs in with Google and the same person on GitHub are two PAS users, so one login cannot administer an app the other created, and nothing can be owned by a group. Adding a `team_id` column and one more role check would leave those copies, the funding path and consent inconsistent. See the [design](../team-accounts-design.md) for the evidence.

## Decision

**Two resource owners, one decision function.** An `account` is the owner of apps and projects. `kind = personal` has one immutable owning user and no co-owners; `kind = team` has members. People authenticate individually and receive permissions through memberships. An account is never a login. User ids keep their meaning; there is no identity merge.

**Fixed account roles; no numeric rank.** Each role is a named permission set (`lib/accounts/contract.ts` is the single source, tested row by row):

| Role | Account | Apps |
|---|---|---|
| `owner` | everything, including owner promotion, billing, deletion | all, including transfer and delete |
| `admin` | settings, members, invitations below its rank | publisher rights on every account app; no transfer or delete |
| `billing_manager` | billing | none (no code, data, secrets or members) |
| `member` | own profile | only explicitly assigned apps |
| `guest` | own membership | only explicitly assigned apps |

Admins may invite and manage `billing_manager`, `member` and `guest` only, never owners or peers. Owners are never invited: an existing member is promoted by an owner with recent authentication.

**App assignments are separate from account roles.** `app_access_grants` carries one of `app_admin`, `developer`, `product_owner`, `viewer`, plus optional explicit extras. Only `app.data.manage` (raw SQL, migrations) is an extra: a new developer assignment does not have it. A grant counts only while the grantee's membership is active **and** `membership_generation` equals the membership's `generation`; leaving and rejoining increments the generation, so an old grant never comes back.

**Compatibility bundles.** Existing app-level rows map to bundles that keep today's rights and add none: `owner → app_legacy_owner` (management, no transfer), `admin → app_legacy_admin` (no owner-only routes; found by shadow mode, because the new `app_admin` would have widened it), `developer → app_legacy_developer` (raw SQL, reason `legacy_developer_data_access`), `po → product_owner`, `viewer → viewer`. Collaborators become app-scoped **guests** of the owner's personal account: no visibility into other apps or finances.

**Historical attribution is not authority.** After cutover `creator_id` is display and provenance only. Every current gate is classified as live authorization, projection, historical attribution, provisioning actor, end-user business authorization or personal record in `GATE_CLASSIFICATION`; a test fails when a source file using a gate is missing from it.

**One decision function** (`lib/accounts/authorize.ts`). `decide(principal, permission, facts, expectations)` is pure; `authorize()` reads the facts in one statement. Order: resource and owning account exist → the credential may exercise the permission at all → account is active → live membership (unknown roles deny) → account role or live grant grants the permission → version expectations hold. A failed lookup denies. There is no fallback to `creator_id`. The caller names a resource; naming it grants nothing, and a user id in a body is never an identity.

**Credentials intersect with the person.** Account governance, money, ownership and platform trust (`isGovernance`) need a **first-party session**. A session minted without a person (`via`) and any app-bound credential (app-origin session, end-user app token, app-scoped MCP grant) cannot exercise them, and an app-bound credential reaches only its own app. End-user app tokens are not session JWTs and are rejected at `requireUser`. Sessions carry no audience claim today, so the first-party check is "no `via`"; a real audience/scope claim is a T05 prerequisite, recorded in readiness.

**Platform trust stays separate.** `platform.runtime.approve` belongs to no account role. A platform admin keeps today's bypass on app permissions as an explicit compatibility reason (never governance, never transfer); narrowing it is a separate change.

**Mutations are guarded, idempotent and audited in one batch.** The guard is the first statement and carries every authority and version condition; the idempotency receipt is written only if it changed a row; version bumps, audit and outbox rows are conditioned on the receipt. An UPDATE that matches nothing is not success. Triggers make "an active account always has an active owner", "a new account starts provisioning" and "audit is append-only" true at the write boundary, so two concurrent demotions cannot both pass a precheck.

**Invitations are recipient-bound, hashed, expiring and single-use.** Target is a canonical user id **or** an exact verified email (trimmed, lower-cased, never alias-normalised); email proof is `user_verified_emails`, never backfilled from `users.email`. The 256-bit secret is returned once to the inviter and stored only as a SHA-256 hash; it appears in no audit row, receipt, outbox row or log. Acceptance re-checks the inviter's current authority and membership generation, the account state and the recipient in the claiming statement. A removed inviter's pending invitations are revoked in the removal transaction.

**Writes are off by default.** `ACCOUNTS_READ`, `ACCOUNTS_WRITE` and `ACCOUNT_AUTHORIZATION_SHADOW` are deployment gates, not authority. The tables are inert until the personal-account backfill, which is separate tooling (the deploy lint refuses `UPDATE`) and not run by any migration.

## Alternatives Considered

| Alternative | Why Rejected |
|---|---|
| Add `team_id` and one more role check | Leaves ProjectDO, data-worker, MCP, funding and consent copies inconsistent |
| Keep the numeric rank | Product work and money are not one ladder; the rank already let a `developer` have raw SQL |
| Map legacy `admin` to the new `app_admin` | Widens it to secrets, webhooks and publication; shadow mode caught it |
| Bearer "anyone with the link joins" team invites | Not recipient-bound; the app-level invite lifecycle is reused, its recipient policy is not |
| Merge the Google and GitHub users first | Larger identity migration, unnecessary for shared ownership |
| Auto-verify email from `users.email` or a provider label | Historical rows carry no verification evidence |

## Consequences

**Positive:**
- One tested permission matrix instead of per-route owner shortcuts; every divergence from today's behavior is a named class.
- Concurrency invariants are enforced by the database, not by prechecks.

**Negative:**
- Until T05, apps still authorize through `creator_id`/`team_members`; accounts exist beside them and shadow mode is the only comparison.
- `GATE_CLASSIFICATION` entries for services other than the backend (21 files) were classified from the inventory, not line by line.

**Neutral:**
- Ownership transfer, funding, connector re-consent, runtime approval and the Console are later work packages; see [readiness](../team-accounts-readiness.md).
