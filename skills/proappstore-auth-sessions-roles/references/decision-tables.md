# Decision tables

Each row: the need, what to use, the clause that governs it, the docs page,
and what not to use. Every surface named here exists on the SDK or the
platform today; verify methods with `sdk_reference` before quoting them.

## Sessions

| Need | Use | Clause | Docs | Do not use |
|---|---|---|---|---|
| Sign-in on the platform subdomain or a custom domain | one `initPro({ appId, authMode: 'platform-cookie' })` in a shared module | [PAS-AUTH-001](https://docs.proappstore.online/standard/auth/#pas-auth-001), [PAS-STACK-003](https://docs.proappstore.online/standard/stack/#pas-stack-003) | [auth session model](https://docs.proappstore.online/auth-session-model/) | `legacy-bearer` on a hosted app; a second `initPro` |
| Where the session lives | the host worker's `__Host-pas_session` cookie (HttpOnly, Secure, SameSite=Lax, host-only, 30 days); the SDK persists nothing the app reads | [PAS-AUTH-012](https://docs.proappstore.online/standard/auth/#pas-auth-012), [PAS-AUTH-002](https://docs.proappstore.online/standard/auth/#pas-auth-002) | [auth session model](https://docs.proappstore.online/auth-session-model/) | `localStorage`, `sessionStorage`, IndexedDB, own cookies, `Domain=.proappstore.online` |
| Making authenticated calls | the SDK (`app.actions.call`, `app.kv`, …) — same-origin `/.pas/*` mediation with CSRF checks | [PAS-AUTH-009](https://docs.proappstore.online/standard/auth/#pas-auth-009), [PAS-AUTH-003](https://docs.proappstore.online/standard/auth/#pas-auth-003) | [app actions security](https://docs.proappstore.online/app-actions-security/) | `app.auth.token` in a header; `fetch('/v1/auth/…')`; credentialed CORS |
| Knowing when the session is ready | `app.auth.init()` once (or `useProAuth` / `ProShell`), render nothing auth-dependent until it settles; show `app.auth.authError` after a failed callback | [PAS-AUTH-005](https://docs.proappstore.online/standard/auth/#pas-auth-005) | [SDK overview](https://docs.proappstore.online/sdk-overview/) | redirecting to sign-in before hydration |
| Expiry, 401s | the SDK's sign-out on an API-plane 401 is authoritative; a data-plane 401 is a data error | [PAS-AUTH-006](https://docs.proappstore.online/standard/auth/#pas-auth-006) | — | refresh tokens, silent re-auth, retry with cached credentials |
| Sign-out | `app.auth.signOut()` (or `ProfileMenu`), clear in-memory and cached user data, visible sign-out in every authenticated state; installed PWAs link `/.pas/auth/recover` | [PAS-AUTH-007](https://docs.proappstore.online/standard/auth/#pas-auth-007), [PAS-DATA-020](https://docs.proappstore.online/standard/data/#pas-data-020) | [UI components](https://docs.proappstore.online/ui/) | clearing storage yourself and calling it sign-out |
| Returning after sign-in | let the SDK compute the return path, or pass a same-origin path only | [PAS-AUTH-010](https://docs.proappstore.online/standard/auth/#pas-auth-010) | — | another origin; tokens, codes or user data in the URL |
| Custom domains | `pas domain add` + `pas domain verify`; the same `initPro` and `/.pas/*` paths on every hostname | [PAS-AUTH-011](https://docs.proappstore.online/standard/auth/#pas-auth-011) | [CLI overview](https://docs.proappstore.online/cli-overview/) | hostname special-casing; copying a session between hosts |
| Offline shell | the template's service worker precaches the shell only, never `/.pas/*` or scoped data | [PAS-UI-018](https://docs.proappstore.online/standard/ui/#pas-ui-018) | [UI chapter](https://docs.proappstore.online/standard/ui/) | runtime caching of authenticated responses |

## Sign-in paths

| Need | Use | Clause | Docs | Do not use |
|---|---|---|---|---|
| Social sign-in | `app.auth.signIn('github')` / `app.auth.signIn('google')`, or `SignInButton` | [PAS-AUTH-004](https://docs.proappstore.online/standard/auth/#pas-auth-004), [PAS-STACK-006](https://docs.proappstore.online/standard/stack/#pas-stack-006) | [SDK overview](https://docs.proappstore.online/sdk-overview/) | Firebase Auth, Auth0, Clerk, Supabase Auth, NextAuth |
| Email without a provider | `app.auth.signInWithEmail(email)` (magic link) | [PAS-AUTH-004](https://docs.proappstore.online/standard/auth/#pas-auth-004) | — | own OTP or password flow |
| Users without email (children, staff accounts) | `app.auth.provisionChild(...)` by a signed-in adult / admin, then `app.auth.signInWithCredentials(login, password)`; `app.auth.resetPassword(userId)` and `app.auth.changePassword(current, next)` | [PAS-AUTH-004](https://docs.proappstore.online/standard/auth/#pas-auth-004) | — | a password column; a registration form |
| Reacting to sign-in state | `app.auth.onChange(listener)`, `app.auth.user`, `app.auth.isSignedIn`; `useProAuth()` in React | [PAS-AUTH-005](https://docs.proappstore.online/standard/auth/#pas-auth-005) | [recipes](https://docs.proappstore.online/recipes/) | polling storage |

## Roles and permissions

| Need | Use | Clause | Docs | Do not use |
|---|---|---|---|---|
| Which role system | **app roles** for what the app's users may do; team roles are for who builds the app; platform roles for the platform | [PAS-AUTH-013](https://docs.proappstore.online/standard/auth/#pas-auth-013) | [authorization model](https://docs.proappstore.online/authorization-model/) | team or platform roles as app permissions |
| Role vocabulary | the platform's `member`, `moderator`, `editor`, `viewer` plus explicit lowercase custom names, documented in the README | [PAS-AUTH-017](https://docs.proappstore.online/standard/auth/#pas-auth-017) | [recipe roles-rbac](https://docs.proappstore.online/recipes/) | `owner` (platform-managed); a role the user picks |
| Default for a new user | nothing beyond the automatic `member`; privileged roles granted by an admin or an admin-chosen invite | [PAS-AUTH-015](https://docs.proappstore.online/standard/auth/#pas-auth-015) | — | granting on first sign-in |
| Gating an action | `auth.requires_auth: true` + `auth.app_roles: ["editor"]` in `mcp.json` **and** `WHERE … = :__user_id` / membership sub-query | [PAS-AUTH-016](https://docs.proappstore.online/standard/auth/#pas-auth-016), [PAS-STACK-014](https://docs.proappstore.online/standard/stack/#pas-stack-014), [PAS-DATA-007](https://docs.proappstore.online/standard/data/#pas-data-007) | [app actions security](https://docs.proappstore.online/app-actions-security/) | `app_roles` alone; a `role` column the client sets |
| Checking a role in the UI | `app.roles.check('editor')` / `app.roles.myRoles()` to show or hide — UX only | [PAS-AUTH-014](https://docs.proappstore.online/standard/auth/#pas-auth-014) | [recipe roles-rbac](https://docs.proappstore.online/recipes/) | "has any role"; `member`; appearing in the list |
| Loading the caller's role or profile fails | a distinct error state with retry and sign-out | [PAS-AUTH-008](https://docs.proappstore.online/standard/auth/#pas-auth-008) | — | "no role" / onboarding; default-allow |
| Onboarding into a role | `app.invites.create({ role })`, `app.invites.redeem(code)`, `app.invites.list()`, `app.invites.revoke(id)` | [PAS-AUTH-015](https://docs.proappstore.online/standard/auth/#pas-auth-015), [PAS-DATA-008](https://docs.proappstore.online/standard/data/#pas-data-008) | — | join codes the client copies into a role parameter |
| Administering roles | an in-app screen on `app.roles.listAll()` / `assign` / `revoke` and `app.invites`, reachable only with the app's admin role; or the creator console's Roles manager | [PAS-AUTH-018](https://docs.proappstore.online/standard/auth/#pas-auth-018) | [recipe roles-rbac](https://docs.proappstore.online/recipes/) | a route that is only hidden |
| Privileged operations (bulk, destructive, cross-user) | a registered action gated by `app_roles`, scoped in SQL, confirmed in the UI, logged with `app.logs` or an audit row in the same batch | [PAS-AUTH-019](https://docs.proappstore.online/standard/auth/#pas-auth-019), [PAS-DATA-009](https://docs.proappstore.online/standard/data/#pas-data-009) | [app actions security](https://docs.proappstore.online/app-actions-security/) | `caller_unscoped` for anything that returns rows |
| Proving it | cross-tenant negative tests per scoped action, run in CI; a person verifies sign-in, sign-out, recovery and a role change on every hostname | [PAS-DATA-022](https://docs.proappstore.online/standard/data/#pas-data-022), [PAS-AUTH-020](https://docs.proappstore.online/standard/auth/#pas-auth-020) | — | marking PAS-AUTH-020 passed from an AI run |

## Subscription gates are not permissions

`useProGate` / `GateScreen` / `ProShell` decide *signed-out* vs *no
subscription* vs *ready* — the platform subscription, not a role
([PAS-STACK-020](https://docs.proappstore.online/standard/stack/#pas-stack-020)). Do not use them as the
authorization boundary either; the action's manifest and SQL are.
