# Worked examples

One per evaluation scenario, in the output template's shape.

## new-app-signin — a club roster app, first sign-in

Requirements: hosted on the subdomain; GitHub and Google sign-in; coaches
edit, parents view; show a spinner until the session is known.

| Need | Decision | Clause |
|---|---|---|
| session | `initPro({ appId: 'club-roster', authMode: 'platform-cookie' })` in `src/pas.ts` | [PAS-AUTH-001](https://docs.proappstore.online/standard/auth/#pas-auth-001), [PAS-STACK-003](https://docs.proappstore.online/standard/stack/#pas-stack-003) |
| sign-in | `SignInButton` / `app.auth.signIn('github')`, `app.auth.signIn('google')` | [PAS-AUTH-004](https://docs.proappstore.online/standard/auth/#pas-auth-004) |
| hydration | `ProShell` (calls `app.auth.init()`); nothing auth-dependent before it settles; surface `app.auth.authError` | [PAS-AUTH-005](https://docs.proappstore.online/standard/auth/#pas-auth-005) |
| sign-out | `ProfileMenu` → `app.auth.signOut()`; clear the roster cache in `app.auth.onChange` | [PAS-AUTH-007](https://docs.proappstore.online/standard/auth/#pas-auth-007) |
| roles | `coach` (edit), `member` (view own child) — README documents both | [PAS-AUTH-017](https://docs.proappstore.online/standard/auth/#pas-auth-017), [PAS-AUTH-015](https://docs.proappstore.online/standard/auth/#pas-auth-015) |

Unsupported: none. Recipe: `roles-rbac`. Human check: both providers, sign-out,
recover route, grant `coach` to a second account.

## localstorage-token — session copied to storage

Finding: `src/lib/session.ts` writes `app.auth.token` to `localStorage` under
`token` and restores it on load. Clause:
[PAS-AUTH-002](https://docs.proappstore.online/standard/auth/#pas-auth-002),
[PAS-AUTH-003](https://docs.proappstore.online/standard/auth/#pas-auth-003). Remediation: delete the file,
set `authMode: 'platform-cookie'`, call `app.auth.init()` once; the host
worker's cookie is the session. Prove: no identity in storage after sign-in;
nothing after sign-out. Unsupported: none.

## auth-token-coupling — hand-built API calls

Finding: `src/api.ts` sends `Authorization: Bearer ${app.auth.token}` to
`api.proappstore.online/v1/kv/...`. In platform-cookie mode the token is
absent, so every call fails; it also skips the CSRF-checked path. Clause:
[PAS-AUTH-003](https://docs.proappstore.online/standard/auth/#pas-auth-003),
[PAS-AUTH-009](https://docs.proappstore.online/standard/auth/#pas-auth-009). Remediation: replace with
`app.kv.get` / `app.kv.set`; app data through `app.actions.call`. Prove: no
`Authorization` header in app code; mutations succeed. Unsupported: none.

## home-grown-sessions — a `users` table with password hashes

Finding: `migrations.json` creates `users(email, password_hash)` and
`sessions(token, expires_at)`; a `/register` screen exists. Clause:
[PAS-AUTH-004](https://docs.proappstore.online/standard/auth/#pas-auth-004),
[PAS-STACK-006](https://docs.proappstore.online/standard/stack/#pas-stack-006). Remediation: sign in with
`app.auth.signInWithEmail(email)` for email users and
`app.auth.provisionChild` + `app.auth.signInWithCredentials` for accounts
without email; keep a `profiles(user_id, display_name)` table keyed by
`:__user_id`; add an additive migration that stops using the credential
columns ([PAS-DATA-002](https://docs.proappstore.online/standard/data/#pas-data-002)); delete the
registration and reset screens. Prove: no password material in the schema.
Unsupported: self-registration with a password (interim: provisioned
accounts).

## membership-gate — "any role" unlocks the admin panel

Finding: `AdminPanel` renders when `(await app.roles.myRoles()).length > 0`,
and `delete_post` declares `requires_auth: true` with no `app_roles` and
`WHERE id = :id`. Every user is `member`, so everyone is an admin and can
delete any post. Clause:
[PAS-AUTH-014](https://docs.proappstore.online/standard/auth/#pas-auth-014),
[PAS-AUTH-016](https://docs.proappstore.online/standard/auth/#pas-auth-016),
[PAS-DATA-007](https://docs.proappstore.online/standard/data/#pas-data-007). Remediation: define
`moderator`; UI `app.roles.check('moderator')`; manifest
`auth.app_roles: ["moderator"]`; SQL `WHERE id = :id AND club_id IN (SELECT club_id FROM club_members WHERE user_id = :__user_id)`.
Prove: a `member`-only account gets 403; a moderator of another club changes
nothing. Unsupported: none.

## unsafe-redirect — return target from the query string

Finding: `signIn()` is called with `returnTo: params.get('next')`, unvalidated,
and the page appends `?user=` + email after sign-in. Clause:
[PAS-AUTH-010](https://docs.proappstore.online/standard/auth/#pas-auth-010). Remediation: call
`app.auth.signIn(provider)` and let the SDK compute the return from the
current location; if a target is needed, accept only a same-origin path
(`startsWith('/')`, not `//`); never put user data in the URL. Prove: a deep
link returns to its path; an external origin is ignored. Unsupported: none.

## incomplete-signout — storage wiped, cookie alive

Finding: "Sign out" calls `localStorage.clear()` and navigates to `/`, never
`app.auth.signOut()`; the roster store keeps its rows; the installed PWA has
no recovery link. Clause:
[PAS-AUTH-007](https://docs.proappstore.online/standard/auth/#pas-auth-007),
[PAS-DATA-020](https://docs.proappstore.online/standard/data/#pas-data-020). Remediation:
`app.auth.signOut()` (or `ProfileMenu`), reset the store in
`app.auth.onChange(null)`, keep a sign-out control in every authenticated
state, link `/.pas/auth/recover` in the installed app. Prove: `/.pas/auth/me`
answers 401 after sign-out; no rows remain in memory. Unsupported: none.

## missing-negative-tests — happy path only

Finding: `src/actions.test.ts` calls `list_posts` as the author and asserts
rows; nothing calls it as a second user, and `delete_post` has no test as
`member`. Clause: [PAS-DATA-022](https://docs.proappstore.online/standard/data/#pas-data-022),
[PAS-AUTH-016](https://docs.proappstore.online/standard/auth/#pas-auth-016). Remediation: for each scoped
action add user-B-against-A's-ids tests asserting no rows and no change, a
`member`-only 403 test per `app_roles` gate, and run them in CI so a removed
predicate fails the build. Prove: CI fails when the scoping predicate is
removed. Unsupported: none.

## permissions-ui — a roles screen for club admins

Requirements: a club admin grants and revokes `coach`, invites new coaches,
sees who granted what and when.

| Need | Decision | Clause |
|---|---|---|
| reachability | route renders nothing privileged until `app.roles.check('admin')` resolves true; a failed check is an error state with retry and sign-out | [PAS-AUTH-018](https://docs.proappstore.online/standard/auth/#pas-auth-018), [PAS-AUTH-008](https://docs.proappstore.online/standard/auth/#pas-auth-008) |
| listing and changes | `app.roles.listAll()`; `app.roles.assign(userId, 'coach')` / `app.roles.revoke(userId, 'coach')` behind a confirmation | [PAS-AUTH-018](https://docs.proappstore.online/standard/auth/#pas-auth-018) |
| onboarding | `app.invites.create({ role: 'coach' })`, `app.invites.list()`, `app.invites.revoke(id)`; the invitee calls `app.invites.redeem(code)` | [PAS-AUTH-015](https://docs.proappstore.online/standard/auth/#pas-auth-015) |
| audit | `app.logs.info` on each change (or an audit row in the same batch as the app-side effect) | [PAS-AUTH-019](https://docs.proappstore.online/standard/auth/#pas-auth-019) |
| the boundary | the screen is UX; every club action it unlocks is gated by `app_roles` and scoped in SQL | [PAS-AUTH-016](https://docs.proappstore.online/standard/auth/#pas-auth-016) |

Unsupported: role inheritance (interim: flat roles + membership tables).
Recipe: `roles-rbac`. Human check: grant and revoke change what a second
account can do.
