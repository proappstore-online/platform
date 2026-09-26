# Unsupported requirements — say so, give the interim pattern, cite the clause

A requirement here has **no platform primitive today** and, in most rows, is
forbidden by the standard rather than merely missing. Recommend the interim
pattern; never a substitute identity provider or an app-owned auth layer.

| Requirement | Status | Interim pattern that conforms | Cite |
|---|---|---|---|
| Third-party identity (Firebase Auth, Auth0, Clerk, Supabase Auth, NextAuth) or an own password store | forbidden | `app.auth.signIn('github')` / `app.auth.signIn('google')`, `signInWithEmail`, provisioned credential accounts | [PAS-STACK-006](https://docs.proappstore.online/standard/stack/#pas-stack-006), [PAS-AUTH-004](https://docs.proappstore.online/standard/auth/#pas-auth-004) |
| Self-registration with username and password | not offered | an adult or admin provisions the account with `app.auth.provisionChild`; the user signs in with `signInWithCredentials` | [PAS-AUTH-004](https://docs.proappstore.online/standard/auth/#pas-auth-004) |
| Refresh tokens, silent re-authentication, "remember me" beyond the cookie | not offered — the cookie already lasts 30 days | rely on the SDK's 401 handling; show a sign-in prompt when it signs the user out | [PAS-AUTH-006](https://docs.proappstore.online/standard/auth/#pas-auth-006) |
| An app-set auth cookie, or a cookie shared across `*.proappstore.online` | forbidden | the host worker's host-only session cookie; nothing to add | [PAS-AUTH-012](https://docs.proappstore.online/standard/auth/#pas-auth-012) |
| Single sign-on across several apps, or sharing a session between hostnames | not offered — a session is per host | each hostname signs in on its own; register custom domains so they behave identically | [PAS-AUTH-011](https://docs.proappstore.online/standard/auth/#pas-auth-011) |
| Reading the raw session or token to call another service | forbidden | third-party APIs through `app.proxy.fetch` with platform-held secrets | [PAS-AUTH-003](https://docs.proappstore.online/standard/auth/#pas-auth-003), [PAS-STACK-015](https://docs.proappstore.online/standard/stack/#pas-stack-015) |
| Gating app features on team or platform roles | forbidden | app roles via `app.roles` and `auth.app_roles` | [PAS-AUTH-013](https://docs.proappstore.online/standard/auth/#pas-auth-013) |
| Users choosing their own role, or assigning `owner` | forbidden | admin-granted roles and invites with an admin-chosen role; `owner` is platform-managed | [PAS-AUTH-017](https://docs.proappstore.online/standard/auth/#pas-auth-017), [PAS-AUTH-015](https://docs.proappstore.online/standard/auth/#pas-auth-015) |
| Hierarchical or attribute-based permissions (role inheritance, per-record ACLs) as a platform feature | not offered | model membership and per-record grants as tables, scoped in SQL; roles stay flat | [PAS-DATA-007](https://docs.proappstore.online/standard/data/#pas-data-007), [PAS-DATA-008](https://docs.proappstore.online/standard/data/#pas-data-008), [PAS-STACK-014](https://docs.proappstore.online/standard/stack/#pas-stack-014) |
| Server-side sessions or middleware in app code (Express-style guards) | not offered — apps ship static assets | the manifest gate and SQL scoping of registered actions are the server side | [PAS-DATA-014](https://docs.proappstore.online/standard/data/#pas-data-014), [PAS-AUTH-016](https://docs.proappstore.online/standard/auth/#pas-auth-016) |
| Multi-factor authentication configured by the app | not offered | the provider's own MFA (GitHub, Google) applies; nothing to add in the app | [PAS-AUTH-004](https://docs.proappstore.online/standard/auth/#pas-auth-004) |
| Automated proof that live sign-in works | not offered — PAS-AUTH-020 is a human check | a person runs the checklist on every hostname; the AI records manual-review | [PAS-AUTH-020](https://docs.proappstore.online/standard/auth/#pas-auth-020) |

When a gap is decisive for the product, say so and stop: it is a
**blocker: unsupported requirement**, not a reason to design around the
standard.
