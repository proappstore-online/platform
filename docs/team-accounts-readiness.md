---
description: "What milestone 1 of team accounts delivers, how it was verified, and what blocks T05 and T06."
---

# Team accounts: milestone 1 readiness and blockers

Status: milestone 1 (T01–T04 of [#534](https://github.com/proappstore-online/platform/issues/534)) is implemented behind default-off flags. **This is not the whole team feature, and it is not the Hiring pilot.** No production data was changed: migration `0124` is additive and inert, no backfill was run, no invitation or email was sent, and no ownership, credential, funding or runtime state was touched.

## Delivered

| Package | Where | Notes |
|---|---|---|
| T01 contract | [ADR-013](adr/013-team-accounts.md), `backend/src/lib/accounts/contract.ts` | roles, permissions, bundles, credential rules, gate classification (guarded by a test) |
| T02 schema | `migrations/0124_team_accounts.sql` | accounts, memberships, invitations, grants, receipts, audit, outbox, verified emails, backfill state; nullable owner columns on `apps` and `agent_projects` |
| T02 tooling | `lib/accounts/backfill.ts` | dry run with a plan hash, per-user receipts, resumable by cursor, anomalies quarantined |
| T03 resolver | `lib/accounts/authorize.ts`, shadow hook in `lib/auth.ts` | pure `decide`, live `authorize`, `ACCOUNT_AUTHORIZATION_SHADOW=1` logs divergences |
| T04 routes | `routes/accounts.ts` | create team, list, members, invitations (create, preview, accept, revoke), role change, removal and leave |

Flags (all off): `ACCOUNTS_READ`, `ACCOUNTS_WRITE`, `ACCOUNT_AUTHORIZATION_SHADOW`. Enabling any of them in production is a separate decision.

## Verification

- Unit (node, real SQLite with every migration): permission matrix, resolver, triggers, backfill fixtures, route behavior. `packages/backend/src/lib/accounts/*.test.ts`.
- Real D1 / workerd: `packages/runtime-tests/test/backend/team-accounts.test.ts` covers simultaneous owner leave, mutual removal and mutual demotion; duplicate and racing invitation acceptance; a removed inviter; cross-account denial; idempotent replay under concurrency; rejoin without resurrection; and a shadow matrix of every user and minimum role over a backfilled fixture. It runs in CI (`pnpm test:runtime`, and the deploy gate).
- The workerd suite could not be run on the development machine used for this milestone (macOS 12 is below workerd's minimum). The same file was executed against a SQLite shim with atomic batches to check the logic, which is **not** a substitute for the workerd run; the CI result is the evidence.

## Findings from shadow mode

The shadow matrix found one real expansion before any cutover: mapping a legacy app `admin` to the new `app_admin` would have granted secrets, webhook and publication rights it does not have today. The compatibility bundle `app_legacy_admin` was added. The matrix now reports no unexplained divergence for a personal-account fixture. It has not been run against production-shaped data.

## Milestone 2a (#535): verified credential audiences and scopes

Status: delivered behind the same default-off flags, in `platform` only. This is the T05
prerequisite in blocker 1 below, not T05 itself — it does not enable, widen or replace anything
T05 still has to do (blockers 2–8 are unchanged).

What changed: `requireUser` (`lib/auth.ts`) now parses a session's `cred` claim — a versioned,
signed envelope (`@proappstore/build-core`'s `credentialContext`, validated by
`lib/accounts/credential-context.ts`'s `parseCredentialContext`) carrying the issuer's own verified
`CredentialKind` and, for `app_bound`, the owning app id. `principalFor(user)` (`lib/auth.ts`) is now
the ONE place that turns that into the resolver's `Principal`, replacing `user.via ? workload_session
: first_party_session` in both `shadowObserve` and `routes/accounts.ts`'s `caller()`. A session with
no verified claim — every token minted before this change, or an issuer that chose not to assert one
— is treated as `workload_session`: it keeps today's `app.*` reach but can never exercise a
governance permission (`isGovernance` in `contract.ts`). This is a **narrowing** of the old
"no `via` ⇒ first-party" heuristic, not a widening: nothing in production grants real access on this
classification today (`ACCOUNTS_WRITE` is off), so no caller loses anything it could actually do.

Issuers updated to assert the claim, all in this repo:

| Issuer | Context asserted |
|---|---|
| `routes/auth.ts` OAuth callback (GitHub/Google) | `first_party_session` for a first-party destination; `app_bound` to the app resolved **server-side from the verified redirect hostname** (`resolveAppOrigin`) for everything else — never from the caller-supplied `app_id` query parameter, which is unauthenticated on the plain-subdomain branch of `returnToAllowed`. An unresolved destination (e.g. a non-app reserved host) asserts no claim at all rather than guessing one. |
| `routes/auth.ts` `/auth/exchange` (CLI device-token exchange) | always `first_party_session` |
| `routes/auth.ts` `/auth/credentials/login` | `app_bound` to `users.credential_app_id` when set, else `first_party_session` — the same signal `routes/accounts.ts` already used to refuse team ownership |
| `routes/oidc-session.ts`, `lib/session-key-drift.ts` | always `workload_session` (no human present) |
| `routes/passkeys.ts` step-up | unchanged: it already spreads the original claims forward, which now includes `cred` — a re-authentication preserves, never upgrades, the context |
| `mcp/oauth-provider.ts` `authorizationCodeGrant` | re-mints the FIRST issued session from the grant's own certain `appId` binding (`app_bound` to it, or `first_party_session` for the shared `/mcp` endpoint) instead of reusing the browser-side session verbatim, which previously carried no claim reflecting which endpoint the grant was actually for. `refreshTokenGrant` already carried claims forward unchanged — correct by construction, no change needed. |

**Known remaining gap, not fixed this round:** `mcp/oauth-provider.ts`'s `issueBrokerCredential`
(the remote-auth broker / recovery-request path) stores the caller's session verbatim, the same
shape of gap `authorizationCodeGrant` had before this milestone, keyed off `target.appId` instead of
stamping it into the stored session's `cred`. Not touched here for lack of confidence in that path's
broader contract within this milestone's scope — flag it for whoever picks up T05 blocker 1's
remainder.

Verification: unit tests for the parser/builder (`credential-context.test.ts`, fails closed on a
malformed, unversioned, unknown-kind, or mismatched-appId-presence claim); real-SQLite D1 route
tests (`accounts-db.test.ts`, updated + extended — a legacy no-claim token, a workload session and an
app-bound credential are all denied `POST /accounts`'s `credential_scope` check); `routes/auth.test.ts`
(new coverage over the real OAuth callback and credentials/login route: first-party vs. app-subdomain
vs. reserved-subdomain vs. custom-domain resolution); `mcp/oauth-provider.test.ts` (new coverage: the
issued and refreshed session's `cred` reflects the grant's own appId, never the original browser
session's). All run in the standard unit suite (no workerd needed — `authorize()`/`decide()` and the
claim parser are pure or SQLite-backed, consistent with how milestone 1 verified the same layer).

Also out of scope for this milestone, by the issue's own boundary: FAS's session minting (a separate
store/repo) is untouched; no account route's flag changed; no backfill, transfer, invitation delivery,
identity merge or runtime-eligibility change; ADR-009 unchanged.

## T05 (integrate every authorization surface): not ready

Blockers, in order:

1. **No credential audience claim — partially addressed (#535, milestone 2a above).** Every session
   issuer in `platform` now asserts an explicit, versioned, verified `cred` claim instead of relying
   on the absence of `via`, and the resolver's `Principal` is derived from it. Still open: FAS's own
   issuers (a separate repo) assert nothing; `issueBrokerCredential` still doesn't stamp its
   `target.appId`; and every credential minted before this change stays claim-less — narrowed to
   `workload_session` (no governance), not reissued — until its holder next authenticates. The
   broker enforcement this blocker originally called for (rejecting an app-scoped MCP grant that
   reaches governance) is now possible because the claim exists, but account routes remain disabled
   regardless, so it has not been exercised in production.
2. **Gate replacement is not started.** `GATE_CLASSIFICATION` lists 55 backend files and 21 files in other services. The backend entries were read; all 21 other-service entries are classified from the inventory only and must be re-read line by line before their checks are replaced.
3. **Service protocol versions.** Data worker, ProjectDO router, MCP ownership cache (60 s) and `build-core` ownership check have no account-aware protocol version, and the gateway cannot refuse team operations through incompatible services.
4. **Outbox has no consumer.** `access_reconcile` rows are written `held`; GitHub collaborator revocation, ProjectDO projection and provider-grant revocation are not performed. Removal revokes D1 grants and bumps versions only.
5. **WebSockets and cached decisions** are not rechecked on removal.
6. **Rate limiting** of invitations is a pending-count cap (50 per account), not the platform rate limiter.
7. **Invitation delivery** is not built. The secret is shown once to the inviter; emailing a recipient needs a sealed delivery design, because the hash cannot be reversed. `invitation_notice` is recorded `held`.
8. **Email proof sources.** Nothing populates `user_verified_emails` yet; email-targeted invitations cannot be accepted until the auth flow records provider `email_verified` or a PAS email proof.

## T06 (account-aware provisioning): not ready

Depends on T05's credential audience and on the backfill having mapped apps and draft projects. Not started: passing actor and target account distinctly through the creation workflow, binding account versions into preview and intent hashes, and draft-project membership before an `apps` row exists. `agent_projects.owner_account_id` exists but nothing writes it except the backfill tooling.

## Before any production use

1. Run the backfill as a dry run; review the exception queue (orphans, ambiguous subjects, mismatches, unknown roles) and the plan hash.
2. Run `ACCOUNT_AUTHORIZATION_SHADOW` on production traffic and clear every `new_only_allow` and `legacy_only_allow` class.
3. Resolve blockers 1–4 above, then decide the open policy items in the [implementation plan](team-accounts-implementation.md).
