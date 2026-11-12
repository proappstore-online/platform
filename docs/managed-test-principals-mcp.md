---
description: "Operate managed test principals and scoped GitHub OIDC grants through shared PAS MCP."
---

# Managed test principals through PAS MCP

Use the authenticated shared `/mcp` connection, never a raw REST call or a token in
tool arguments. Start with `whoami` and verify the intended configured platform-admin
identity. These tools forward its session in `Authorization: Bearer` and the trusted
worker credential in `X-Internal-Token` through the API service binding. The backend
permits a normal admin session, or the narrow combination of configured immutable
admin identity and trusted MCP worker; MCP sessions are never promoted to admin.
An ordinary user's backend requests remain forbidden even with the trusted worker.
Missing connector tools are a separate connection/catalogue problem, not a reason
to broaden GitHub permissions.

## Discovery and lifecycle

`tools/list` publishes validated schemas and field descriptions. Principal ids have
the form `tp_<uuid>`; grant ids are UUIDs. All mutations accept an audit `reason`
(maximum 240 characters), preview unless `confirm: true`, and support `dry_run: true`
even in read-only mode. Dry-run always overrides confirmation. Do not include secrets
in reasons, descriptions, labels, or other metadata. Responses contain no credentials.

| Tool | Inputs and result |
| --- | --- |
| `list_test_principals` | Optional `status` (`active`/`disabled`), `limit`, `cursor`; returns principals and `next_cursor`. |
| `read_test_principal` | `principal_id`; returns the principal and latest 100 grants. |
| `create_test_principal` | `slug`, optional `description`; creates a dedicated `test:<slug>` user with no interactive sign-in. Slug matches `^[a-z0-9][a-z0-9-]{2,39}$`. |
| `update_test_principal` | `principal_id`, required `description` (string of at most 240 characters or null); identity and status cannot be edited. |
| `disable_test_principal` | `principal_id`; disables minting and revokes all its live grants. |
| `enable_test_principal` | `principal_id`; restores the principal only, never revoked grants. |
| `list_principal_grants` | `principal_id`, optional `limit`, `cursor`; includes revoked grants and mint counters. |
| `read_oidc_session_grant` | `grant_id`; reads a principal-backed or legacy grant. |
| `preview_principal_grant` | Validates the grant fields below and returns the exact normalized request locally, without calling the backend. |
| `create_principal_grant` | Same grant fields plus confirmation/dry-run; applies through the backend. |
| `revoke_principal_grant` | `grant_id`; durable revocation with optional reason. |
| `list_test_principal_events` | Optional `principal_id`, `grant_id`, `limit`, `cursor`; durable lifecycle/grant audit events. |

List pages default to 50, maximum 100. Pass each `next_cursor` back unchanged until
null; use the grant listing to retrieve more than the principal detail's 100 grants.
Revocation/disable stops future exchanges; already minted sessions last until expiry.
The existing `list_oidc_session_grants`, `create_oidc_session_grant`, and
`revoke_oidc_session_grant` retain their legacy user-backed behavior.

Local previews authenticate the connection but do not establish admin authorization,
principal existence, active state, or effective app permissions. Only a successful
backend application establishes authorization. A preview is never provisioning evidence.
The backend records applied mutations with actor, request id, timestamp, reason and
safe before/after metadata; MCP separately audits previews/invocations with redaction.

## Scoped grant example

Replace the example principal id with the id returned by an approved create/read.
Generate a future expiry in **epoch milliseconds** (not an ISO string). This example
uses the first hour of 2030 only to illustrate the format; choose an explicitly
approved short grant lifetime for a real run.

```json
{
  "principal_id": "tp_64db75a4-f90c-433b-a7c4-95d86c3d0180",
  "repository": "proappstore-online/leads",
  "workflow": ".github/workflows/deploy.yml",
  "ref": "refs/heads/main",
  "expires_at": 1893459600000,
  "session_ttl_seconds": 600,
  "scope": "user",
  "label": "Leads isolated authenticated E2E",
  "reason": "Approved Leads E2E window"
}
```

Call `preview_principal_grant` with these fields first, then, only after scoped
approval, call `create_principal_grant` with the same fields and `confirm: true`.
Workflow and future expiry are mandatory. Ref defaults to `refs/heads/main`, TTL to
3600 seconds, and scope to `user`. TTL is an integer from 60 to 14400. Scope is only
`user` or explicitly authorized `creator`, never `admin`. Optional `environment`
matches the workflow's exact GitHub environment claim, 1..60 characters from
`[A-Za-z0-9._-]`; omit it if the workflow has none. The wrapper never substitutes
a human account, static token or creator role. Legacy accounts require their
separate legacy tool and an explicit `gh:`/`google:` target.

## Leads operational sequence and approval boundary

The inspected local Leads checkout uses repository `proappstore-online/leads`,
workflow `.github/workflows/deploy.yml`, ref `refs/heads/main`, audience
`https://api.proappstore.online`, with `id-token: write`. Recheck the exact workflow
at the candidate revision before approving a grant; a local checkout is not live
production evidence. No GitHub environment was declared in that inspected workflow.

1. Inspect principals, grants and audit events through the read tools. The #432
   delivery report did not observe the production `e2e-tester` row or a real managed
   mint. Do not assume either exists. If no suitable isolated identity exists, present
   `slug: leads-e2e`, its description, the resulting `test:leads-e2e` identity, the
   exact repo/workflow/ref above, requested expiry, TTL, scope `user`, and any environment
   restriction for explicit scoped approval. Record the actual principal id afterward.
2. This issue authorizes code/schema work only. Do not create production principals
   or grants, alter app permissions/authentication, obtain secrets, or trigger live
   provisioning under that authorization. Preview and present the exact proposed
   changes; apply only when the owner explicitly approves that operational scope.
3. Keep the test identity outside real customer projects, subscriptions and operator
   roles. Leads data is caller/project scoped; a fresh identity must use isolated test
   fixtures. A grant's `scope: user` is a platform role cap, **not** an app-resource
   allowlist. Confirm unrelated data, billing and administration operations are denied
   by the existing app/platform policies. If E2E needs new membership or permissions,
   request separate explicit approval; never silently widen to creator/admin.
4. After approved provisioning, run real authenticated E2E from that exact workflow
   and ref using GitHub OIDC exchange. Its inspected sign-in step currently falls back
   to `PAS_E2E_SESSION_TOKEN` and warns/skips when unauthenticated. Neither fallback nor
   a skipped suite verifies managed OIDC. Leads workflow changes belong to its own
   repo/issue (#34); require successful managed exchange and fail on missing auth.
5. Retain the run URL/SHA and evidence of the executed signed-in assertions, test
   pass/fail/skip counts, principal id, grant id, `via: oidc-test-principal`, expected
   user-only role and short expiry. Verify negative checks for unrelated data, billing
   and administration. Never log or publish the session/OIDC tokens. Read the grant
   to confirm mint count/last-minted time; read audit events for the provisioning trail.
6. Revoke the grant and/or disable the principal after the approved window. Confirm
   future exchanges fail, while respecting the TTL of any existing session.

Live production provisioning and minting have not been performed as part of #577.
Connector restoration and Leads workflow remediation remain separate operational work.

## Verification note for #577

Before edits on baseline `e283daeb`, the MCP suite passed 487 tests and MCP typecheck
passed. Knip failed loading unchanged `packages/runtime-tests/vitest.backend.ts` with
`Cannot read properties of undefined (reading 'resolve')` on Windows/Node 24.12.0.
The owner explicitly authorized continuing past this pre-existing unrelated failure;
it is not suppressed or represented as a passing check. Full supported release
verification remains Node 22/POSIX as described in [Windows verification](./windows-verification.md).
