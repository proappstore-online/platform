---
description: "Source impact inventory for the proposed PAS team accounts feature."
---

# Team accounts source inventory

This is the reproducible lexical impact scan supporting the [design](team-accounts-design.md) and [work packages](team-accounts-implementation.md). Baseline: platform `1f461fa07fbb2620747075b4729e699382508cef`, 4 November 2026. Matches identify inspection targets, not confirmed defects. Generated documentation, comments and application templates appear in the scan and must not be mechanically changed.

Searches used `creator_id`, `requireAppOwner`, `requireAppAccess`, `isAdminId` for the backend and `creator_id`, `owner_id`, `team_role`, `team_members`, `verifyAppOwnership` for other services, excluding test/spec files. Route semantics and critical helper bodies were inspected separately.

For each implementation ticket, classify the field as current authority, immutable attribution, replicated state, end-user identity, funding owner or template example before editing it. The complete scan is listed below so less visible paths such as notifications, deletion, enquiries and private visibility are not missed.

## Backend

270 matches across 56 files. Line numbers refer to the investigated commit.

| Source | Matches | Example lines |
|---|---:|---|
| [packages/backend/src/lib/auth.ts](https://github.com/proappstore-online/platform/blob/1f461fa07fbb2620747075b4729e699382508cef/packages/backend/src/lib/auth.ts) | 13 | 133, 157, 164, 171 |
| [packages/backend/src/lib/operation-log.ts](https://github.com/proappstore-online/platform/blob/1f461fa07fbb2620747075b4729e699382508cef/packages/backend/src/lib/operation-log.ts) | 1 | 175 |
| [packages/backend/src/lib/operator-audit-marks.ts](https://github.com/proappstore-online/platform/blob/1f461fa07fbb2620747075b4729e699382508cef/packages/backend/src/lib/operator-audit-marks.ts) | 4 | 21, 39, 42, 68 |
| [packages/backend/src/lib/provision-data.ts](https://github.com/proappstore-online/platform/blob/1f461fa07fbb2620747075b4729e699382508cef/packages/backend/src/lib/provision-data.ts) | 4 | 98, 110, 127, 129 |
| [packages/backend/src/lib/provision-operation.ts](https://github.com/proappstore-online/platform/blob/1f461fa07fbb2620747075b4729e699382508cef/packages/backend/src/lib/provision-operation.ts) | 5 | 60, 117, 135, 232 |
| [packages/backend/src/lib/visibility.ts](https://github.com/proappstore-online/platform/blob/1f461fa07fbb2620747075b4729e699382508cef/packages/backend/src/lib/visibility.ts) | 4 | 7, 120, 126, 158 |
| [packages/backend/src/openapi-spec.ts](https://github.com/proappstore-online/platform/blob/1f461fa07fbb2620747075b4729e699382508cef/packages/backend/src/openapi-spec.ts) | 3 | 8629, 8650, 8727 |
| [packages/backend/src/routes/actions.ts](https://github.com/proappstore-online/platform/blob/1f461fa07fbb2620747075b4729e699382508cef/packages/backend/src/routes/actions.ts) | 3 | 3, 82, 85 |
| [packages/backend/src/routes/alerts.ts](https://github.com/proappstore-online/platform/blob/1f461fa07fbb2620747075b4729e699382508cef/packages/backend/src/routes/alerts.ts) | 4 | 8, 25, 40, 49 |
| [packages/backend/src/routes/analytics-stats-routes.ts](https://github.com/proappstore-online/platform/blob/1f461fa07fbb2620747075b4729e699382508cef/packages/backend/src/routes/analytics-stats-routes.ts) | 5 | 6, 36, 116, 149 |
| [packages/backend/src/routes/analytics.ts](https://github.com/proappstore-online/platform/blob/1f461fa07fbb2620747075b4729e699382508cef/packages/backend/src/routes/analytics.ts) | 4 | 18, 50, 60, 99 |
| [packages/backend/src/routes/app-billing-account.ts](https://github.com/proappstore-online/platform/blob/1f461fa07fbb2620747075b4729e699382508cef/packages/backend/src/routes/app-billing-account.ts) | 4 | 3, 145, 164, 171 |
| [packages/backend/src/routes/app-directory.ts](https://github.com/proappstore-online/platform/blob/1f461fa07fbb2620747075b4729e699382508cef/packages/backend/src/routes/app-directory.ts) | 2 | 214, 224 |
| [packages/backend/src/routes/app-workers.ts](https://github.com/proappstore-online/platform/blob/1f461fa07fbb2620747075b4729e699382508cef/packages/backend/src/routes/app-workers.ts) | 9 | 27, 122, 137, 145 |
| [packages/backend/src/routes/apps.ts](https://github.com/proappstore-online/platform/blob/1f461fa07fbb2620747075b4729e699382508cef/packages/backend/src/routes/apps.ts) | 14 | 3, 25, 49, 93 |
| [packages/backend/src/routes/connectors.ts](https://github.com/proappstore-online/platform/blob/1f461fa07fbb2620747075b4729e699382508cef/packages/backend/src/routes/connectors.ts) | 5 | 21, 41, 57, 74 |
| [packages/backend/src/routes/data-import.ts](https://github.com/proappstore-online/platform/blob/1f461fa07fbb2620747075b4729e699382508cef/packages/backend/src/routes/data-import.ts) | 2 | 3, 63 |
| [packages/backend/src/routes/delete-app-account.ts](https://github.com/proappstore-online/platform/blob/1f461fa07fbb2620747075b4729e699382508cef/packages/backend/src/routes/delete-app-account.ts) | 2 | 4, 33 |
| [packages/backend/src/routes/deploy.ts](https://github.com/proappstore-online/platform/blob/1f461fa07fbb2620747075b4729e699382508cef/packages/backend/src/routes/deploy.ts) | 6 | 7, 336, 399, 446 |
| [packages/backend/src/routes/domains.ts](https://github.com/proappstore-online/platform/blob/1f461fa07fbb2620747075b4729e699382508cef/packages/backend/src/routes/domains.ts) | 6 | 8, 15, 440, 539 |
| [packages/backend/src/routes/email.ts](https://github.com/proappstore-online/platform/blob/1f461fa07fbb2620747075b4729e699382508cef/packages/backend/src/routes/email.ts) | 2 | 42, 44 |
| [packages/backend/src/routes/endpoints.ts](https://github.com/proappstore-online/platform/blob/1f461fa07fbb2620747075b4729e699382508cef/packages/backend/src/routes/endpoints.ts) | 6 | 8, 13, 93, 118 |
| [packages/backend/src/routes/engagements.ts](https://github.com/proappstore-online/platform/blob/1f461fa07fbb2620747075b4729e699382508cef/packages/backend/src/routes/engagements.ts) | 4 | 64, 166, 207, 433 |
| [packages/backend/src/routes/enquiries.ts](https://github.com/proappstore-online/platform/blob/1f461fa07fbb2620747075b4729e699382508cef/packages/backend/src/routes/enquiries.ts) | 3 | 21, 127, 172 |
| [packages/backend/src/routes/hooks.ts](https://github.com/proappstore-online/platform/blob/1f461fa07fbb2620747075b4729e699382508cef/packages/backend/src/routes/hooks.ts) | 3 | 28, 264, 287 |
| [packages/backend/src/routes/invites.ts](https://github.com/proappstore-online/platform/blob/1f461fa07fbb2620747075b4729e699382508cef/packages/backend/src/routes/invites.ts) | 8 | 3, 67, 231, 245 |
| [packages/backend/src/routes/listings.ts](https://github.com/proappstore-online/platform/blob/1f461fa07fbb2620747075b4729e699382508cef/packages/backend/src/routes/listings.ts) | 4 | 3, 155, 165, 309 |
| [packages/backend/src/routes/logs.ts](https://github.com/proappstore-online/platform/blob/1f461fa07fbb2620747075b4729e699382508cef/packages/backend/src/routes/logs.ts) | 5 | 30, 298, 386, 427 |
| [packages/backend/src/routes/marketing-deploy.ts](https://github.com/proappstore-online/platform/blob/1f461fa07fbb2620747075b4729e699382508cef/packages/backend/src/routes/marketing-deploy.ts) | 2 | 26, 289 |
| [packages/backend/src/routes/notifications.ts](https://github.com/proappstore-online/platform/blob/1f461fa07fbb2620747075b4729e699382508cef/packages/backend/src/routes/notifications.ts) | 2 | 371, 372 |
| [packages/backend/src/routes/oidc-session.ts](https://github.com/proappstore-online/platform/blob/1f461fa07fbb2620747075b4729e699382508cef/packages/backend/src/routes/oidc-session.ts) | 2 | 14, 160 |
| [packages/backend/src/routes/ownership.ts](https://github.com/proappstore-online/platform/blob/1f461fa07fbb2620747075b4729e699382508cef/packages/backend/src/routes/ownership.ts) | 13 | 12, 83, 84, 241 |
| [packages/backend/src/routes/pags.ts](https://github.com/proappstore-online/platform/blob/1f461fa07fbb2620747075b4729e699382508cef/packages/backend/src/routes/pags.ts) | 4 | 11, 64, 71, 87 |
| [packages/backend/src/routes/provision.ts](https://github.com/proappstore-online/platform/blob/1f461fa07fbb2620747075b4729e699382508cef/packages/backend/src/routes/provision.ts) | 10 | 200, 201, 202, 413 |
| [packages/backend/src/routes/provisioning-plans.ts](https://github.com/proappstore-online/platform/blob/1f461fa07fbb2620747075b4729e699382508cef/packages/backend/src/routes/provisioning-plans.ts) | 3 | 124, 127, 128 |
| [packages/backend/src/routes/qa.ts](https://github.com/proappstore-online/platform/blob/1f461fa07fbb2620747075b4729e699382508cef/packages/backend/src/routes/qa.ts) | 4 | 22, 82, 380, 398 |
| [packages/backend/src/routes/reliability.ts](https://github.com/proappstore-online/platform/blob/1f461fa07fbb2620747075b4729e699382508cef/packages/backend/src/routes/reliability.ts) | 8 | 16, 38, 47, 64 |
| [packages/backend/src/routes/roles.ts](https://github.com/proappstore-online/platform/blob/1f461fa07fbb2620747075b4729e699382508cef/packages/backend/src/routes/roles.ts) | 4 | 3, 18, 59, 103 |
| [packages/backend/src/routes/scheduled-runs.ts](https://github.com/proappstore-online/platform/blob/1f461fa07fbb2620747075b4729e699382508cef/packages/backend/src/routes/scheduled-runs.ts) | 2 | 4, 23 |
| [packages/backend/src/routes/secrets-allowlist-crud.ts](https://github.com/proappstore-online/platform/blob/1f461fa07fbb2620747075b4729e699382508cef/packages/backend/src/routes/secrets-allowlist-crud.ts) | 4 | 5, 25, 51, 137 |
| [packages/backend/src/routes/secrets-crud.ts](https://github.com/proappstore-online/platform/blob/1f461fa07fbb2620747075b4729e699382508cef/packages/backend/src/routes/secrets-crud.ts) | 4 | 5, 20, 45, 97 |
| [packages/backend/src/routes/secrets.ts](https://github.com/proappstore-online/platform/blob/1f461fa07fbb2620747075b4729e699382508cef/packages/backend/src/routes/secrets.ts) | 2 | 3, 4 |
| [packages/backend/src/routes/services.ts](https://github.com/proappstore-online/platform/blob/1f461fa07fbb2620747075b4729e699382508cef/packages/backend/src/routes/services.ts) | 14 | 31, 47, 117, 119 |
| [packages/backend/src/routes/sms.ts](https://github.com/proappstore-online/platform/blob/1f461fa07fbb2620747075b4729e699382508cef/packages/backend/src/routes/sms.ts) | 3 | 64, 66, 67 |
| [packages/backend/src/routes/sourcemaps.ts](https://github.com/proappstore-online/platform/blob/1f461fa07fbb2620747075b4729e699382508cef/packages/backend/src/routes/sourcemaps.ts) | 2 | 17, 90 |
| [packages/backend/src/routes/storage.ts](https://github.com/proappstore-online/platform/blob/1f461fa07fbb2620747075b4729e699382508cef/packages/backend/src/routes/storage.ts) | 7 | 5, 119, 307, 310 |
| [packages/backend/src/routes/submissions-helpers.ts](https://github.com/proappstore-online/platform/blob/1f461fa07fbb2620747075b4729e699382508cef/packages/backend/src/routes/submissions-helpers.ts) | 1 | 16 |
| [packages/backend/src/routes/submissions-review.ts](https://github.com/proappstore-online/platform/blob/1f461fa07fbb2620747075b4729e699382508cef/packages/backend/src/routes/submissions-review.ts) | 2 | 98, 122 |
| [packages/backend/src/routes/submissions.ts](https://github.com/proappstore-online/platform/blob/1f461fa07fbb2620747075b4729e699382508cef/packages/backend/src/routes/submissions.ts) | 6 | 130, 162, 193, 218 |
| [packages/backend/src/routes/teams.ts](https://github.com/proappstore-online/platform/blob/1f461fa07fbb2620747075b4729e699382508cef/packages/backend/src/routes/teams.ts) | 9 | 3, 56, 74, 126 |
| [packages/backend/src/routes/telemetry-health.ts](https://github.com/proappstore-online/platform/blob/1f461fa07fbb2620747075b4729e699382508cef/packages/backend/src/routes/telemetry-health.ts) | 3 | 26, 107, 137 |
| [packages/backend/src/routes/tools.ts](https://github.com/proappstore-online/platform/blob/1f461fa07fbb2620747075b4729e699382508cef/packages/backend/src/routes/tools.ts) | 12 | 16, 391, 458, 506 |
| [packages/backend/src/routes/usage.ts](https://github.com/proappstore-online/platform/blob/1f461fa07fbb2620747075b4729e699382508cef/packages/backend/src/routes/usage.ts) | 3 | 3, 281, 417 |
| [packages/backend/src/routes/visibility.ts](https://github.com/proappstore-online/platform/blob/1f461fa07fbb2620747075b4729e699382508cef/packages/backend/src/routes/visibility.ts) | 3 | 3, 16, 17 |
| [packages/backend/src/routes/webhooks-config.ts](https://github.com/proappstore-online/platform/blob/1f461fa07fbb2620747075b4729e699382508cef/packages/backend/src/routes/webhooks-config.ts) | 5 | 3, 21, 33, 82 |
| [packages/backend/src/types.ts](https://github.com/proappstore-online/platform/blob/1f461fa07fbb2620747075b4729e699382508cef/packages/backend/src/types.ts) | 1 | 288 |

## Other services

84 matches across 21 files. Line numbers refer to the investigated commit.

| Source | Matches | Example lines |
|---|---:|---|
| [packages/admin/src/index.ts](https://github.com/proappstore-online/platform/blob/1f461fa07fbb2620747075b4729e699382508cef/packages/admin/src/index.ts) | 1 | 110 |
| [packages/admin/src/provision-guard.ts](https://github.com/proappstore-online/platform/blob/1f461fa07fbb2620747075b4729e699382508cef/packages/admin/src/provision-guard.ts) | 3 | 45, 58, 67 |
| [packages/agent-teams/src/agent-runner.ts](https://github.com/proappstore-online/platform/blob/1f461fa07fbb2620747075b4729e699382508cef/packages/agent-teams/src/agent-runner.ts) | 3 | 54, 55, 87 |
| [packages/agent-teams/src/architect-chat.ts](https://github.com/proappstore-online/platform/blob/1f461fa07fbb2620747075b4729e699382508cef/packages/agent-teams/src/architect-chat.ts) | 4 | 180, 181, 193, 195 |
| [packages/agent-teams/src/deploy-stage.ts](https://github.com/proappstore-online/platform/blob/1f461fa07fbb2620747075b4729e699382508cef/packages/agent-teams/src/deploy-stage.ts) | 6 | 124, 125, 288, 379 |
| [packages/agent-teams/src/index.ts](https://github.com/proappstore-online/platform/blob/1f461fa07fbb2620747075b4729e699382508cef/packages/agent-teams/src/index.ts) | 13 | 54, 55, 56, 154 |
| [packages/agent-teams/src/po-chat.ts](https://github.com/proappstore-online/platform/blob/1f461fa07fbb2620747075b4729e699382508cef/packages/agent-teams/src/po-chat.ts) | 3 | 176, 177, 179 |
| [packages/agent-teams/src/project-access.ts](https://github.com/proappstore-online/platform/blob/1f461fa07fbb2620747075b4729e699382508cef/packages/agent-teams/src/project-access.ts) | 9 | 11, 12, 16, 29 |
| [packages/agent-teams/src/project-reports.ts](https://github.com/proappstore-online/platform/blob/1f461fa07fbb2620747075b4729e699382508cef/packages/agent-teams/src/project-reports.ts) | 5 | 28, 29, 32, 82 |
| [packages/agent-teams/src/project-settings.ts](https://github.com/proappstore-online/platform/blob/1f461fa07fbb2620747075b4729e699382508cef/packages/agent-teams/src/project-settings.ts) | 5 | 23, 46, 47, 51 |
| [packages/agent-teams/src/project-test-host.ts](https://github.com/proappstore-online/platform/blob/1f461fa07fbb2620747075b4729e699382508cef/packages/agent-teams/src/project-test-host.ts) | 1 | 52 |
| [packages/agent-teams/src/qa-chat.ts](https://github.com/proappstore-online/platform/blob/1f461fa07fbb2620747075b4729e699382508cef/packages/agent-teams/src/qa-chat.ts) | 4 | 49, 50, 53, 74 |
| [packages/agent-teams/src/store.ts](https://github.com/proappstore-online/platform/blob/1f461fa07fbb2620747075b4729e699382508cef/packages/agent-teams/src/store.ts) | 1 | 12 |
| [packages/agent-teams/src/templates/organization.ts](https://github.com/proappstore-online/platform/blob/1f461fa07fbb2620747075b4729e699382508cef/packages/agent-teams/src/templates/organization.ts) | 4 | 24, 103, 111, 181 |
| [packages/agent-teams/src/templates/realtime.ts](https://github.com/proappstore-online/platform/blob/1f461fa07fbb2620747075b4729e699382508cef/packages/agent-teams/src/templates/realtime.ts) | 4 | 26, 115, 127, 203 |
| [packages/build-core/src/index.ts](https://github.com/proappstore-online/platform/blob/1f461fa07fbb2620747075b4729e699382508cef/packages/build-core/src/index.ts) | 1 | 3 |
| [packages/build-core/src/ownership.ts](https://github.com/proappstore-online/platform/blob/1f461fa07fbb2620747075b4729e699382508cef/packages/build-core/src/ownership.ts) | 4 | 10, 12, 28, 30 |
| [packages/build-core/src/provision-rate-limit.ts](https://github.com/proappstore-online/platform/blob/1f461fa07fbb2620747075b4729e699382508cef/packages/build-core/src/provision-rate-limit.ts) | 4 | 121, 135, 164, 180 |
| [packages/data-worker/src/index.ts](https://github.com/proappstore-online/platform/blob/1f461fa07fbb2620747075b4729e699382508cef/packages/data-worker/src/index.ts) | 3 | 136, 149, 151 |
| [packages/mcp/src/index.ts](https://github.com/proappstore-online/platform/blob/1f461fa07fbb2620747075b4729e699382508cef/packages/mcp/src/index.ts) | 3 | 268, 270, 275 |
| [packages/mcp/src/provisioning-workflow.ts](https://github.com/proappstore-online/platform/blob/1f461fa07fbb2620747075b4729e699382508cef/packages/mcp/src/provisioning-workflow.ts) | 3 | 25, 221, 228 |

## Important additional sources

These are not fully represented by owner-name searches:

- [Team schema](https://github.com/proappstore-online/platform/blob/1f461fa07fbb2620747075b4729e699382508cef/migrations/0025_team_members.sql) and [user schema](https://github.com/proappstore-online/platform/blob/1f461fa07fbb2620747075b4729e699382508cef/migrations/0021_users.sql).
- [Calendar publisher-change trigger](https://github.com/proappstore-online/platform/blob/1f461fa07fbb2620747075b4729e699382508cef/migrations/0123_google_calendar_connector.sql) and [grant enforcement](https://github.com/proappstore-online/platform/blob/1f461fa07fbb2620747075b4729e699382508cef/packages/backend/src/lib/google-calendar-data.ts).
- [Agent funding resolver](https://github.com/proappstore-online/platform/blob/1f461fa07fbb2620747075b4729e699382508cef/packages/agent-teams/src/byo-key.ts), [role gate](https://github.com/proappstore-online/platform/blob/1f461fa07fbb2620747075b4729e699382508cef/packages/agent-teams/src/role-gate.ts), and [personal key vault schema](https://github.com/proappstore-online/platform/blob/1f461fa07fbb2620747075b4729e699382508cef/migrations/0019_user_api_keys.sql).
- [Worker isolation runtime tests](https://github.com/proappstore-online/platform/blob/1f461fa07fbb2620747075b4729e699382508cef/packages/runtime-tests/test/backend/app-worker-isolation.test.ts), [worker lifecycle tests](https://github.com/proappstore-online/platform/blob/1f461fa07fbb2620747075b4729e699382508cef/packages/runtime-tests/test/backend/app-workers.test.ts), and [quota implementation](https://github.com/proappstore-online/platform/blob/1f461fa07fbb2620747075b4729e699382508cef/packages/backend/src/lib/app-worker-usage.ts).
- [OIDC deployment identity](https://github.com/proappstore-online/platform/blob/1f461fa07fbb2620747075b4729e699382508cef/packages/backend/src/lib/app-deploy-oidc.ts), [CI session grants](https://github.com/proappstore-online/platform/blob/1f461fa07fbb2620747075b4729e699382508cef/packages/backend/src/routes/oidc-session.ts), and [data-worker authorization](https://github.com/proappstore-online/platform/blob/1f461fa07fbb2620747075b4729e699382508cef/packages/data-worker/src/index.ts).
- [Archived payout behavior](https://github.com/proappstore-online/platform/blob/1f461fa07fbb2620747075b4729e699382508cef/packages/backend/src/routes/payouts-disabled.test.ts), [personal subscriptions](https://github.com/proappstore-online/platform/blob/1f461fa07fbb2620747075b4729e699382508cef/packages/backend/src/routes/subscription.ts), and [app billing ledger](https://github.com/proappstore-online/platform/blob/1f461fa07fbb2620747075b4729e699382508cef/packages/backend/src/lib/billing-ledger.ts).
- [ADR-009 runtime release gates](adr/009-app-workers.md), [ownership contract](app-ownership.md), and [app billing contract](app-billing.md).

## Cross repository scope

- Platform: API authority, migrations, workers, MCP, SDK, CLI, agent projects, build-core and runtime tests.
- Creator Console at `df1a9ef`: `App.tsx`, `Header.tsx`, `ProfileView.tsx`, `DirectoryView.tsx`, `directoryApi.ts`, `appsApi.ts`, `NewAppModal.tsx`, app detail/settings, runtime/connector panels and browser tests.
- Hiring at `938a644`: publisher migration plus integration acceptance; its brand membership, candidate data and Calendar grant association stay app-owned.
- GitHub repositories: reconcile explicitly PAS-managed collaborator access; do not infer GitHub authority from a Google email.
- PAGS: existing app-instance integration remains a provider boundary, not a second implementation of PAS team ownership.

## Verification and evidence limits

The focused baseline command selected team routes, ownership routes, archived payouts and agent role gates. Vitest reported **4 suites and 81 tests passed**. A requested build-core ownership test path has no matching test file in this snapshot and was not counted. The command output is kept locally at `/tmp/pas-team-design-tests.log`.

Live evidence from the preceding Hiring work established the intended Google owner and worker enablement refusal. No production-wide membership census, secret inventory, billing export or Cloudflare operational soak audit was performed. Runtime general-availability criteria therefore remain unproven by this investigation. Closed implementation issues are not treated as evidence of a live drill.

GitHub issue review found relevant prior work in #330 (non-GitHub existing members), #362 (atomic invite consumption), #378 (invite authority and related fixes), #423 (ownership), #251 (worker epic), #262 (duperdash consumer), #263 (legacy retirement), and #275 (quotas). This investigation did not file issues or send notifications.
