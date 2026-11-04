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

## T05 (integrate every authorization surface): not ready

Blockers, in order:

1. **No credential audience claim.** A first-party session is recognised only by the absence of `via`. App-scoped MCP grants and any app-origin session must carry an explicit audience/scope, enforced by the broker, before account routes are enabled for anyone.
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
