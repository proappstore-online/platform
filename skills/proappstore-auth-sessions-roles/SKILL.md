---
name: proappstore-auth-sessions-roles
description: Add or correct authentication, cookie sessions, roles and permissions in a ProAppStore app — platform-cookie sessions for hosted apps, sign-in / sign-out / session hydration through the SDK, app roles for in-app RBAC with manifest gates and SQL scoping, a gated permissions UI, and negative authorization tests. Detects and remediates localStorage token handling, app.auth.token coupling, home-grown sign-in or session tables, membership-only privileged gates, unsafe return URLs, incomplete sign-out and missing negative tests, citing the Application Standard's AUTH clauses. Use when a user asks how to sign users in, keep sessions, protect routes or actions, define roles or permissions, build a permissions screen, or review the auth of an app on proappstore.online. Not for creating, provisioning, deploying or fully auditing an app, and not for platform or team roles.
license: MIT
compatibility: Works with any Agent Skills client. Best with the ProAppStore MCP server (https://mcp.proappstore.online/mcp) to verify SDK surfaces and read an existing app's registered actions; otherwise uses the public docs only. Read-only advisory skill — no provisioning, no credentials, no secrets.
metadata:
  author: proappstore-online
  version: "1.0"
  mcp-endpoint: https://mcp.proappstore.online/mcp
  standard-version: "1.5"
  issue: proappstore-online/platform#173
  triggers: authentication, sessions, session, roles, permissions, sign-in, sign-out, sign users in, ProAppStore
allowed-tools: whoami sdk_reference recipe platform_guide app_info list_app_tools schema_status
---

# Secure authentication, cookie sessions, roles and permissions

You add or correct identity and authorization in a ProAppStore app so that it
conforms to the [AUTH chapter](https://docs.proappstore.online/standard/auth/)
of the Recommended Application Standard: the platform owns identity and the
session cookie, the SDK is the only auth surface, **app roles** plus manifest
gates plus SQL scoping are the authorization boundary, and the UI is only a
courtesy. You review and prescribe; you do not provision, deploy or audit
every chapter.

## When to use / when not to

- **Use** for "how do I sign users in / keep them signed in?", "how do I
  protect this route or action?", "how do I add roles / permissions / an admin
  screen?", and for reviewing an existing app's auth for the anti-patterns in
  [references/anti-patterns.md](references/anti-patterns.md).
- **Do not use** to create the app (`create-proappstore-app`), to choose the
  overall architecture (`choose-proappstore-architecture`), for a whole-
  standard audit, or for **platform** roles (creator/admin) and **team** roles
  (who may build the app) — those are the platform's, not the app's
  ([authorization model](https://docs.proappstore.online/authorization-model/)).

## Rules

1. **The platform is the identity provider and the session store.** Hosted
   apps initialise the SDK with platform-cookie auth mode
   ([PAS-AUTH-001](https://docs.proappstore.online/standard/auth/#pas-auth-001));
   the only session cookie is the host worker's, which page JavaScript cannot
   read ([PAS-AUTH-012](https://docs.proappstore.online/standard/auth/#pas-auth-012)).
   The app never stores, copies or parses a session, never reads
   `app.auth.token`, and never calls the auth endpoints itself
   ([PAS-AUTH-002](https://docs.proappstore.online/standard/auth/#pas-auth-002),
   [PAS-AUTH-003](https://docs.proappstore.online/standard/auth/#pas-auth-003)).
2. **Three role systems; only app roles gate app features.** Platform roles
   (creator, admin), team roles (owner, developer, viewer of the *build*) and
   app roles (`app.roles`, `auth.app_roles` in `mcp.json`) are different
   things. In-app permissions use app roles only
   ([PAS-AUTH-013](https://docs.proappstore.online/standard/auth/#pas-auth-013)),
   and `member` means "signed in", never a privilege
   ([PAS-AUTH-014](https://docs.proappstore.online/standard/auth/#pas-auth-014)).
3. **The server is the boundary; SQL scoping is the final check.** Every
   action defaults to `requires_auth: true`, declares the narrowest
   `app_roles`, and scopes rows to the caller in SQL. A UI guard, a hidden
   button or a client-side role check is UX, never the gate
   ([PAS-AUTH-016](https://docs.proappstore.online/standard/auth/#pas-auth-016),
   [PAS-DATA-007](https://docs.proappstore.online/standard/data/#pas-data-007)).
4. **Never fabricate APIs.** Name only surfaces that exist on `app.auth`,
   `app.roles`, `app.invites`, `app.actions`, `app.logs` and the SDK UI, and
   confirm methods with `sdk_reference` (feature `auth`, `hooks`, `ui`) or
   `recipe` before citing them. No method → say so; recommend the real one.
5. **Read-only and credential-free.** Agents running this skill
   never handle credentials: no tokens in prompts or files, no `.env`, no
   `wrangler`, no `gh repo create`, no secrets copied out of an app. Fixes are described as
   code changes for the user to apply in their repository.
6. **A person verifies the live app.** Sign-in, sign-out, recovery and a role
   change are checked by a human on every hostname
   ([PAS-AUTH-020](https://docs.proappstore.online/standard/auth/#pas-auth-020));
   never report those as passed yourself.

## Workflow

### 1. Establish the context

Ask for or read: hosted on the platform subdomain, a custom domain, or local
only; the sign-in paths wanted (GitHub, Google, email magic link, provisioned
username/password accounts); the capabilities that need a role; whether the
app is Tailored or Ready (multi-tenant). For an **existing** app: `app_info`
(hostnames, template provenance), `list_app_tools` (which registered actions
require auth), `schema_status` (migrations, to spot home-grown user/session
tables). If the client can read the repository, run the greps in
[references/anti-patterns.md](references/anti-patterns.md).

### 2. Decide each need with the decision tables

Walk [references/decision-tables.md](references/decision-tables.md): session
mode, sign-in paths, hydration, sign-out and recovery, role vocabulary,
manifest gates, SQL scoping, permissions UI, privileged operations, custom
domains, caches and the service worker. Record primitive, clause and the
rejected alternative for each.

### 3. Detect and remediate anti-patterns

For each hit in [references/anti-patterns.md](references/anti-patterns.md) —
storage-held sessions, `app.auth.token` coupling, home-grown sign-in or
session tables, membership-only gates, unsafe return URLs, incomplete
sign-out, missing negative tests — give the finding, the clause, the exact
remediation and the test that proves it. Unsupported asks (third-party
identity, self-registration, refresh tokens, own cookies) go to
[references/unsupported-requirements.md](references/unsupported-requirements.md)
with the interim pattern; never design around the standard.

### 4. Verify surfaces

`sdk_reference` (feature `auth`) for the sign-in, sign-out, hydration and
error surfaces; `sdk_reference` (feature `hooks` / `ui`) for the React gate
and shell; `recipe` (`roles-rbac`) for the role pattern. If the user names a
method the reference does not show, say it does not exist.

### 5. Produce the plan

Render [references/output-template.md](references/output-template.md): the
decision table with citations, the findings with remediation, the role
vocabulary and which action each role unlocks, the permissions UI outline,
the negative tests to add, and the human verification checklist for
PAS-AUTH-020. One screen; details in the tables.

### 6. Hand off

- Data actions and tenancy → the [DATA chapter](https://docs.proappstore.online/standard/data/).
- New app → `create-proappstore-app`; service choices → `choose-proappstore-architecture`.
- Custom domain sign-in → `pas domain add` / `pas domain verify` in the
  [CLI overview](https://docs.proappstore.online/cli-overview/), run by the user.

## Blockers — hand back, do not work around

| Class | Signal | What to say |
|---|---|---|
| **Unsupported requirement** | third-party identity, self-registration, password storage, refresh tokens, own cookies, SSO across apps | the interim pattern and the clause; the platform path |
| **Product decision** | the role vocabulary or who administers roles is undecided | ask; propose the platform roles as a starting set; do not invent |
| **Verification** | `sdk_reference` does not show the method the user wants | say it does not exist; recommend the closest real one |
| **Manual verification** | PAS-AUTH-020 checks on the live app | list the checklist for a person; never mark it passed |

## Reruns and failures

- **Rerun:** the review is idempotent — the same repository state produces
  the same findings and the same plan; nothing on the platform changes
  between runs. Rerun after each remediation to confirm the finding is gone.
- **Failure:** if `app_info`, `list_app_tools` or `schema_status` fails,
  report the gap, keep the findings that do not depend on it, and stop rather
  than infer the missing part.

## Worked examples

[references/worked-examples.md](references/worked-examples.md) covers a new
app's sign-in, each remediation, and a permissions screen;
[evals/cases.json](evals/cases.json) holds the machine-checked expectations
for the same scenarios.
